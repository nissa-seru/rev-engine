// The review shape end to end: the planner, both batteries over every area, the grouper, the judge and the severity
// check, with each area's run directory written as it goes. Every answer is kept as it arrives, so a review stopped
// partway for any reason but a refused call (battery A's model unavailable, the review's time limit, a stage that failed) is resumed
// from them, asking only the finder calls with no kept answer.
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { pickDesignDocs } from "../docs.ts";
import { parseDiff, type OutputFinding } from "../findings.ts";
import { ModelError, ModelRefused, ModelUnavailable, told, type Chat, type Usage } from "../llm.ts";
import { loadPrior } from "../prior.ts";
import { GENERATED, loadPullRequest, loadRules } from "../review.ts";
import { safeRelativePath, Workspace, type ChangeTexts, type KnownTexts, type ReadRecord } from "../tools.ts";
import { callsOf, numberedLines, runFind, TEXT_FILES, type Battery, type ChangeBrief, type FindAnswer } from "./find.ts";
import { groupFindings } from "./group.ts";
import { judgeIssues, parseKnown, type JudgeVerdict, type Known } from "./judge.ts";
import { writePlan, type Area, type Lens, type Plan, type Task } from "./plan.ts";
import { settleSeverities } from "./severity.ts";
import { clause, entryOf, SEVERITY_RANK, type Finding, type Hunk, type Issue, type Kind, type Place, type Severity } from "./types.ts";

const execFileAsync = promisify(execFile);

/** The models of each stage, through the configured endpoints. The planner, the judge and the large grouper share the first. */
export const SHAPE_MODELS = { haiku: "claude-haiku-5-5", sol: "gpt-6.1-sol", terra: "gpt-6.1-terra" };
const BATTERY_A = {
  terra: { model: SHAPE_MODELS.terra, name: "Terra" },
  sol: { model: SHAPE_MODELS.sol, name: "Sol" },
} as const;
const EFFORT = { opus: "high", haiku: "max", batteryA: "xhigh" };
/** The context, in tokens, at which a run is made to hand in what it has : where the ported workflow's workers would fold. */
const BOUND = { haiku: 90_000, batteryA: 300_000 };
/** Time kept back for a battery A finder's last turn, which can take minutes at xhigh, when the review nears its limit. */
const BATTERY_A_WRAP_UP_MS = 15 * 60 * 1000;
/** How near the review's limit a failure counts as the limit itself. */
const LIMIT_MARGIN_MS = 2 * 60 * 1000;
/**
 * The review's own time limit, set inside the job's: GitHub stops a job at 6 hours, so the review stops itself a little
 * before that with its answers kept, and is resumed like a call to an unavailable model. Turns are capped only as a guard.
 */
const RUN_LIMIT_MS = 5.5 * 60 * 60 * 1000;
const MAX_TURNS = 1_000;
const MAX_COMMIT_MESSAGE_CHARS = 20_000;
/** Vendored code, by the directories it is kept in, which the plan leaves to its source as it does generated files. */
const VENDORED = /(^|\/)(vendor|vendored|third_party|third-party)\//;

/** Files no slice needs to cover: lockfiles and generated files (the reader's own rule), and vendored code. */
export function leftToSource(path: string): boolean {
  return GENERATED.test(path) || VENDORED.test(path);
}
const MAX_INDEXED_FILES = 20_000;

export type StopReason = "unavailable" | "refused" | "time" | "failed";

export interface ShapeStop {
  reason: StopReason;
  /** For a refused call, the category alone, never the provider's words. */
  category?: string;
  /** What stopped, in a line for the log and the run's record. For a refusal, the category and the call alone. */
  detail: string;
}

/** An issue the review posts: judged real, or one the judge couldn't settle. */
export interface PostedIssue {
  area: string;
  /** The issue's id across the review: its own id, or area/id when the review has several areas. */
  id: string;
  /** Its id in its area's run directory, such as I3, and that directory's label. */
  issue: string;
  label: string;
  title: string;
  severity: Severity;
  kind: Kind;
  verdict: "real" | "unsure";
  /** The batteries whose findings it holds, such as ["A", "B"]. */
  readers: string[];
  places: Place[];
  causes: string[];
  consequences: string[];
  failingCase: string;
  why: string;
  /** Whether it is in what the change adds or alters, or in code the base already has (the judge's origin). */
  origin: "change" | "base";
  /** Whether fixing it would be a security fix, by the judge. */
  security: boolean;
  /** Where it is already named: "description", a thread item's or an open issue's URL, or "". */
  knownAt: string;
  /** For one the change's own text names: whether it gives a reason for leaving it that holds, by the judge. */
  reasonHolds: boolean;
  /** The judge's text of the issue, by reading. */
  text: string;
  /** The run that would confirm it, which the review shows for a blocker or should-fix; "" when the judge gave none. */
  confirm: string;
  /** The ids of issues from other areas that name the same defect, folded into this one by the severity check. */
  repeats: string[];
}

/** What the posting step reads: the review's issues and everything it says about how the review went. */
export interface ShapeReview {
  /** The review's label, re-<owner>.<name>-<pr>-<round>. */
  label: string;
  head: string;
  /** The commit the review read from, and the label of the earlier review whose head that is, when it read only what changed since. */
  base: string;
  roundOf: string | null;
  /** The repository, owner/name, which the review's links point into. */
  repo: string;
  models: { planner: string; batteryA: string; batteryB: string; judge: string };
  /** The issues it posts: every real or unsure one but those held. */
  issues: PostedIssue[];
  /** Security issues in code the base already has, which aren't posted: whoever set up the review, who holds the model key the saved run is sealed with, decides what becomes of them. */
  held: PostedIssue[];
  notReal: Array<{ area: string; id: string; title: string; notRealKind: string; why: string; places: Place[] }>;
  decided: Array<{ area: string; id: string; title: string; repeatOf: string }>;
  unjudged: Array<{ area: string; id: string; title: string }>;
  /** The changed lines no finder's read returned, from what each finder's workspace recorded. */
  unreadChanges: UnreadChanges;
  /** Finders that returned no finding, as area/battery:call. */
  empty: string[];
  /** haiku calls that gave no answer, as area/battery:call. */
  shortfall: string[];
  /** Finders made to hand in at their context bound. */
  bounded: string[];
  /** Findings dropped as malformed, or for citing no file at head or, for a file the change deletes, at the base. */
  dropped: number;
  /** What went wrong in planning, grouping or the severity check, said plainly. */
  problems: string[];
  /** The planner's note, such as generated files left out of every slice. */
  planNote: string;
  /** Changed files in no area of a plan of several, which the review says beside any of their lines no reader read. */
  leftOut: string[];
  /** A project with a package.json whose dependencies weren't installed for the readers. */
  withoutDependencies?: boolean;
  /** Dependencies installed from package.json's ranges, the head having no lockfile at its root. */
  dependenciesFromRanges?: boolean;
}

