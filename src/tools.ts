// The read-only tools a model uses to inspect the pull request.
//
// The checkout is contributor content, so every path is resolved and checked
// to stay inside it. There is no tool that writes, runs code or reads the
// environment: a symlink to /proc/self/environ must not reach the model.
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// What one file may cost to load. Reads are bounded per call (MAX_READ_LINES, MAX_READ_BYTES) and per reader
// (MAX_TOTAL_OUTPUT_BYTES), so this needn't keep a large source file from being read a piece at a time.
const MAX_FILE_BYTES = 16_000_000;
const MAX_SKIPPED_NAMED = 20;
const MAX_READ_BYTES = 48_000;
const MAX_READ_LINES = 400;
const MAX_LIST_FILES = 2_000;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_RESULTS = 60;
const MAX_TOTAL_OUTPUT_BYTES = 3_000_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function tool(name: string, description: string, properties: Record<string, unknown>): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", additionalProperties: false, required: Object.keys(properties), properties },
    },
  };
}

const startLine = { type: "integer", minimum: 1, description: "First line to return, counting from 1." };
const lineCount = { type: "integer", minimum: 1, maximum: MAX_READ_LINES, description: `How many lines to return, at most ${MAX_READ_LINES}.` };

/** A pull request's own text, which is no file in the checkout. */
export interface ChangeTexts {
  description: string;
  commitMessages: string;
}

/** Each change text by the name read_change_text takes, with the name a finding cites it by. */
const CHANGE_TEXTS: Record<string, { text: keyof ChangeTexts; path: string }> = {
  description: { text: "description", path: "change-text.md" },
  "commit-messages": { text: "commitMessages", path: "commit-messages.txt" },
};

/**
 * The tool that reads the pull request's description and commit messages. It is a tool of its own, not a path, so it
 * can't hide a file of the repository that has a text's name.
 */
export const changeTextTool: ToolDefinition = tool("read_change_text", "Read a numbered slice of the pull request's description or its commit messages, which are not files in the repository.", {
  which: { type: "string", enum: Object.keys(CHANGE_TEXTS), description: "description, or commit-messages." },
  start_line: startLine,
  line_count: lineCount,
});

export const readTools: ToolDefinition[] = [
  tool("read_diff", "Read a numbered slice of the pull request diff.", { start_line: startLine, line_count: lineCount }),
  tool("read_file", "Read a numbered slice of a text file as it is after the change. Line numbers match the ones findings must cite.", {
    path: { type: "string", description: "Path relative to the repository root." },
    start_line: startLine,
    line_count: lineCount,
  }),
  tool("read_base_file", "Read a numbered slice of a text file as it was before the change.", {
    path: { type: "string", description: "Path relative to the repository root." },
    start_line: startLine,
    line_count: lineCount,
  }),
  tool("list_files", "List the files under a directory, as paths relative to the repository root.", {
    path: { type: "string", description: "A relative directory path, or an empty string for the repository root." },
  }),
  tool("search", "Find a literal string in the repository's text files. Returns matching lines with their paths and line numbers.", {
    query: { type: "string", description: "The exact text to find. Not a regular expression." },
    path: { type: "string", description: "A relative file or directory to search in, or an empty string for the whole repository." },
    ignore_case: { type: "boolean" },
  }),
];

/**
 * A numbered slice of a text, cut to MAX_READ_BYTES characters, and the lines it returned whole: a line the cut ends
 * inside was returned only in part, and a reader paging on from the next line never sees its rest, so it isn't counted
 * as read.
 */
function numberedSlice(text: string, start: unknown, count: unknown): { content: string; total_lines: number; returned: [number, number] | null } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = Math.max(1, Math.floor(Number(start)) || 1);
  const size = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(Number(count)) || MAX_READ_LINES));
  const joined = lines.slice(first - 1, first - 1 + size).map((line, index) => `${first + index}: ${line}`).join("\n");
  const content = joined.slice(0, MAX_READ_BYTES);
  // Every line given carries its "N: " prefix, so the character after a cut that falls at a line's end is the newline.
  const whole = !joined ? 0 : content.split("\n").length - (content.length < joined.length && joined[content.length] !== "\n" ? 1 : 0);
  return { content, total_lines: lines.length, returned: whole > 0 ? [first, first + whole - 1] : null };
}

/**
 * One thing a model looked at. Lines are the ones a read returned whole: file lines for read_file (at head) and
 * read_base_file (at base), diff lines for read_diff, and the text's own lines for read_change_text, whose path is the
 * name the text is cited by. Paths and numbers only, never content.
 */
