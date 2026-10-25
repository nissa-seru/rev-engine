import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Workspace, type ChangeTexts } from "../src/tools.ts";
import { loadRules } from "../src/review.ts";

// A fixture's repository reads none of the host's git configuration, whose hooks or signing would meet its commits.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

function fixture(texts: ChangeTexts | null = null): { workspace: Workspace; root: string } {
  const root = mkdtempSync(join(tmpdir(), "rep-tools-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), "outside the checkout\n");
  writeFileSync(join(repo, "src", "a.ts"), "old one\nold two\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "a.ts"), "line one\nline two NEEDLE\nline three\n");
  writeFileSync(join(repo, "src", "b.bin"), Buffer.from([0, 1, 2]));
  symlinkSync(join(root, "secret.txt"), join(repo, "leak.txt"));
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "NEEDLE\n");
  writeFileSync(join(root, "diff.patch"), "d1\nd2\nd3\n");
  return { workspace: new Workspace(repo, join(root, "diff.patch"), base, texts), root };
}

async function call(workspace: Workspace, name: string, args: unknown): Promise<any> {
  return JSON.parse(await workspace.call(name, JSON.stringify(args)));
}

test("a source file of a few megabytes is read a piece at a time and searched, and one past the limit says so", async () => {
  const { workspace, root } = fixture();
  const line = (n: number) => `const value${n} = ${n}; // ${"x".repeat(40)}`;
  const big = Array.from({ length: 40_000 }, (_, n) => line(n + 1)).join("\n") + "\nconst MARKER_AT_THE_END = 1;\n";
  writeFileSync(join(root, "repo", "src", "big.ts"), big);
  assert.ok(big.length > 2_000_000, "past the old 1 MB limit");
  const read = await call(workspace, "read_file", { path: "src/big.ts", start_line: 39_999, line_count: 3 });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.match(read.content, /40001: const MARKER_AT_THE_END = 1;/);
  const found = await call(workspace, "search", { query: "MARKER_AT_THE_END" });
  assert.deepEqual(found.results.map((hit: { path: string; line: number }) => [hit.path, hit.line]), [["src/big.ts", 40_001]]);
  const huge = join(root, "repo", "src", "huge.txt");
  writeFileSync(huge, "y".repeat(17_000_000));
  assert.equal((await call(workspace, "read_file", { path: "src/huge.txt" })).error, "file is too large to read");
  const one = await call(workspace, "search", { query: "zzz" });
  assert.deepEqual([one.tooLarge, one.tooLargeMore], [["src/huge.txt"], undefined], "a file too large to search is named, with nothing more to count");
  const repo = join(root, "repo");
  // A rule file past the limit at the base, beside one that isn't.
  writeFileSync(join(repo, "AGENTS.md"), "z".repeat(17_000_000));
  writeFileSync(join(repo, "CLAUDE.md"), "Use tabs.\n");
  git(repo, "add", "src/huge.txt", "src/big.ts", "AGENTS.md", "CLAUDE.md");
  git(repo, "commit", "-q", "-m", "huge");
  const atHuge = new Workspace(repo, join(root, "diff.patch"), git(repo, "rev-parse", "HEAD"));
  assert.equal((await call(atHuge, "read_base_file", { path: "src/huge.txt" })).error, "file is too large to read", "too large at the base is not missing");
  assert.match((await call(atHuge, "read_base_file", { path: "src/big.ts", start_line: 40_001, line_count: 1 })).content, /40001: const MARKER_AT_THE_END = 1;/, "a base file past the old 1 MB limit is read");
  assert.deepEqual(await loadRules(atHuge), [{ path: "CLAUDE.md", text: "Use tabs." }], "a rule file too large to load is left out, and the review goes on");
});

test("search names the first files too large to search, counts the rest, and still names those it reached when its results run out", async () => {
  const { workspace, root } = fixture();
  const repo = join(root, "repo");
  mkdirSync(join(repo, "big"));
  // Sparse, so they cost no disk: past the limit is told from their size alone.
  for (let n = 10; n < 35; n += 1) {
    writeFileSync(join(repo, "big", `f${n}.txt`), "");
    truncateSync(join(repo, "big", `f${n}.txt`), 17_000_000);
  }
  const missing = await call(workspace, "search", { query: "absent" });
  assert.deepEqual([missing.tooLarge.length, missing.tooLarge[0], missing.tooLargeMore], [20, "big/f10.txt", 5]);
  // The walk is in name order, so the large files come before the hits in zz.ts, and the search stops at its hit limit.
  writeFileSync(join(repo, "zz.ts"), "NEEDLE\n".repeat(100));
  const found = await call(workspace, "search", { query: "NEEDLE" });
  assert.equal(found.truncated, true);
  assert.deepEqual([found.tooLarge.length, found.tooLargeMore], [20, 5], "a search that stops at its hit limit still names what it couldn't search");
});

test("read_file returns numbered lines and the file length", async () => {
  const { workspace } = fixture();
  const result = await call(workspace, "read_file", { path: "src/a.ts", start_line: 2, line_count: 5 });
  assert.deepEqual(result, { ok: true, content: "2: line two NEEDLE\n3: line three", total_lines: 3 });
});

test("read_base_file returns the file as it was before the change", async () => {
  const { workspace } = fixture();
  const result = await call(workspace, "read_base_file", { path: "src/a.ts", start_line: 1, line_count: 10 });
  assert.equal(result.content, "1: old one\n2: old two");
  const missing = await call(workspace, "read_base_file", { path: "src/new.ts", start_line: 1, line_count: 10 });
  assert.deepEqual(missing, { ok: false, error: "file does not exist at the base revision" });
});

test("read_diff slices the diff", async () => {
  const { workspace } = fixture();
  assert.equal((await call(workspace, "read_diff", { start_line: 2, line_count: 1 })).content, "2: d2");
});

test("paths cannot leave the checkout", async () => {
  const { workspace } = fixture();
  const read = (path: string) => call(workspace, "read_file", { path, start_line: 1, line_count: 10 });
  assert.equal((await read("../secret.txt")).error, "parent path segments are not allowed");
  assert.equal((await read("/etc/passwd")).error, "path must be relative");
  assert.equal((await read("leak.txt")).error, "path escapes the checkout");
  assert.equal(await workspace.headFile("leak.txt"), null);
  assert.equal((await read("src/b.bin")).error, "binary files cannot be read");
  assert.equal((await read("src/nope.ts")).error, "path does not exist or cannot be read");
});

test("list_files and search skip symlinks, .git and node_modules", async () => {
  const { workspace } = fixture();
  assert.deepEqual((await call(workspace, "list_files", { path: "" })).files, ["src/a.ts", "src/b.bin"]);
  const found = await call(workspace, "search", { query: "needle", path: "", ignore_case: true });
  assert.deepEqual(found.results, [{ path: "src/a.ts", line: 2, text: "line two NEEDLE" }]);
  assert.deepEqual((await call(workspace, "search", { query: "needle", path: "", ignore_case: false })).results, []);
});

test("the workspace records the lines each read returned, and nothing for a failed read", async () => {
  const { workspace } = fixture();
  await call(workspace, "read_file", { path: "./src/a.ts", start_line: 2, line_count: 400 });
  await call(workspace, "read_base_file", { path: "src/a.ts", start_line: 1, line_count: 1 });
  await call(workspace, "read_diff", { start_line: 2, line_count: 2 });
  await call(workspace, "search", { query: "NEEDLE", path: "", ignore_case: false });
  await call(workspace, "read_file", { path: "leak.txt", start_line: 1, line_count: 10 });
  assert.deepEqual(workspace.reads, [
    { tool: "read_file", path: "src/a.ts", lines: [2, 3] },
    { tool: "read_base_file", path: "src/a.ts", lines: [1, 1] },
    { tool: "read_diff", lines: [2, 3] },
    { tool: "search", query: "NEEDLE", hits: [{ path: "src/a.ts", line: 2 }] },
  ]);
});

test("bad arguments and unknown tools return errors instead of throwing", async () => {
  const { workspace } = fixture();
  assert.equal(JSON.parse(await workspace.call("read_file", "{not json")).error, "arguments must be a JSON object");
  assert.equal((await call(workspace, "run_shell", { command: "id" })).error, "unknown tool");
});

test("read_change_text serves the change's texts as they're cited, and a repository file of a text's name stays the repository's", async () => {
  const { workspace, root } = fixture({ description: "first\nsecond\n\n\n", commitMessages: "--- commit abc\nthe message" });
  writeFileSync(join(root, "repo", "change-text.md"), "the repository's own\n");
  assert.deepEqual(await call(workspace, "read_change_text", { which: "description", start_line: 1, line_count: 400 }), { ok: true, content: "1: first\n2: second", total_lines: 2 }, "blank lines at its end left off, as a citation counts them");
  assert.deepEqual(await call(workspace, "read_change_text", { which: "commit-messages", start_line: 2, line_count: 1 }), { ok: true, content: "2: the message", total_lines: 2 });
  assert.deepEqual(await call(workspace, "read_file", { path: "change-text.md", start_line: 1, line_count: 10 }), { ok: true, content: "1: the repository's own", total_lines: 1 });
  assert.equal((await call(workspace, "read_change_text", { which: "constructor", start_line: 1, line_count: 1 })).error, "which is description or commit-messages");
  assert.deepEqual(workspace.reads, [
    { tool: "read_change_text", path: "change-text.md", lines: [1, 2] },
    { tool: "read_change_text", path: "commit-messages.txt", lines: [2, 2] },
    { tool: "read_file", path: "change-text.md", lines: [1, 1] },
  ]);
  const plain = fixture().workspace;
  assert.equal((await call(plain, "read_change_text", { which: "description", start_line: 1, line_count: 1 })).error, "unknown tool", "a workspace given no texts doesn't serve them");
  assert.deepEqual(plain.reads, []);
});

test("a read cut at its size records only the lines it returned whole", async () => {
  const { workspace, root } = fixture();
  // Three lines of 20,000 characters: the cut at 48,000 ends inside the third, which a reader paging on never sees whole.
  writeFileSync(join(root, "repo", "src", "long.ts"), ["a", "b", "c"].map((letter) => letter.repeat(20_000)).join("\n") + "\n");
  const long = await call(workspace, "read_file", { path: "src/long.ts", start_line: 1, line_count: 3 });
  assert.equal(long.content.length, 48_000);
  assert.match(long.content, /\n3: c+$/, "the third line was returned in part");
  assert.deepEqual(workspace.reads.at(-1), { tool: "read_file", path: "src/long.ts", lines: [1, 2] });
  // "1: " and 23,996 characters, a newline, then "2: " and 23,997: the cut falls just at the second line's end.
  writeFileSync(join(root, "repo", "src", "even.ts"), ["a".repeat(23_996), "b".repeat(23_997), "c"].join("\n") + "\n");
  const even = await call(workspace, "read_file", { path: "src/even.ts", start_line: 1, line_count: 3 });
  assert.match(even.content, /\n2: b{23997}$/);
  assert.deepEqual(workspace.reads.at(-1), { tool: "read_file", path: "src/even.ts", lines: [1, 2] }, "a line the cut ends just after was returned whole");
  writeFileSync(join(root, "repo", "src", "one.ts"), `${"z".repeat(60_000)}\n`);
  await call(workspace, "read_file", { path: "src/one.ts", start_line: 1, line_count: 1 });
  assert.deepEqual(workspace.reads.at(-1), { tool: "read_file", path: "src/one.ts" }, "a first line longer than the cut returned no line whole");
});

test("a read at head is recorded under the file it returned: a symlink's target, a path with a ./ in it", async () => {
  const { workspace, root } = fixture();
  symlinkSync("src/a.ts", join(root, "repo", "alias.ts"));
  await call(workspace, "read_file", { path: "alias.ts", start_line: 1, line_count: 1 });
  await call(workspace, "read_file", { path: "src/./a.ts", start_line: 2, line_count: 1 });
  // git finds no src/./a.ts at the base, so that read returns nothing and records nothing under a name no diff has.
  assert.equal((await call(workspace, "read_base_file", { path: "src/./a.ts", start_line: 1, line_count: 1 })).error, "file does not exist at the base revision");
  assert.deepEqual(workspace.reads, [
    { tool: "read_file", path: "src/a.ts", lines: [1, 1] },
    { tool: "read_file", path: "src/a.ts", lines: [2, 2] },
  ]);
  assert.deepEqual([...workspace.opened], ["src/a.ts"], "opened names the read as reads does");
  // A checkout reached through a symlink records paths inside it, not ../ out of the link.
  symlinkSync(join(root, "repo"), join(root, "linked"));
  const linked = new Workspace(join(root, "linked"), join(root, "diff.patch"), workspace.base);
  await call(linked, "read_file", { path: "src/a.ts", start_line: 1, line_count: 1 });
  assert.deepEqual(linked.reads, [{ tool: "read_file", path: "src/a.ts", lines: [1, 1] }]);
});

test("a read that returns no line records no lines: an empty text, or a start past the end", async () => {
  const { workspace } = fixture({ description: "", commitMessages: "one" });
  const empty = await call(workspace, "read_change_text", { which: "description", start_line: 1, line_count: 10 });
  assert.deepEqual(empty, { ok: true, content: "", total_lines: 0 });
  await call(workspace, "read_file", { path: "src/a.ts", start_line: 99, line_count: 10 });
  await call(workspace, "read_change_text", { which: "commit-messages", start_line: 2, line_count: 10 });
  assert.deepEqual(workspace.reads, [
    { tool: "read_change_text", path: "change-text.md" },
    { tool: "read_file", path: "src/a.ts" },
    { tool: "read_change_text", path: "commit-messages.txt" },
  ]);
});