export interface ShapeOutcome {
  stop: ShapeStop | null;
  /** The findings file's findings: one per posted issue with a place in the repository, most severe first. Empty when the review stopped. */
  findings: OutputFinding[];
  review: ShapeReview | null;
}

/** Where the run directories go, what an earlier run of the review kept, and how this review is named. */
export interface ShapeRun {
  /** The directory each area's run directory is written under. */
  outDir: string;
  /** An earlier run's directory of the same review, whose answers are taken instead of asked again. Null for none. */
  keptDir: string | null;
  /** The review's label, re-<owner>.<name>-<pr>-<round>; an area's run directory adds -<area> when there are several. */
  label: string;
  round: number;
  /** The label of the review whose head this one reads from, when it reads from one. */
  roundOf: string | null;
  /** Set once the kept plan is taken as this review's own. */
  resumed?: boolean;
}

/**
 * Why a failure stops the review. A refusal keeps its category alone, and a request the API rejected (a 4xx other
 * than 408 or 429) fails whenever it happened, since sending it again gets the same. Any other failure within `margin`
 * of the review's limit, when it happened, is the limit, since a call cut off there looks like one that couldn't be
 * reached. A battery A finder's margin covers the time its last turn is given (BATTERY_A_WRAP_UP_MS), since its ordinary turns are
 * cut off there.
 */
export function stopReasonOf(error: unknown, deadline: number, at = Date.now(), margin = LIMIT_MARGIN_MS): { reason: StopReason; category?: string } {
  if (error instanceof ModelRefused) return { reason: "refused", category: error.category };
  if (error instanceof ModelError && !(error instanceof ModelUnavailable) && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) return { reason: "failed" };
  if (at >= deadline - margin || /ran out of time before submitting/.test(told(error))) return { reason: "time" };
  if (error instanceof ModelUnavailable) return { reason: "unavailable" };
  return { reason: "failed" };
}

/** Which of several failures decides the stop: a refusal, then one a later run can get past, then any other. */
const STOP_ORDER: Record<StopReason, number> = { refused: 0, unavailable: 1, time: 1, failed: 2 };

/** The failure that decides the stop, by STOP_ORDER; the first of equals. */
export function decidingFailure<T extends { why: { reason: StopReason } }>(failures: T[]): T | undefined {
  return [...failures].sort((a, b) => STOP_ORDER[a.why.reason] - STOP_ORDER[b.why.reason])[0];
}

/**
 * The stop a failure makes, said for the log and the run's record: a refusal by its category and where it happened,
 * alone; any other by what failed, in its own words.
 */
export function stopFor(error: unknown, deadline: number, where: string, at = Date.now(), margin = LIMIT_MARGIN_MS): ShapeStop {
  const why = stopReasonOf(error, deadline, at, margin);
  if (why.reason === "refused") return { reason: "refused", ...(why.category ? { category: why.category } : {}), detail: `${where} was refused (${why.category ?? "category not given"})` };
  return { reason: why.reason, detail: `${where} failed: ${told(error)}` };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, typeof value === "string" ? value : `${JSON.stringify(value, null, 1)}\n`);
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * A path as a diff's --- or +++ line writes it, with its a/ or b/ still on. Git quotes a path that holds a double quote,
 * a backslash or a control character (and, without core.quotePath=false, any byte past ASCII), writing those as C escapes
 * with octal for raw bytes; the path the file tools read is the decoded one. A name it doesn't quote but that holds a
 * space it follows with a tab, which isn't the name's, while a space at the name's end is.
 */