export interface ReadRecord {
  tool: string;
  path?: string;
  lines?: [number, number];
  query?: string;
  hits?: Array<{ path: string; line: number }>;
}

export function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || isAbsolute(value)) throw new Error("path must be relative");
  const normalized = value.replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (normalized.split("/").includes("..")) throw new Error("parent path segments are not allowed");
  return normalized;
}

const SAFE_ERRORS = [
  "path must be relative",
  "parent path segments are not allowed",
  "path escapes the checkout",
  "path is not a regular file",
  "binary files cannot be read",
  "file is too large to read",
  "query is invalid",
  "tool output budget is exhausted",
  "file does not exist at the base revision",
  "which is description or commit-messages",
];

/** Errors go back to the model, so only known messages pass through; anything else could leak host details. */
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return SAFE_ERRORS.includes(message) ? message : "path does not exist or cannot be read";
}

export class Workspace {
  readonly repoDir: string;
  readonly diffPath: string;
  readonly base: string;
  /** Files this workspace's model has read, at head or at base. */
  readonly opened = new Set<string>();
  /** Everything this workspace's model read, in order, so a run can show what context the review had. */
  readonly reads: ReadRecord[] = [];
  private outputBytes = 0;
  private root: string | null = null;

  /** The pull request's description and commit messages, which read_change_text serves; none for a workspace without that tool. */
  private readonly texts: ChangeTexts | null;

  constructor(repoDir: string, diffPath: string, base: string, texts: ChangeTexts | null = null) {
    this.repoDir = repoDir;
    this.diffPath = diffPath;
    this.base = base;
    // Served as they are numbered where they're cited: their own lines, with blank lines at the end left off.
    this.texts = texts && { description: texts.description.trimEnd(), commitMessages: texts.commitMessages.trimEnd() };
  }

  private async canonicalRoot(): Promise<string> {
    this.root ??= await realpath(this.repoDir);
    return this.root;
  }

  /** Resolves a model-supplied path to a real path inside the checkout, or throws. */
  async contained(requested: unknown): Promise<string> {
    const root = await this.canonicalRoot();
    const path = await realpath(resolve(root, safeRelativePath(requested)));
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("path escapes the checkout");
    return path;
  }

