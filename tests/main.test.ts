import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

type Answer = (body: string, n: number) => { status: number; json: unknown; delayMs?: number };
const REFUSED = { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "PROVIDER-WORDS quoting src/held.ts" } } };
const message = (content: unknown[], stop: string) => ({ status: 200, json: { id: "msg_1", type: "message", role: "assistant", model: "m", content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } } });
/** Its first request answered with text, so a turn and its usage are recorded, and every later one refused as malformed (400). */
const TEXT_THEN_REFUSED: Answer = (_, n) => (n === 1 ? message([{ type: "text", text: "MODEL-TEXT about src/held.ts" }], "end_turn") : REFUSED);
const NOTHING_FOUND = { findings: [], unread: [], note: "MODEL-TEXT about src/held.ts" };
/** A plan of one whole-change task, and each reader, Sol through Responses and haiku through Messages, finding nothing. */
const NO_FINDINGS: Answer = (body) => {
  if (body.includes('"submit_plan"')) return message([{ type: "tool_use", id: "tu_1", name: "submit_plan", input: { facts: [], areas: [{ name: "all", files: ["src/a.ts"], questions: [], tasks: [{ id: "whole", slice: { kind: "whole" }, lenses: [] }] }] } }], "tool_use");
  if (!body.includes('"submit_findings"')) return REFUSED;
  if (body.includes('"input"')) return { status: 200, json: { id: "resp_1", status: "completed", output: [{ type: "function_call", call_id: "c1", name: "submit_findings", arguments: JSON.stringify(NOTHING_FOUND) }], usage: { input_tokens: 10, output_tokens: 5 } } };
  return message([{ type: "tool_use", id: "tu_2", name: "submit_findings", input: NOTHING_FOUND }], "tool_use");
};