export function diffHeaderPath(text: string): string {
  const written = text.endsWith("\t") ? text.slice(0, -1) : text;
  if (written.length < 2 || !written.startsWith('"') || !written.endsWith('"')) return written;
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const bytes: number[] = [];
  const body = written.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const octal = /^\\([0-3][0-7]{2})/.exec(body.slice(index));
    if (octal) {
      bytes.push(parseInt(octal[1]!, 8));
      index += 3;
    } else if (body[index] === "\\" && Object.hasOwn(escapes, body[index + 1] ?? "")) {
      bytes.push(escapes[body[index + 1]!]!);
      index += 1;
    } else {
      // One UTF-16 unit at a time would split a surrogate pair, so a character outside the basic plane goes whole.
      const character = String.fromCodePoint(body.codePointAt(index)!);
      bytes.push(...Buffer.from(character, "utf8"));
      index += character.length - 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * For each changed file, the lines of the diff (as read_diff numbers them) its part spans, its size in characters, and
 * its hunks, so a slice of part of a file is measured and pointed to by the hunks that reach into it.
 */
export function diffParts(diff: string): { lines: Map<string, [number, number]>; chars: Map<string, number>; hunks: Map<string, Hunk[]> } {
  const lines = new Map<string, [number, number]>();
  const chars = new Map<string, number>();
  const hunks = new Map<string, Hunk[]>();
  const all = diff.split("\n");
  if (all.at(-1) === "") all.pop();
  let current: { path: string; start: number; size: number; named: boolean; old?: string; hunks: Hunk[] } | null = null;
  const close = (end: number): void => {
    if (!current) return;
    const last = current.hunks.at(-1);
    if (last) last.lines[1] = end;
    lines.set(current.path, [current.start, end]);
    chars.set(current.path, current.size);
    hunks.set(current.path, current.hunks);
  };
  for (const [index, text] of all.entries()) {
    const hunk = current ? /^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,([0-9]+))? @@/.exec(text) : null;
    if (text.startsWith("diff --git ")) {
      close(index);
      // The new path is the header's b/ path; a later +++ line names it exactly when the header can't be split.
      const header = /^diff --git a\/(.*) b\/(.*)$/.exec(text);
      current = { path: header?.[2] ?? "", start: index + 1, size: 0, named: Boolean(header), hunks: [] };
    } else if (current && hunk) {
      const last = current.hunks.at(-1);
      if (last) last.lines[1] = index;
      // "+c,d" spans head lines c to c+d-1; with no count it is one line, and with 0 it only removes, between c and c+1.
      const from = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.hunks.push({ lines: [index + 1, index + 1], chars: 0, head: count ? [from, from + count - 1] : [from, from + 1] });
    } else if (current && !current.named && text.startsWith("--- ")) {
      // A file the change deletes is named only here, since its +++ line is /dev/null.
      const path = diffHeaderPath(text.slice(4));
      if (path !== "/dev/null") current.old = path.replace(/^a\//, "");
    } else if (current && !current.named && text.startsWith("+++ ")) {
      const path = diffHeaderPath(text.slice(4));
      current.path = path !== "/dev/null" ? path.replace(/^b\//, "") : current.old ?? "";
      current.named = true;
    }
    if (current) {
      current.size += text.length + 1;
      const last = current.hunks.at(-1);
      if (last) last.chars += text.length + 1;
    }
  }
  close(all.length);
  return { lines, chars, hunks };
}

/**
 * The pull request's thread and the repository's open issues, as the collector leaves them beside prior.json, or null
 * when it left none (it couldn't read them) or what it left can't be read; the review then says so among its problems.
 */
export async function loadKnown(path: string, log: (message: string) => void): Promise<Known | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) {
    log("no thread or open issues were collected, so the judge can't tell an issue raised before");
    return null;
  }
  let known: Known | null = null;
  try {
    known = parseKnown(JSON.parse(text));
  } catch {
    known = null;
  }
  log(known ? `the judge reads ${known.thread.length} thread item(s) and ${known.issuesError ? `no open issues (${known.issuesError})` : `${known.issues.length} open issue(s)${known.more ? ", the newest of more" : ""}`}` : "ignoring known.json, which isn't the collector's shape");
  return known;
}

/** What the review couldn't check for an issue raised before, for its saved problems, or null when it read it all. */
export function knownProblem(known: Known | null): string | null {
  if (!known) return "The pull request's thread and the repository's open issues weren't read, so an issue raised there before may be raised here again.";
  if (known.issuesError) return `The repository's open issues weren't read, so an issue filed there before may be raised here again. Where GitHub refused them, the workflow needs the permission issues: read. The collector said: ${known.issuesError.trim().replace(/[.\s]+$/, "")}.`;
  if (known.more) return `The judge read the newest ${known.issues.length} of the repository's open issues, not the older ones, so an issue filed in one of those may be raised here again.`;
  return null;
}

async function commitMessages(config: Config, log: (message: string) => void): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", "-C", config.repoDir, "log", "--reverse", "--format=commit %h%n%n%B", `${config.base}..${config.head}`], {
      maxBuffer: 4_000_000, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.length > MAX_COMMIT_MESSAGE_CHARS ? `${stdout.slice(0, MAX_COMMIT_MESSAGE_CHARS)}\n[cut here]` : stdout;
  } catch (error) {
    log(`the commit messages couldn't be read, so the review goes without them: ${told(error)}`);
    return "";
  }
}

/** What the checkout holds beside the change: the head's installed dependencies, and repositories that rely on it. */
export async function surroundings(repoDir: string): Promise<{ text: string; installed: boolean; javascript: boolean; fromRanges: boolean }> {
  const installed = await stat(join(repoDir, "node_modules")).then((info) => info.isDirectory(), () => false);
  // Left by the dependencies job when the head has no lockfile at its root, so the versions came from package.json's ranges.
  const fromRanges = installed && await stat(join(repoDir, "node_modules", ".installed-from-ranges")).then(() => true, () => false);
  const javascript = await stat(join(repoDir, "package.json")).then((info) => info.isFile(), () => false);
  const consumers = await readdir(join(repoDir, ".consumers")).catch(() => [] as string[]);
  const lines = [installed
    ? `The head's dependencies are installed in node_modules, ${fromRanges ? "from its package.json's version ranges, since it has no lockfile at its root, so a dependency may be a later version than the author ran" : "from its lockfile"}. When a case runs through a dependency, read the dependency's own code there; search finds text inside one when its path names it, such as node_modules/<package>.`
    : "The head's dependencies are not installed here, so a dependency's behaviour is known only from the facts above, the repository's own documentation, and how the code uses it."];
  if (consumers.length) lines.push(`Repositories that rely on this one are checked out at their default branch under .consumers/: ${consumers.sort().join(", ")}. Read their use of what the change alters.`);
  return { text: lines.join("\n"), installed, javascript, fromRanges };
}

/** A kept plan, when it is this review's (label, base, head, the base its rules were read from, and battery A's model) and has an area to
 * read: a plan with none would review nothing and read as a clean review. */
export function keptPlanOf<T extends { label: string; base: string; head: string; rulesBase: string; batteryA?: string; plan: Plan; problems: string[] }>(
  kept: T | null, identity: { label: string; base: string; head: string; rulesBase: string; batteryA: string },
): T | null {
  return kept && kept.label === identity.label && kept.base === identity.base && kept.head === identity.head && kept.rulesBase === identity.rulesBase
    && kept.batteryA === identity.batteryA
    && Array.isArray(kept.plan?.areas) && kept.plan.areas.length > 0 ? kept : null;
}

/** The tasks an area's finders read: its plan's tasks, then each question as a task of its own, q1, q2… */
export function areaTasks(area: Area): Task[] {
  return [...area.tasks, ...area.questions.map((question, index) => ({ id: `q${index + 1}`, slice: { kind: "question" as const, question }, lenses: [] }))];
}

/** The change's lines that no finder's read returned, which is what the review says it couldn't read. */
export interface UnreadChanges {
  /** The lines the diff adds or removes. */
  changed: number;
  /** How many of them no finder's read returned. */
  unread: number;
  /**
   * Each file with such lines, in the diff's order: added lines by their line at head, removed ones by their line at the
   * base, in the file the base names (basePath, when the change moved it).
   */
  files: Array<{ path: string; basePath?: string; added: Array<[number, number]>; removed: Array<[number, number]> }>;
}

/** Runs of consecutive line numbers, as ranges. */
function runsOf(numbers: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const number of numbers) {
    const last = runs.at(-1);
    if (last && number === last[1] + 1) last[1] = number;
    else runs.push([number, number]);
  }
  return runs;
}

/**
 * The diff's added and removed lines that no read returned. An added line is read when a read of the diff (read_diff)
 * or of its file at head (read_file) returned it, a removed one when a read of the diff did. A read at the base doesn't
 * count for a removed line: a first review's diff runs from the merge base, while read_base_file reads the base branch's
 * tip, whose line numbers needn't be the diff's. A search hit isn't reading a line, and nor is listing files. The reads
 * are every finder's that gave an answer, of both batteries and every area: the review read a line if any of its
 * readers did.
 */
