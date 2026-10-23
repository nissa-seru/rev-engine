import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Workspace } from "../src/tools.ts";
import { loadRules } from "../src/review.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function fixture(): { workspace: Workspace; root: string } {
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
  return { workspace: new Workspace(repo, join(root, "diff.patch"), base), root };
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