/** The entry point run as the Action runs it, against a model endpoint that answers as `answer` says. */
async function run(env: Record<string, string>, answer: Answer = TEXT_THEN_REFUSED, prepare: (root: string) => void = () => {}, rooted: (root: string) => Record<string, string> = () => ({})): Promise<{ code: number | null; stderr: string; root: string }> {
  let requests = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      requests += 1;
      const { status, json, delayMs = 0 } = answer(body, requests);
      setTimeout(() => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = mkdtempSync(join(tmpdir(), "rep-main-"));
  mkdirSync(join(root, "repo", "src"), { recursive: true });
  mkdirSync(join(root, "pr"));
  writeFileSync(join(root, "repo", "src", "a.ts"), "new\n");
  writeFileSync(join(root, "pr", "diff.patch"), DIFF);
  writeFileSync(join(root, "pr", "pr.json"), JSON.stringify({ title: "A change", body: "" }));
  prepare(root);
  try {
    const child = spawn(process.execPath, [new URL("../src/main.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "", HOME: root,
        RB_MODEL_API: "anthropic", RB_MODEL_BASE_URL: url, RB_MODEL_API_KEY: "key", RB_SOL_BASE_URL: url,
        RB_NWO: "o/n", RB_PR_NUMBER: "1", RB_BASE: "a".repeat(40), RB_HEAD: "b".repeat(40),
        RB_REPO: join(root, "repo"), RB_DIFF: join(root, "pr", "diff.patch"), RB_PR_JSON: join(root, "pr", "pr.json"), RB_PRIOR_JSON: join(root, "pr", "prior.json"),
        RB_OUT: join(root, "out", "findings.json"), RB_ATTEMPT: "1",
        ...env, ...rooted(root),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, stderr, root };
  } finally {
    server.close();
  }
}

test("the review shape's job log says only that it started and how it ended; every stage's line is in the trace in its run directory", { timeout: 120_000 }, async () => {
  const { code, stderr, root } = await run({ RB_CONFIG_SHAPE: "on", RB_SHAPE_OUT: "" });
  assert.equal(code, 3, `a stage that failed stops the review: ${stderr}`);
  const said = stderr.trim().split("\n");
  assert.deepEqual(said.map((line) => line.replace(/^agent: (reviewing|settings:) .*/, "agent: $1 …")), [
    "agent: reviewing …",
    "agent: settings: …",
    "agent: the review's trace goes to trace.log in its run directory, sealed with the run",
    "agent: review stopped (failed)",
  ], "nothing of a stage, its turns or its usage");
  const trace = readFileSync(join(root, "out", "shape", "trace.log"), "utf8").trim().split("\n");
  assert.ok(trace.every((line) => /^(\d{4}-\d\d-\d\dT[\d:.]+Z |  )/.test(line)), "each entry with its time, and a message's further lines indented under it");
  assert.ok(trace.some((line) => line.startsWith("  fatal: not a git repository")), "as the commit messages' git error is");
  const lines = trace.map((line) => line.replace(/^\S+ /, ""));
  assert.equal(lines[0], said[0]!.replace(/^agent: /, ""), "the trace starts as the job's log does");
  assert.ok(lines.some((line) => /^planner: turn 1 at \d+s: text$/.test(line)), "a stage's turns");
  assert.ok(lines.some((line) => line.startsWith("stopped: ")), "the stage's stop, with its detail");
  assert.ok(lines.some((line) => line.startsWith("usage ")), "the usage of each caller");
  assert.ok(lines.some((line) => line.startsWith("review stopped (failed): ")), "the stop as the review records it");
  assert.doesNotMatch(stderr + trace.join("\n"), /PROVIDER-WORDS|MODEL-TEXT/, "a provider's words and the model's text reach neither");
});

test("the reader's lines all go to the job's log, and it writes no trace", { timeout: 120_000 }, async () => {
  const { code, stderr, root } = await run({ RB_CONFIG_SECOND_LOOK: "off", RB_CONFIG_VERIFY: "off" });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /^agent: failed: /m);
  assert.throws(() => readFileSync(join(root, "out", "shape", "trace.log")), /ENOENT/);
});

test("a finished review shape says on the job's log what the pull request sees, and its stages only in the trace", { timeout: 120_000 }, async () => {
  const { code, stderr, root } = await run({ RB_CONFIG_SHAPE: "on" }, NO_FINDINGS);
  assert.equal(code, 0, stderr);
  assert.deepEqual(stderr.trim().split("\n").slice(2), [
    "agent: the review's trace goes to trace.log in its run directory, sealed with the run",
    "agent: the review shape finished: 0 issue(s) to post, 0 unjudged",
  ]);
  const trace = readFileSync(join(root, "out", "shape", "trace.log"), "utf8");
  assert.match(trace, / plan: 1 area\(s\), 1 task\(s\) and question\(s\), 0 fact\(s\)\n/);
  assert.match(trace, / 0 finding\(s\) written by the review shape; \d+ model call\(s\), \d+s\n/);
  assert.doesNotMatch(stderr + trace, /PROVIDER-WORDS|MODEL-TEXT/);
});

test("a trace that can't be written is said once on the job's log, and the review goes on without it", { timeout: 120_000 }, async () => {
  const { code, stderr } = await run({ RB_CONFIG_SHAPE: "on" }, TEXT_THEN_REFUSED, (root) => mkdirSync(join(root, "out", "shape", "trace.log"), { recursive: true }));
  assert.equal(code, 3, stderr);
  assert.deepEqual(stderr.trim().split("\n").map((line) => line.replace(/^agent: (reviewing|settings:) .*/, "agent: $1 …").replace(/written to \S+ \(E[A-Z]+\)/, "written to … (E…)")), [
    "agent: reviewing …",
    "agent: the trace couldn't be written to … (E…), so the rest of it is lost",
    "agent: settings: …",
    "agent: the review's trace goes to trace.log in its run directory, sealed with the run",
    "agent: review stopped (failed)",
  ], "the lines it would have held stay off the job's log");
});

test("a failure outside the review's stages is said on the job's log, here a run directory that can't be made", { timeout: 120_000 }, async () => {
  const { code, stderr } = await run({ RB_CONFIG_SHAPE: "on" }, TEXT_THEN_REFUSED, (root) => writeFileSync(join(root, "out"), "a file where the run directory's parent would be"));
  assert.equal(code, 1, stderr);
  assert.match(stderr.trim().split("\n").at(-1)!, /^agent: failed: /, "said where stopped.json can't be written");
});

for (const [escape, how] of [["an unhandled rejection", "Promise.reject(error)"], ["an uncaught exception", "throw error"]] as const) {
  test(`${escape}'s text stays off the job's log: its stack goes to the trace, its class to the log`, { timeout: 120_000 }, async () => {
    const llm = new URL("../src/llm.ts", import.meta.url).href;
    const { code, stderr, root } = await run({ RB_CONFIG_SHAPE: "on" }, () => ({ ...REFUSED, delayMs: 5_000 }), (root) => {
      // Run before main, and fired while its first model call waits: a ModelError whose message quotes the provider.
      writeFileSync(join(root, "escape.mjs"), `import { ModelError } from ${JSON.stringify(llm)};\nsetTimeout(() => { const error = new ModelError(500, "model API returned 500: HELD-TEXT quoted back"); ${how}; }, 500);\n`);
    }, (root) => ({ NODE_OPTIONS: `--import ${join(root, "escape.mjs")}` }));
    assert.equal(code, 1, stderr);
    assert.doesNotMatch(stderr, /HELD-TEXT/);
    assert.equal(stderr.trim().split("\n").at(-1), "agent: failed outside the review's stages: ModelError; its stack goes to the trace");
    const trace = readFileSync(join(root, "out", "shape", "trace.log"), "utf8");
    assert.match(trace, / failed outside the review's stages: ModelError: model API returned 500: HELD-TEXT quoted back\n {6}at /, "the stack, its lines indented under it");
  });
}