export function unreadChanges(diff: string, reads: ReadRecord[]): UnreadChanges {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const shown = new Uint8Array(lines.length + 1);
  const atHead = new Map<string, Array<[number, number]>>();
  for (const read of reads) {
    if (!read.lines) continue;
    const [from, to] = read.lines;
    // A record's lines start at 1, and fill stops at the array's end, as the read did at the diff's.
    if (read.tool === "read_diff") shown.fill(1, from, to + 1);
    if (read.tool === "read_file" && read.path) atHead.set(read.path, [...(atHead.get(read.path) ?? []), read.lines]);
  }
  const within = (ranges: Array<[number, number]> | undefined, line: number): boolean => (ranges ?? []).some(([from, to]) => from <= line && line <= to);
  const named = (text: string): string | null => {
    const path = diffHeaderPath(text.slice(4));
    return path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
  };
  const result: UnreadChanges = { changed: 0, unread: 0, files: [] };
  // One file's part of the diff: its paths, from its --- and +++ lines, and its unread lines so far.
  let part: { base: string | null; head: string | null; added: number[]; removed: number[] } | null = null;
  let inHunk = false;
  let head = 0;
  let base = 0;
  const close = (): void => {
    if (!part || (!part.added.length && !part.removed.length)) return;
    const path = part.head ?? part.base ?? "";
    result.files.push({
      path, ...(part.base && part.base !== path ? { basePath: part.base } : {}), added: runsOf(part.added), removed: runsOf(part.removed),
    });
  };
  for (const [index, text] of lines.entries()) {
    if (text.startsWith("diff --git ")) {
      close();
      part = { base: null, head: null, added: [], removed: [] };
      inHunk = false;
      continue;
    }
    if (!part) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      inHunk = true;
      base = Number(hunk[1]);
      head = Number(hunk[2]);
      continue;
    }
    if (!inHunk) {
      // A file's header names it: before its first hunk, a --- or +++ line is a path, not a removed or added line.
      if (text.startsWith("--- ")) part.base = named(text);
      else if (text.startsWith("+++ ")) part.head = named(text);
      continue;
    }
    const diffLine = index + 1;
    if (text.startsWith("+")) {
      result.changed += 1;
      if (!shown[diffLine] && !within(atHead.get(part.head ?? ""), head)) {
        part.added.push(head);
        result.unread += 1;
      }
      head += 1;
    } else if (text.startsWith("-")) {
      result.changed += 1;
      if (!shown[diffLine]) {
        part.removed.push(base);
        result.unread += 1;
      }
      base += 1;
    } else if (!text.startsWith("\\")) {
      // A context line; "\ No newline at end of file" is neither side's line.
      head += 1;
      base += 1;
    }
  }
  close();
  return result;
}

function areaDir(run: ShapeRun, plan: Plan, area: Area): string {
  return plan.areas.length > 1 ? `${run.label}-${area.name}` : run.label;
}

/** Each kept answer of one area of an earlier run, by battery and call. One that can't be read is said, and asked again. */
export async function keptAnswers(dir: string | null, log: (message: string) => void): Promise<FindAnswer[]> {
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(join(dir, "answers"));
  } catch (error) {
    log(`no kept answers were read from ${join(dir, "answers")} (${told(error)}), so its calls are asked again`);
    return [];
  }
  const answers: FindAnswer[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const answer = await readJson<FindAnswer>(join(dir, "answers", name));
    const readable = answer && typeof answer.battery === "string" && typeof answer.call === "string" && Array.isArray(answer.findings);
    if (readable && Array.isArray(answer.reads)) answers.push(answer);
    // An answer kept before answers held their reads can't say what its finder read, and the review counts what its
    // readers read, so its call is asked again.
    else if (readable) log(`the kept answer ${join(dir, "answers", name)} holds no reads, so its call is asked again`);
    else log(`the kept answer ${join(dir, "answers", name)} can't be read, so its call is asked again`);
  }
  log(`${answers.length} kept answer(s) read from ${join(dir, "answers")}`);
  return answers;
}

export interface ShapeOptions {
  config: Config;
  /** Claude models through the Messages endpoint, and battery A's model through the Responses endpoint. */
  claude: Chat;
  responses: Chat;
  run: ShapeRun;
  usageByCaller: Map<string, Usage>;
  usageByModel: Map<string, Usage>;
  log: (message: string) => void;
}

/**
 * The review shape on one pull request. A failure in any stage stops the review as a battery A call's does, with every answer
 * kept and the stop's reason recorded, rather than leaving the process with nothing said: a planner, grouper or judge
 * that can't be reached, or the review's own limit.
 */
export async function shapeReview(options: ShapeOptions): Promise<ShapeOutcome> {
  const started = Date.now();
  const deadline = started + RUN_LIMIT_MS;
  try {
    return await reviewStages(options, started, deadline);
  } catch (error) {
    const stop = stopFor(error, deadline, "a stage of the review");
    options.log(`stopped: ${stop.detail}`);
    await mkdir(options.run.outDir, { recursive: true })
      .then(() => writeJson(join(options.run.outDir, "run.json"), runRecord(options.run, options.config, stop, started, options)))
      .catch((failure: unknown) => options.log(`the stop couldn't be recorded in run.json: ${told(failure)}`));
    return { stop, findings: [], review: null };
  }
}