  private async textFile(path: string): Promise<string> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("path is not a regular file");
    if (info.size > MAX_FILE_BYTES) throw new Error("file is too large to read");
    const text = await readFile(path, "utf8");
    if (text.includes("\0")) throw new Error("binary files cannot be read");
    return text;
  }

  /** The text of a file at head, or null when it is missing, binary, too large or outside the checkout. */
  async headFile(path: string): Promise<string | null> {
    try {
      return await this.textFile(await this.contained(path));
    } catch {
      return null;
    }
  }

  /**
   * The text of a file at the base revision, or null when it did not exist there or can't be read (binary, or a blob
   * this clone doesn't hold). Throws for one too large to load.
   */
  async baseFile(path: string): Promise<string | null> {
    const safe = safeRelativePath(path);
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-c", "safe.directory=*", "-C", this.repoDir, "show", `${this.base}:${safe}`],
        { maxBuffer: MAX_FILE_BYTES, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } },
      );
      return stdout.includes("\0") ? null : stdout;
    } catch (error) {
      // Too large to load is not missing, and a reader told it was would look for it elsewhere.
      if ((error as NodeJS.ErrnoException)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("file is too large to read");
      return null;
    }
  }

  async diff(): Promise<string> {
    return readFile(this.diffPath, "utf8");
  }

  private async walk(start: string, limit: number): Promise<string[]> {
    const root = await this.canonicalRoot();
    const files: string[] = [];
    const visit = async (path: string): Promise<void> => {
      if (files.length >= limit) return;
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
        return;
      }
      if (!info.isDirectory()) return;
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(join(path, entry.name));
        if (files.length >= limit) return;
      }
    };
    await visit(start);
    return files;
  }

  /** Every regular file in the checkout, up to a limit, as paths relative to the root. */
  async allFiles(limit: number): Promise<string[]> {
    return this.walk(await this.canonicalRoot(), limit);
  }

  private record(entry: ReadRecord, slice: { returned: [number, number] | null }): void {
    this.reads.push(slice.returned ? { ...entry, lines: slice.returned } : entry);
  }

  /** A numbered slice as the model is given it: the lines and the text's length, not what the record keeps. */
  private shown(slice: { content: string; total_lines: number }): { ok: true; content: string; total_lines: number } {
    return { ok: true, content: slice.content, total_lines: slice.total_lines };
  }

  private async search(query: unknown, path: unknown, ignoreCase: unknown): Promise<{ ok: true; results: Array<{ path: string; line: number; text: string }>; truncated: boolean; tooLarge?: string[]; tooLargeMore?: number }> {
    if (typeof query !== "string" || !query || query.length > 500) throw new Error("query is invalid");
    const root = await this.canonicalRoot();
    const needle = ignoreCase ? query.toLowerCase() : query;
    const results: Array<{ path: string; line: number; text: string }> = [];
    // A file too large to search is named, so a reader knows it wasn't searched rather than that it holds nothing; past
    // the first few names, the rest are counted. A search that stops at its hit limit names those it reached.
    const tooLarge: string[] = [];
    const answer = (truncated: boolean) => ({
      ok: true as const, results, truncated,
      ...(tooLarge.length ? { tooLarge: tooLarge.slice(0, MAX_SKIPPED_NAMED) } : {}),
      ...(tooLarge.length > MAX_SKIPPED_NAMED ? { tooLargeMore: tooLarge.length - MAX_SKIPPED_NAMED } : {}),
    });
    for (const file of await this.walk(await this.contained(path ?? ""), MAX_SEARCH_FILES)) {
      const text = await this.textFile(join(root, file)).catch((error: unknown) => {
        if (error instanceof Error && error.message === "file is too large to read") tooLarge.push(file);
        return null;
      });
      if (text === null) continue;
      if (!(ignoreCase ? text.toLowerCase() : text).includes(needle)) continue;
      for (const [index, line] of text.split("\n").entries()) {
        if (!(ignoreCase ? line.toLowerCase() : line).includes(needle)) continue;
        results.push({ path: file, line: index + 1, text: line.trim().slice(0, 300) });
        if (results.length >= MAX_SEARCH_RESULTS) return answer(true);
      }
    }
    return answer(false);
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "read_diff") {
      const slice = numberedSlice(await this.diff(), args.start_line, args.line_count);
      this.record({ tool: name }, slice);
      return this.shown(slice);
    }
    if (name === "read_file") {
      const path = await this.contained(args.path);
      const text = await this.textFile(path);
      // The file whose lines were returned: through a symlink or a path like src/./a.ts, the one it resolves to.
      const returned = relative(await this.canonicalRoot(), path).split(sep).join("/");
      this.opened.add(returned);
      const slice = numberedSlice(text, args.start_line, args.line_count);
      this.record({ tool: name, path: returned }, slice);
      return this.shown(slice);
    }
    if (name === "read_base_file") {
      const text = await this.baseFile(String(args.path ?? ""));
      if (text === null) throw new Error("file does not exist at the base revision");
      const relativePath = safeRelativePath(args.path);
      this.opened.add(relativePath);
      const slice = numberedSlice(text, args.start_line, args.line_count);
      this.record({ tool: name, path: relativePath }, slice);
      return this.shown(slice);
    }
    if (name === "read_change_text" && this.texts) {
      const which = String(args.which);
      if (!Object.hasOwn(CHANGE_TEXTS, which)) throw new Error("which is description or commit-messages");
      const cited = CHANGE_TEXTS[which]!;
      const slice = numberedSlice(this.texts[cited.text], args.start_line, args.line_count);
      this.record({ tool: name, path: cited.path }, slice);
      return this.shown(slice);
    }
    if (name === "list_files") {
      const files = await this.walk(await this.contained(args.path ?? ""), MAX_LIST_FILES);
      this.reads.push({ tool: name, path: String(args.path ?? "") });
      return { ok: true, files, truncated: files.length >= MAX_LIST_FILES };
    }
    if (name === "search") {
      const found = await this.search(args.query, args.path, args.ignore_case);
      this.reads.push({ tool: name, query: String(args.query), hits: found.results.map(({ path, line }) => ({ path, line })) });
      return found;
    }
    return { ok: false, error: "unknown tool" };
  }

  /** Runs one tool call and always returns a JSON string for the model. */
  async call(name: string, rawArguments: string): Promise<string> {
    let result: unknown;
    try {
      const parsed: unknown = JSON.parse(rawArguments || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("not an object");
      if (this.outputBytes > MAX_TOTAL_OUTPUT_BYTES) throw new Error("tool output budget is exhausted");
      result = await this.dispatch(name, parsed as Record<string, unknown>);
    } catch (error) {
      result = { ok: false, error: error instanceof SyntaxError ? "arguments must be a JSON object" : safeError(error) };
    }
    const output = JSON.stringify(result);
    this.outputBytes += Buffer.byteLength(output);
    return output;
  }
}