async function reviewStages(options: ShapeOptions, started: number, deadline: number): Promise<ShapeOutcome> {
  const { config, claude, responses, run, log } = options;
  const opus = config.models[0]!;
  const batteryA = BATTERY_A[config.shape!.batteryA];
  // A finder's workspace serves the change's description and commit messages too, and the judge's the thread and open
  // issues; the planner's serves neither.
  const workspace = (texts: ChangeTexts | null = null, known: KnownTexts | null = null): Workspace => new Workspace(config.repoDir, config.diffPath, config.base, texts, known);
  const main = workspace();
  // Project rules as the pull request's base has them, which in a later round isn't the base the review reads from.
  const rulesBase = config.shape?.rulesBase ?? config.base;
  const rulesWorkspace = rulesBase === config.base ? main : new Workspace(config.repoDir, config.diffPath, rulesBase);
  // Each lens's title and Look-for text, ported by hand from its source (`name`, `blob`) and worded for any project's
  // review; a later change at the source is ported by hand, as the briefs are.
  const lenses = JSON.parse(await readFile(new URL("./lenses.json", import.meta.url), "utf8")) as Record<string, Lens>;
  const [pr, diff, rules, prior, messages, known] = await Promise.all([loadPullRequest(config), main.diff(), loadRules(rulesWorkspace), loadPrior(config.priorJsonPath, log), commitMessages(config, log), loadKnown(join(dirname(config.priorJsonPath), "known.json"), log)]);
  // The change's own text is cited by its lines as the finders are given it.
  const textLines: Record<string, number> = { "change-text.md": numberedLines(pr.body), "commit-messages.txt": numberedLines(messages) };
  // Counted once a file, since every citation of it asks again.
  const counted = new Map<string, Promise<number | null>>();
  const headLines = (path: string): Promise<number | null> => {
    if (!counted.has(path)) counted.set(path, countHeadLines(path));
    return counted.get(path)!;
  };
  const countHeadLines = async (path: string): Promise<number | null> => {
    if (TEXT_FILES.includes(path)) return textLines[path] || null;
    const text = await main.headFile(path);
    if (text !== null) return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    // A file at head that isn't read as text (binary, or past the read limit) is still there: its lines are counted
    // from its bytes, so it isn't taken for a file the change deletes.
    const present = await main.contained(path).then(async (real) => ((await stat(real)).isFile() ? real : null)).catch(() => null);
    if (present === null) return null;
    // Read as a stream, so a large file isn't held whole.
    let lines = 0;
    let last = 10;
    for await (const chunk of createReadStream(present) as AsyncIterable<Buffer>) {
      for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) lines += 1;
      if (chunk.length) last = chunk[chunk.length - 1]!;
    }
    return lines + (last !== 10 ? 1 : 0);
  };
  // A finding may cite a file the change deletes, by its lines at the base: a file there, not a directory.
  const placeLines = async (path: string): Promise<{ lines: number; base: boolean } | null> => {
    const atHead = await headLines(path);
    if (atHead !== null) return { lines: atHead, base: false };
    let safe: string;
    try {
      safe = safeRelativePath(path);
    } catch {
      return null;
    }
    const kind = await execFileAsync("git", ["-c", "safe.directory=*", "-C", config.repoDir, "cat-file", "-t", `${config.base}:${safe}`], {
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    }).then(({ stdout }) => stdout.trim(), () => "");
    if (kind !== "blob") return null;
    const text = await main.baseFile(path).catch(() => null);
    return text === null ? null : { lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), base: true };
  };

  const changed = parseDiff(diff);
  const parts = diffParts(diff);
  const changedFiles = [...parts.chars.keys()];
  const documents = pickDesignDocs(await main.allFiles(MAX_INDEXED_FILES), [...changed.keys()], rules.map((rule) => rule.path));
  const decisions = prior?.entries.length ? prior : null;
  await mkdir(run.outDir, { recursive: true });

  // 1. The plan, or the plan an earlier run of this review wrote, so a resumed review reads what it was asked. A kept
  // plan of another review (another round, base, head or battery A model), or one that can't be read, is set aside with its answers.
  const identity = { label: run.label, base: config.base, head: config.head, rulesBase, batteryA: batteryA.model };
  const keptState = run.keptDir ? await readJson<{ label: string; base: string; head: string; rulesBase: string; batteryA?: string; plan: Plan; problems: string[] }>(join(run.keptDir, "shape-plan.json")) : null;
  const keptPlan = keptPlanOf(keptState, identity);
  if (run.keptDir && !keptPlan) {
    log(`not resuming: the kept state at ${run.keptDir} holds no readable plan of this review (${identity.label} at ${identity.head.slice(0, 12)} from ${identity.base.slice(0, 12)}, battery A on ${identity.batteryA})`);
    // So the run's record doesn't call it resumed.
    run.keptDir = null;
  }
  const keptDir = run.keptDir;
  run.resumed = Boolean(keptDir);
  let plan: Plan;
  let problems: string[];
  if (keptPlan) {
    ({ plan, problems } = keptPlan);
    log(`resuming: the plan of the earlier run, with ${plan.areas.length} area(s)`);
  } else {
    const planned = await writePlan(
      {
        nwo: config.nwo, title: pr.title, description: pr.body, commitMessages: messages, diffChars: diff.length, rules, documents, changedFiles,
        ...(run.roundOf ? { roundNote: "This review reads only what changed since the head an earlier review of this pull request read: read_diff shows that, and read_base_file reads that earlier head. The rule files below are the pull request's base's, not that head's." } : {}),
      },
      {
        chat: claude, model: opus, effort: EFFORT.opus, workspace: workspace(), deadline, maxTurns: MAX_TURNS, lenses, log,
        context: { lensIds: Object.keys(lenses), diffChars: parts.chars, hunks: parts.hunks, generated: leftToSource, headLines },
      },
    );
    ({ plan, problems } = planned);
  }
  // A checkpoint that can't be written costs a resume, not this run.
  await writeJson(join(run.outDir, "shape-plan.json"), { ...identity, plan, problems }).catch((error: unknown) => log(`the plan couldn't be kept for a resume: ${told(error)}`));
  log(`plan: ${plan.areas.length} area(s), ${plan.areas.reduce((sum, area) => sum + area.tasks.length + area.questions.length, 0)} task(s) and question(s), ${plan.facts.length} fact(s)`);

  const batteries: Battery[] = [
    { letter: "A", model: batteryA.model, effort: EFFORT.batteryA, perCall: 2, contextTokens: BOUND.batteryA, countdown: false, wrapUpMs: BATTERY_A_WRAP_UP_MS },
    { letter: "B", model: SHAPE_MODELS.haiku, effort: EFFORT.haiku, perCall: 1, contextTokens: BOUND.haiku, countdown: true },
  ];
  const chatOf = (letter: string): Chat => (letter === "A" ? responses : claude);
  const roundNote = run.roundOf ? `The base of this review is the head an earlier review of this pull request read, so it shows only what changed since; read_base_file reads that head.` : "";

  const around = await surroundings(config.repoDir);
  // 2. Both batteries over every area, every call at once. Each answer is written as it arrives.
  const areas = plan.areas.map((area) => ({ area, dir: join(run.outDir, areaDir(run, plan, area)), keptFrom: keptDir ? join(keptDir, areaDir(run, plan, area)) : null }));
  const found = await Promise.all(areas.map(async ({ area, dir, keptFrom }) => {
    // The kept answers are read first, then the area's answers start afresh, so none from an earlier review is taken.
    // Kept answers read from this same directory are already in place, and removing them first would lose them to a
    // run stopped before they were written again.
    const kept = await keptAnswers(keptFrom, log);
    const inPlace = Boolean(keptFrom) && resolve(keptFrom!) === resolve(dir);
    if (!inPlace) await rm(join(dir, "answers"), { recursive: true, force: true });
    await mkdir(join(dir, "answers"), { recursive: true });
    if (!inPlace) {
      for (const answer of kept) {
        await writeJson(join(dir, "answers", `${answer.battery}-${answer.call}.json`), answer).catch((error: unknown) => log(`a kept answer couldn't be kept again for a resume: ${told(error)}`));
      }
    }
    const change: ChangeBrief = {
      diffLines: parts.lines, hunks: parts.hunks, title: pr.title, description: pr.body, commitMessages: messages, facts: plan.facts, roundNote,
      dependencies: around.text, areaFiles: plan.areas.length > 1 ? area.files : null,
    };
    const chats = new Map(batteries.map((battery) => [battery.letter, chatOf(battery.letter)]));
    const outcomes = await Promise.all(batteries.map((battery) => runFind({
      chat: chats.get(battery.letter)!, batteries: [battery], tasks: areaTasks(area), change, lenses, workspace, placeLines, deadline, maxTurns: MAX_TURNS, log,
      scope: area.name, kept: kept.filter((answer) => answer.battery === battery.letter),
      onAnswer: (answer) => writeJson(join(dir, "answers", `${answer.battery}-${answer.call}.json`), answer),
    })));
    return { area, dir, answers: outcomes.flatMap((outcome) => outcome.answers), failed: outcomes.flatMap((outcome) => outcome.failed) };
  }));

  // A battery A call that gave no answer stops the review once every call of every area has finished, with every answer
  // kept (but a refusal's); haiku never reads in its place. A failed call doesn't stop its siblings, which were all
  // sent at the start. Each failure is judged as of when it happened. A refusal (only battery A's calls are refused) decides
  // the stop, since a review stopped for another reason is resumed and a refused call isn't; then one a later run can
  // get past.
  const batteryAFailures = found.flatMap((entry) => entry.failed.filter((failure) => failure.battery === "A").map((failure) => ({
    ...failure, area: entry.area.name, why: stopReasonOf(failure.error, deadline, failure.at, BATTERY_A_WRAP_UP_MS + LIMIT_MARGIN_MS),
  })));
  const batteryAFailure = decidingFailure(batteryAFailures);
  if (batteryAFailure) {
    const stop = stopFor(batteryAFailure.error, deadline, `a ${batteryA.name} call (${batteryAFailure.area} A:${batteryAFailure.call})`, batteryAFailure.at, BATTERY_A_WRAP_UP_MS + LIMIT_MARGIN_MS);
    // A record that can't be written mustn't turn this stop (a refusal, say) into a failure of the stage.
    await writeJson(join(run.outDir, "run.json"), runRecord(run, config, stop, started, options))
      .catch((error: unknown) => log(`the stop couldn't be recorded in run.json: ${told(error)}`));
    log(`stopped: ${stop.detail}`);
    return { stop, findings: [], review: null };
  }

  // 3–5. Group and judge each area, all areas at once.
  const judged = await Promise.all(found.map(async ({ area, dir, answers, failed }) => {
    const findings = (letter: string): Finding[] => answers.filter((answer) => answer.battery === letter).flatMap((answer) => answer.findings);
    const all = [...findings("A"), ...findings("B")];
    const grouping = await groupFindings(all, {
      chat: claude, smallModel: SHAPE_MODELS.haiku, largeModel: opus, smallEffort: EFFORT.haiku, largeEffort: EFFORT.opus, workspace: main, deadline, log, caller: `group ${area.name}`,
    });
    const judging = await judgeIssues(grouping.issues, all, {
      // The judge tells the change's code from the base's (an issue's origin) against the pull request's target, which in
      // a later round isn't the base the review reads from: that one holds the pull request's own earlier commits.
      chat: claude, model: opus, effort: EFFORT.opus, workspace: (texts) => new Workspace(config.repoDir, config.diffPath, rulesBase, null, texts), prior: decisions, change: { title: pr.title, description: pr.body, commitMessages: messages, facts: plan.facts },
      known, dependencies: around.text, withoutDependencies: !around.installed, laterRound: Boolean(run.roundOf), deadline, maxTurns: MAX_TURNS, log, caller: `judge ${area.name}`,
    });
    const tasks = areaTasks(area);
    const asked = (letter: string): string[] => callsOf(batteries.find((battery) => battery.letter === letter)!, tasks).map((call) => call.id);
    const label = areaDir(run, plan, area);
    await writeJson(join(dir, "plan.json"), {
      label, kind: "revengine", repo: config.nwo, base: config.base, head: config.head, description: "pr-description.md", facts: plan.facts,
      questions: area.questions, tasks: area.tasks, area: { name: area.name, files: area.files }, ...(run.roundOf ? { roundOf: run.roundOf } : {}), planner: opus,
    });
    await writeJson(join(dir, "pr-description.md"), `# ${pr.title}\n\n${pr.body}\n`);
    await writeJson(join(dir, "find-A.json"), findings("A"));
    await writeJson(join(dir, "find-B.json"), findings("B"));
    await writeJson(join(dir, "groups.json"), { issues: grouping.issues, problems: grouping.problems });
    await writeJson(join(dir, "find.json"), {
      change: { label, repo: config.nwo, base: config.base, givenBase: config.base, comparison: "merge-base", head: config.head, stat: `${changedFiles.length} files changed` },
      batteries: batteries.map((battery) => battery.letter),
      finders: Object.fromEntries(batteries.map((battery) => [battery.letter, battery.model])),
      lenses: Object.fromEntries(Object.entries(lenses).map(([id, lens]) => [id, { blob: lens.blob, name: lens.name }])),
      unread: answers.filter((answer) => answer.unread.length).map((answer) => ({ battery: answer.battery, task: answer.call, unread: answer.unread })),
      notes: answers.filter((answer) => answer.note).map((answer) => ({ battery: answer.battery, task: answer.call, note: answer.note })),
      shortfall: failed.length ? [{ battery: "B", asked: asked("B").length, returned: asked("B").length - failed.length, tasks: failed.map((failure) => failure.call) }] : [],
      groupProblems: grouping.problems,
      grouper: grouping.model,
    });
    return { area, dir, answers, failed, grouping, judging, all };
  }));

  // The severity check, once over every issue the judge kept in every area.
  const key = (area: string, id: string): string => (plan.areas.length > 1 ? `${area}/${id}` : id);
  const kept = judged.flatMap(({ area, grouping, judging, all }) => judging.verdicts
    .filter((verdict) => verdict.verdict === "real" || verdict.verdict === "unsure")
    .map((verdict) => ({ area: area.name, verdict, all, issue: grouping.issues.find((issue) => issue.id === verdict.issue)! })));
  const settled = await settleSeverities(
    kept.map(({ area, verdict, issue, all }) => ({
      id: key(area, issue.id), title: issue.title, causes: issue.causes, consequences: issue.consequences, severity: verdict.judgedSeverity,
      verdict: verdict.verdict === "unsure" ? "unsure" as const : "real" as const, why: verdict.why,
      // An issue of one left-out finding has no consequences of its own; its finding's case is what says what's at stake.
      ...(issue.consequences.length ? {} : { failingCase: all.find((finding) => finding.key === issue.findings[0])?.failingCase ?? "" }),
    })),
    { chat: claude, model: opus, effort: EFFORT.opus, workspace: main, deadline, log },
  );
  if (settled.problem) problems.push(settled.problem);
  const unknown = knownProblem(known);
  if (unknown) problems.push(unknown);
  for (const { area, verdict } of kept) verdict.severity = settled.severities.get(key(area, verdict.issue)) ?? verdict.judgedSeverity;
  for (const { dir, judging } of judged) {
    const at = new Date().toISOString();
    await writeJson(join(dir, "judged.jsonl"), judging.verdicts.map((verdict) => JSON.stringify({ ...verdict, head: config.head, at, by: "judge" })).join("\n") + (judging.verdicts.length ? "\n" : ""));
  }

  // Every issue unjudged means the judge didn't run at all: say so loudly rather than post unjudged findings as a review.
  const issueCount = judged.reduce((sum, entry) => sum + entry.grouping.issues.length, 0);
  const unjudgedCount = judged.reduce((sum, entry) => sum + entry.judging.unjudged.length, 0);
  if (issueCount && unjudgedCount === issueCount) {
    const errors = [...new Set(judged.flatMap((entry) => entry.judging.errors))];
    const stop: ShapeStop = { reason: Date.now() >= deadline - LIMIT_MARGIN_MS ? "time" : "failed", detail: `the judge gave no verdict on any of the ${issueCount} issue(s)${errors.length ? `; its calls failed with ${errors.join("; ")}` : ""}` };
    await writeJson(join(run.outDir, "run.json"), runRecord(run, config, stop, started, options));
    log(`stopped: ${stop.detail}`);
    return { stop, findings: [], review: null };
  }

  for (const { area, judging } of judged) {
    if (judging.unjudged.length && judging.errors.length) problems.push(`The judge${plan.areas.length > 1 ? ` (area ${area.name})` : ""} gave no verdict on ${judging.unjudged.length} issue(s); its calls that failed along the way failed with ${judging.errors.join("; ")}.`);
  }
  const review = assembleReview(run, config.head, config.base, { planner: opus, batteryA: batteryA.model, batteryB: SHAPE_MODELS.haiku, judge: opus }, judged, plan, problems, changedFiles, key, diff, settled.sameAs, config.nwo);
  // The maintainers' decisions this review collected go to its first area's run directory, which the store keys them by.
  const decided = await readFile(join(dirname(config.priorJsonPath), "decisions.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") log(`the maintainers' decisions couldn't be read, so the run directory goes without them: ${told(error)}`);
    return "";
  });
  if (decided.trim() && judged.length) await writeJson(join(judged[0]!.dir, "decisions.jsonl"), decided);
  // A project whose dependencies weren't installed was read without their source, which the review says.
  review.withoutDependencies = around.javascript && !around.installed;
  review.dependenciesFromRanges = around.fromRanges;
  await writeJson(join(run.outDir, "shape-review.json"), review);
  await writeJson(join(run.outDir, "run.json"), runRecord(run, config, null, started, options));
  log(outcomeLine(review));
  // The findings file places each issue in the repository at head; one with no such place is posted, not filed there.
  const unplaced = review.issues.filter((issue) => !shownPlace(issue)).map((issue) => issue.id);
  if (unplaced.length) log(`${unplaced.length} issue(s) with no place in the repository at head are left out of the findings file: ${unplaced.join(", ")}`);
  return { stop: null, findings: review.issues.flatMap((issue) => toFinding(issue, config.agent) ?? []), review };
}

export interface AreaResult {
  area: Area;
  answers: FindAnswer[];
  failed: Array<{ battery: string; call: string; error: unknown }>;
  grouping: { issues: Issue[]; problems: string[] };
  judging: { verdicts: JudgeVerdict[]; unjudged: string[] };
  all: Finding[];
}

/** Places with each named once: the same line of the same file, at head or at the base, is one place. */
function distinctPlaces(places: Place[]): Place[] {
  return places.filter((spot, at) => places.findIndex((other) => other.file === spot.file && other.line === spot.line && Boolean(other.base) === Boolean(spot.base)) === at);
}

/**
 * The review from every area's results, each issue's places named once. An issue the severity check named as
 * repeating another (`sameAs`, by key) is folded into it: its places and readers join the first's, which keeps the
 * graver grade and names the repeat. The folded issue is security when any of them is. Then it's in code the base
 * already has when it's security and any of them was placed there, since holding can be undone and posting can't, and
 * otherwise the change's own when any of them is. A security issue in code the base already has is held, not posted,
 * whatever its grade.
 */
export function assembleReview(run: ShapeRun, head: string, base: string, models: ShapeReview["models"], results: AreaResult[], plan: Plan, problems: string[], changedFiles: string[], key: (area: string, id: string) => string, diff: string, sameAs: Map<string, string> = new Map(), repo = ""): ShapeReview {
  const review: ShapeReview = {
    label: run.label, head, base, roundOf: run.roundOf, repo, models, issues: [], held: [], notReal: [], decided: [], unjudged: [],
    // Every answer of every area, both batteries': a line any of the review's readers read, the review read.
    unreadChanges: unreadChanges(diff, results.flatMap((result) => result.answers).flatMap((answer) => answer.reads)),
    empty: [], shortfall: [], bounded: [], dropped: 0,
    problems: [...problems], planNote: plan.note,
    leftOut: plan.areas.length > 1 ? changedFiles.filter((file) => !plan.areas.some((area) => area.files.includes(file) || area.tasks.some((task) => (task.slice.files ?? []).some((entry) => entryOf(entry).path === file)))) : [],
  };
  for (const { area, answers, failed, grouping, judging, all } of results) {
    const byKey = new Map(all.map((finding) => [finding.key, finding]));
    const verdicts = new Map(judging.verdicts.map((verdict) => [verdict.issue, verdict]));
    for (const issue of grouping.issues) {
      const members = issue.findings.map((member) => byKey.get(member)).filter((finding): finding is Finding => Boolean(finding));
      const places = distinctPlaces(members.flatMap((finding) => finding.places));
      const verdict = verdicts.get(issue.id);
      const id = key(area.name, issue.id);
      if (!verdict) review.unjudged.push({ area: area.name, id, title: issue.title });
      else if (verdict.verdict === "not-real") review.notReal.push({ area: area.name, id, title: issue.title, notRealKind: verdict.notRealKind, why: verdict.why, places });
      else if (verdict.verdict === "decided-before") review.decided.push({ area: area.name, id, title: issue.title, repeatOf: verdict.repeatOf ?? "" });
      else {
        review.issues.push({
          area: area.name, id, issue: issue.id, label: areaDir(run, plan, area), title: issue.title, severity: verdict.severity, kind: issue.kind, verdict: verdict.verdict,
          readers: [...new Set(issue.findings.map((member) => member.split(":")[0]!))].sort(),
          places, causes: issue.causes, consequences: issue.consequences, failingCase: members[0]?.failingCase ?? "", why: verdict.why,
          origin: verdict.origin, security: verdict.security, knownAt: verdict.knownAt, reasonHolds: verdict.reasonHolds, text: verdict.text, confirm: verdict.confirm, repeats: [],
        });
      }
    }
    for (const answer of answers) {
      const finder = `${plan.areas.length > 1 ? `${area.name}/` : ""}${answer.battery}:${answer.call}`;
      if (!answer.findings.length) review.empty.push(finder);
      if (answer.bounded) review.bounded.push(finder);
      review.dropped += answer.dropped;
    }
    for (const failure of failed) review.shortfall.push(`${plan.areas.length > 1 ? `${area.name}/` : ""}${failure.battery}:${failure.call}`);
    for (const problem of grouping.problems) review.problems.push(`Grouping${plan.areas.length > 1 ? ` (area ${area.name})` : ""}: ${problem}.`);
  }
  const byId = new Map(review.issues.map((issue) => [issue.id, issue]));
  const repeatsOf = new Map<string, PostedIssue[]>();
  for (const [id, first] of sameAs) {
    const repeat = byId.get(id);
    if (repeat && byId.has(first)) repeatsOf.set(first, [...(repeatsOf.get(first) ?? []), repeat]);
  }
  for (const [first, repeats] of repeatsOf) {
    const kept = byId.get(first)!;
    const all = [kept, ...repeats];
    kept.places = distinctPlaces(all.flatMap((issue) => issue.places));
    kept.readers = [...new Set(all.flatMap((issue) => issue.readers))].sort();
    kept.severity = all.reduce((graver, issue) => (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[graver] ? issue.severity : graver), kept.severity);
    if (all.some((issue) => issue.verdict === "real")) kept.verdict = "real";
    // A security issue any judge placed in the base's code is held: holding can be undone, and posting can't.
    kept.security = all.some((issue) => issue.security);
    kept.origin = kept.security && all.some((issue) => issue.origin === "base") ? "base" : all.some((issue) => issue.origin === "change") ? "change" : "base";
    // Where it's named, and whether the reason given there holds, come from the same issue.
    const named = all.find((issue) => issue.knownAt);
    kept.knownAt = named?.knownAt ?? "";
    kept.reasonHolds = named?.reasonHolds ?? false;
    kept.confirm = all.find((issue) => issue.confirm)?.confirm ?? "";
    kept.repeats = repeats.map((issue) => issue.id);
  }
  const standing = review.issues.filter((issue) => !sameAs.has(issue.id) || !byId.has(sameAs.get(issue.id)!));
  review.held = standing.filter((issue) => issue.security && issue.origin === "base");
  review.issues = standing.filter((issue) => !review.held.includes(issue));
  review.issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return review;
}

/**
 * What the public log says of a review's outcome: only what the posted review shows, its issues and those the judge
 * gave no verdict on. The not-real and decided counts stay in the saved results, since with them a reader of the log
 * could tell by subtraction that an issue was held.
 */
export function outcomeLine(review: Pick<ShapeReview, "issues" | "unjudged">): string {
  return `${review.issues.length} issue(s) to post, ${review.unjudged.length} unjudged`;
}

/** Whether a place is in the repository at head: not the change's own text, a file only the base has, or a checkout of a dependency or a consumer. */
export function atHeadInRepository(place: Place): boolean {
  return !TEXT_FILES.includes(place.file) && !place.base && !/^(node_modules|\.consumers)\//.test(place.file);
}

/**
 * Where the findings file shows an issue: its first place in the repository at head. Null for an issue with none, such
 * as one only about the change's text or a file it deletes. The Action's comment takes the first such place a hunk shows.
 */
export function shownPlace(issue: { places: Place[] }): Place | null {
  return issue.places.find(atHeadInRepository) ?? null;
}

/** One findings-file finding per posted issue with a place in the repository, at shownPlace; null for one without. */
export function toFinding(issue: PostedIssue, producer: string): OutputFinding | null {
  const spot = shownPlace(issue);
  if (!spot) return null;
  const parts = [issue.title.replace(/[.:]+$/, "") + "."];
  if (issue.causes.length) parts.push(`Cause: ${clause(issue.causes)}`);
  if (issue.consequences.length) parts.push(`Consequence: ${clause(issue.consequences)}`);
  if (issue.failingCase) parts.push(`Case: ${issue.failingCase}`);
  return { file: spot.file, start_line: spot.line, end_line: spot.line, message: parts.join(" ").slice(0, 2_500), producer };
}

/** The run's record: which review it was, of what base and head, how it ended, and what it cost. */
function runRecord(run: ShapeRun, config: Config, stop: ShapeStop | null, started: number, spent: Pick<ShapeOptions, "usageByCaller" | "usageByModel">): Record<string, unknown> {
  return {
    label: run.label, round: run.round, ...(run.roundOf ? { roundOf: run.roundOf } : {}), base: config.base, head: config.head,
    outcome: stop ? `stopped: ${stop.reason}` : "done", ...(stop ? { stop } : {}),
    batteryA: BATTERY_A[config.shape!.batteryA].model,
    workflowRun: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    resumedFrom: run.resumed ? process.env.RB_SHAPE_RESUMED_FROM ?? "an earlier run" : null,
    seconds: Math.round((Date.now() - started) / 1000),
    usage: Object.fromEntries(spent.usageByCaller),
    usageByModel: Object.fromEntries(spent.usageByModel),
  };
}
