import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.ts";
import { ModelError, ModelRefused, ModelUnavailable, type Chat, type ChatMessage, type ChatRequest } from "../src/llm.ts";
import { Workspace, type ToolDefinition } from "../src/tools.ts";
import { callPrompt, callsOf, checkedFindings, numbered, numberedLines, runFind, taskBrief, type Battery, type ChangeBrief } from "../src/shape/find.ts";
import { checkGrouping, groupFindings, numberIssues } from "../src/shape/group.ts";
import { judgeIssues, parseVerdicts } from "../src/shape/judge.ts";
import { checkPlan, repairPlan, type Lens, type Plan, type PlanContext } from "../src/shape/plan.ts";
import { decidingFailure, diffParts, keptPlanOf, leftToSource, namesPath, shownPlace, stopFor, stopReasonOf, surroundings, toFinding, unreadSpots, type PostedIssue, type StopReason } from "../src/shape/run.ts";
import { mkdirSync as makeDir, mkdtempSync as makeTemp, writeFileSync as writeTo } from "node:fs";
import { tmpdir as tempRoot } from "node:os";
import { join as joinPath } from "node:path";
import { settleSeverities, severityPrompt } from "../src/shape/severity.ts";
import type { Finding, Issue } from "../src/shape/types.ts";
import { buildShapeReview, BODY_LIMIT, cut, markedIssue, shapeCommentBody, type ShapeReview } from "../action/shape.ts";
import { parseHunks, quietMentions, quietParts } from "../action/comments.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,6 @@ function a() {
 context
+added
+added
 context
diff --git a/test/a.test.ts b/test/a.test.ts
new file mode 100644
--- /dev/null
+++ b/test/a.test.ts
@@ -0,0 +1,2 @@
+one
+two
`;

/** A chat that answers each request with the next scripted reply, and keeps what it was asked. */
function scripted(replies: Array<ChatMessage | Error | ((request: ChatRequest) => ChatMessage)>): { chat: Chat; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: Chat = async (request) => {
    requests.push(structuredClone(request));
    const next = replies.shift();
    if (next === undefined) throw new Error("no more scripted replies");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(request) : next;
  };
  return { chat, requests };
}

const submit = (name: string, args: unknown, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ role: "assistant", content: null, tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }], ...extra });

const workspace = new Workspace("/tmp", "/dev/null", "HEAD");
const lensIds = ["text", "states", "pieces", "waits", "callers"];
const lenses: Record<string, Lens> = Object.fromEntries(lensIds.map((id) => [id, { title: `Lens ${id}`, lookFor: `- look for ${id}`, name: `ref/${id}`, blob: "0".repeat(40) }]));

function context(chars: Record<string, number>): PlanContext {
  return {
    lensIds,
    diffChars: new Map(Object.entries(chars)),
    generated: (path) => path.endsWith(".lock"),
    headLines: async (path) => (path in chars || path === "README.md" ? 10 : null),
  };
}

test("each changed file's part of the diff, by the lines read_diff numbers", () => {
  const parts = diffParts(DIFF);
  assert.deepEqual(parts.lines.get("src/a.ts"), [1, 9]);
  assert.deepEqual(parts.lines.get("test/a.test.ts"), [10, 16]);
  assert.equal([...parts.chars.values()].reduce((a, b) => a + b, 0), DIFF.length);
});

test("a plan passes its checks, and each kind of problem is named", async () => {
  const good: Plan = { facts: [], note: "", areas: [{ name: "all", files: [], questions: ["Q?"], tasks: [
    { id: "whole", slice: { kind: "whole" }, lenses: [] },
    { id: "tests", slice: { kind: "tests", files: ["test/a.test.ts"] }, lenses: ["pieces", "waits"] },
  ] }] };
  assert.deepEqual(await checkPlan(good, context({ "src/a.ts": 100, "test/a.test.ts": 50 })), []);

  const bad: Plan = { facts: [], note: "", areas: [{ name: "all", files: [], questions: [], tasks: [
    { id: "q1", slice: { kind: "files", files: ["src/missing.ts"] }, lenses: ["text", "states", "pieces", "waits", "callers"] },
    { id: "t2", slice: { kind: "whole" }, lenses: ["nope"] },
  ] }] };
  const problems = await checkPlan(bad, context({ "src/a.ts": 100_000 }));
  assert.ok(problems.some((problem) => problem.includes("not q1")));
  assert.ok(problems.some((problem) => problem.includes("5 lenses")));
  assert.ok(problems.some((problem) => problem.includes("src/missing.ts is not a file at head")));
  assert.ok(problems.some((problem) => problem.includes("don't exist: nope")));
  assert.ok(problems.some((problem) => problem.includes("cut the change into areas")));
});

test("a plan of several areas covers every changed file with files slices, and a repair adds what it missed", async () => {
  const plan: Plan = { facts: [], note: "", areas: [
    { name: "core", files: ["src/a.ts"], questions: [], tasks: [{ id: "core", slice: { kind: "whole" }, lenses: ["text", "nope"] }] },
    { name: "docs", files: ["docs/x.md"], questions: [], tasks: [{ id: "docs", slice: { kind: "files", files: ["docs/x.md"] }, lenses: [] }] },
  ] };
  const chars = { "src/a.ts": 10, "docs/x.md": 10, "test/a.test.ts": 10, "yarn.lock": 10 };
  const problems = await checkPlan(plan, context(chars));
  assert.ok(problems.some((problem) => problem.includes("a whole slice would read the entire change")));
  assert.ok(problems.some((problem) => problem.includes("in no area: test/a.test.ts")), "a lockfile needs no area");
  const { plan: repaired, repairs } = await repairPlan(plan, context(chars));
  assert.deepEqual(repaired.areas[0]!.tasks[0], { id: "core", slice: { kind: "files", files: ["src/a.ts"] }, lenses: ["text"] });
  assert.deepEqual(repaired.areas.at(-1)!.files, ["test/a.test.ts"]);
  assert.ok(repairs.some((repair) => repair.includes('"rest"')));
  assert.deepEqual(await checkPlan(repaired, context(chars)), []);
});

const finding = (key: string, severity: Finding["severity"] = "minor", kind: Finding["kind"] = "code"): Finding =>
  ({ key, task: "t", kind, severity, claim: `claim ${key}`, failingCase: `case ${key}`, places: [{ file: "src/a.ts", line: 11 }] });

test("a grouping's problems count the findings it misplaces, and issues are numbered by severity", () => {
  const keys = ["A:t[0]", "B:t[0]", "B:t[1]"];
  const found = checkGrouping([{ title: "x", causes: ["c"], consequences: [], members: ["A:t[0]", "A:t[0]", "Z"] }], keys);
  assert.equal(found.misplaced, 4, "two missing, one repeated, one unknown");
  assert.equal(found.empty, 1);
  const issues = numberIssues([
    { title: "minor one", causes: ["c"], consequences: ["d"], members: ["B:t[1]"] },
    { title: "blocker", causes: ["c"], consequences: ["d"], members: ["A:t[0]", "B:t[0]"] },
  ], [finding("A:t[0]", "blocker"), finding("B:t[0]", "minor", "test"), finding("B:t[1]")]);
  assert.deepEqual(issues.map((issue) => [issue.id, issue.title, issue.severity, issue.kind]), [["I1", "blocker", "blocker", "code"], ["I2", "minor one", "minor", "code"]]);
});

test("a small grouper that gives no grouping is asked of the large one, and a finding left out becomes its own issue", async () => {
  const findings = [finding("A:t[0]"), finding("B:t[0]")];
  const { chat, requests } = scripted([
    new Error("haiku stopped"),
    submit("submit_issues", { issues: [{ title: "one", causes: ["c"], consequences: ["d"], members: ["A:t[0]"] }] }),
    submit("submit_issues", { issues: [{ title: "one", causes: ["c"], consequences: ["d"], members: ["A:t[0]"] }] }),
  ]);
  const grouping = await groupFindings(findings, { chat, smallModel: "small", largeModel: "large", smallEffort: "max", largeEffort: "high", workspace, deadline: Date.now() + 60_000, log: () => {}, caller: "group" });
  assert.deepEqual(requests.map((request) => request.model), ["small", "large", "large"]);
  assert.equal(grouping.model, "large");
  assert.deepEqual(grouping.issues.map((issue) => issue.findings), [["A:t[0]"], ["B:t[0]"]]);
  assert.ok(grouping.problems.some((problem) => problem.includes("became an issue of its own: B:t[0]")));
  assert.deepEqual(requests[0]!.tools.map((tool) => tool.function.name), ["submit_issues"], "the grouper reads nothing");
});

const issue = (id: string): Issue => ({ id, title: `title ${id}`, causes: ["c"], consequences: ["d"], findings: ["A:t[0]"], kind: "code", severity: "minor" });

test("verdicts are taken for asked issues once each, and a repeat of a decided finding is decided before", () => {
  const prior = { entries: [{ id: "P1", file: "src/a.ts", title: "old", decision: "wont_fix" as const, round: 1, source: "" }], omitted: 0 };
  const verdicts = parseVerdicts({ verdicts: [
    { issue: "I1", verdict: "real", severity: "should-fix", repeatOf: "P1", exceptionHolds: false, why: "w", evidence: [], confidence: "high", notRealKind: "" },
    { issue: "I1", verdict: "not-real" },
    { issue: "I2", verdict: "not-real", notRealKind: "cannot happen", severity: "minor", repeatOf: "P9" },
    { issue: "I3", verdict: "not-real", notRealKind: "because" },
    { issue: "I4", verdict: "real", severity: "huge" },
    { issue: "I7", verdict: "real" },
  ] }, ["I1", "I2", "I3", "I4"].map(issue).map((one) => ({ ...one, severity: "should-fix" as const })), prior);
  assert.deepEqual(verdicts.map((verdict) => [verdict.issue, verdict.verdict, verdict.repeatOf]), [["I1", "decided-before", "P1"], ["I2", "not-real", undefined], ["I3", "not-real", undefined], ["I4", "real", undefined]]);
  assert.equal(verdicts[2]!.notRealKind, "unstated", "a kind nobody gave isn't filled in");
  assert.equal(verdicts[3]!.severity, "should-fix", "a grade the judge didn't give keeps the readers'");
});

test("an issue a judging call leaves out is asked again alone", async () => {
  const issues = ["I1", "I2", "I3"].map(issue);
  const { chat, requests } = scripted([
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "real", severity: "minor" }, { issue: "", verdict: "real" }] }),
    submit("submit_verdicts", { verdicts: [{ issue: "I2", verdict: "unsure", severity: "should-fix" }] }),
    new Error("judge failed"),
  ]);
  const judging = await judgeIssues(issues, [finding("A:t[0]")], { chat, model: "opus", effort: "high", workspace: () => workspace, prior: null, change: { title: "T", description: "The body.", commitMessages: "commit abc", facts: [] }, deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge" });
  assert.equal(requests.length, 3);
  assert.match(requests[0]!.messages[1]!.content ?? "", /<description>\n1: The body\.\n<\/description>/, "the judge reads the text it judges text issues against");
  assert.match(requests[0]!.messages[1]!.content ?? "", /should-fix: a real defect or gap, with a realistic trigger/, "and grades by the readers' definitions");
  assert.deepEqual(judging.verdicts.map((verdict) => verdict.issue), ["I1", "I2"]);
  assert.deepEqual(judging.unjudged, ["I3"]);
});

test("the severity check settles every grade it gives, and keeps the judge's for the rest", async () => {
  const graded = ["a", "b", "c"].map((id) => ({ id, title: id, causes: [], consequences: [], severity: "minor" as const, verdict: "real" as const, why: "" }));
  const { chat } = scripted([submit("submit_severities", { severities: [{ issue: "a", severity: "blocker" }, { issue: "b", severity: "nope" }] })]);
  const settled = await settleSeverities(graded, { chat, model: "opus", effort: "high", workspace, deadline: Date.now() + 60_000, log: () => {} });
  assert.deepEqual([...settled.severities], [["a", "blocker"], ["b", "minor"], ["c", "minor"]]);
  assert.match(settled.problem ?? "", /no grade for b, c/);
});

const sol: Battery = { letter: "A", model: "sol", effort: "xhigh", perCall: 2, contextTokens: 300_000, countdown: false };
const change: ChangeBrief = { diffLines: diffParts(DIFF).lines, title: "T", description: "D", commitMessages: "M", facts: ["F"], dependencies: "deps", roundNote: "", areaFiles: null };

test("the first battery reads two consecutive tasks per call, the last alone, as one prompt of two parts", () => {
  const tasks = ["a", "b", "c"].map((id) => ({ id, slice: { kind: "whole" as const }, lenses: [] }));
  const calls = callsOf(sol, tasks);
  assert.deepEqual(calls.map((call) => call.id), ["a+b", "c"]);
  const prompt = callPrompt(calls[0]!, sol, change, lenses);
  assert.match(prompt, /^This task has two parts\./);
  assert.match(prompt, /Part 1 of 2\. You are reviewing a code change\. read_diff shows the whole change\./);
  assert.match(prompt, /- F/);
  assert.doesNotMatch(prompt, /countdown/);
});

test("a finding listed in two issues stays in the first that lists it", () => {
  const issues = numberIssues([
    { title: "one", causes: ["c"], consequences: ["d"], members: ["A:t[0]", "B:t[0]"] },
    { title: "two", causes: ["c"], consequences: ["d"], members: ["B:t[0]"] },
    { title: "three", causes: ["c"], consequences: ["d"], members: ["B:t[1]", "A:t[0]"] },
  ], [finding("A:t[0]"), finding("B:t[0]"), finding("B:t[1]")]);
  assert.deepEqual(issues.map((one) => one.findings), [["A:t[0]", "B:t[0]"], ["B:t[1]"]]);
});

test("a finding keeps the places at head, and one with none left is dropped and counted", async () => {
  const call = { battery: "A", id: "a+b", tasks: [] };
  const { findings, dropped } = await checkedFindings([
    { places: [{ file: "./src/a.ts", line: 99 }, { file: "gone.ts", line: 1 }], kind: "test", claim: "c1", failingCase: "f", severity: "blocker" },
    { places: [{ file: "gone.ts", line: 1 }], kind: "code", claim: "c2", failingCase: "f", severity: "minor" },
    { places: [{ file: "change-text.md", line: 3 }], kind: "weird", claim: "c3", failingCase: "f", severity: "huge" },
    { places: [{ file: "src/deleted.ts", line: 4 }], kind: "code", claim: "c4", failingCase: "f", severity: "should-fix" },
  ], "A", call, async (path) => (path === "src/a.ts" ? { lines: 20, base: false } : path === "change-text.md" ? { lines: Number.MAX_SAFE_INTEGER, base: false } : path === "src/deleted.ts" ? { lines: 9, base: true } : null));
  assert.equal(dropped, 1);
  assert.deepEqual(findings.map((item) => [item.key, item.kind, item.severity, item.places]), [
    ["A:a+b[0]", "test", "blocker", [{ file: "src/a.ts", line: 20 }]],
    ["A:a+b[1]", "code", "minor", [{ file: "change-text.md", line: 3 }]],
    ["A:a+b[2]", "code", "should-fix", [{ file: "src/deleted.ts", line: 4, base: true }]],
  ], "a place only the base has, as in a deleted file, is kept and marked");
});

const readTool: ToolDefinition = { type: "function", function: { name: "read_diff", description: "", parameters: { type: "object", properties: {} } } };
const doneTool: ToolDefinition = { type: "function", function: { name: "done", description: "", parameters: { type: "object", properties: {} } } };

test("a run past its context bound is asked to hand in at its next turn, after its tool calls have results", async () => {
  const { chat, requests } = scripted([
    { role: "assistant", content: null, contextTokens: 120, tool_calls: [{ id: "r1", type: "function", function: { name: "read_diff", arguments: "{}" } }] },
    submit("done", { ok: 1 }),
  ]);
  const report = { bounded: false };
  const result = await runAgent({ chat, model: "m", system: "s", prompt: "p", workspace, tools: [readTool], submit: doneTool, deadline: Date.now() + 600_000, maxTurns: 10, log: () => {}, contextBound: 100, report, conversation: "c1" });
  assert.deepEqual(result, { ok: 1 });
  assert.equal(report.bounded, true);
  const last = requests[1]!;
  assert.equal(last.forceTool, "done");
  assert.equal(last.conversation, "c1");
  assert.deepEqual(last.messages.slice(-2).map((message) => message.role), ["tool", "user"], "the tool result comes before the request to hand in");
});

test("a refusal ends the run at once, even while it is handing in", async () => {
  const { chat, requests } = scripted([new ModelRefused(400, "cyber_policy")]);
  await assert.rejects(runAgent({ chat, model: "m", system: "s", prompt: "p", workspace, submit: doneTool, deadline: Date.now() + 600_000, maxTurns: 1, log: () => {} }), ModelRefused);
  assert.equal(requests.length, 1, "it isn't sent again without the forced tool choice");
});

test("a run that ends with its error asks for no partial answer", async () => {
  const { chat, requests } = scripted([new Error("upstream 500")]);
  await assert.rejects(runAgent({ chat, model: "m", system: "s", prompt: "p", workspace, submit: doneTool, deadline: Date.now() + 600_000, maxTurns: 10, log: () => {}, onFailedTurn: "throw" }), /upstream 500/);
  assert.equal(requests.length, 1);
});

const posted = (id: string, severity: PostedIssue["severity"], line = 11, readers = ["A", "B"]): PostedIssue => ({
  area: "all", id, issue: id, label: "re-o.n-1-1", title: `Issue ${id}`, severity, kind: "code", verdict: "real", readers, places: [{ file: "src/a.ts", line }],
  causes: ["the cause"], consequences: ["the effect"], failingCase: "the case", why: "because",
});

function shapeReview(issues: PostedIssue[], extra: Partial<ShapeReview> = {}): ShapeReview {
  return {
    label: "re-o.n-1-1", head: "abcdef0123456789", models: { planner: "opus", batteryA: "sol", batteryB: "haiku", judge: "opus" }, issues,
    notReal: [], decided: [], unjudged: [], unreadSpots: [], unread: [], empty: [], shortfall: [], bounded: [], dropped: 0, problems: [], planNote: "", leftOut: [],
    base: "0123456789abcdef", roundOf: null, ...extra,
  };
}

test("the review comments on blockers and should-fix issues a hunk shows, and lists every issue by severity", () => {
  const review = shapeReview([posted("I1", "blocker"), posted("I2", "should-fix", 12, ["B"]), posted("I3", "should-fix", 40), posted("I4", "minor")], {
    shortfall: ["B:t2"], notReal: [{ area: "all", id: "I5", title: "Not it", notRealKind: "cannot happen", why: "guarded", places: [{ file: "src/a.ts", line: 1 }] }],
  });
  const parts = buildShapeReview({ review, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.deepEqual(parts.comments.map((comment) => comment.line), [11, 12], "I3's line is outside every hunk, and minor gets no comment");
  assert.match(parts.comments[0]!.body, /^\*\*Blocker\. Issue I1\.\*\*/);
  assert.match(parts.comments[1]!.body, /Found by haiku alone\./);
  const order = ["#### Blockers (1)", "#### Should fix (2)", "#### Minor (1)", "#### What the review couldn't read"].map((heading) => parts.body.indexOf(heading));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)), "grouped by severity, most severe first");
  assert.match(parts.body, /\*\*haiku gave no answer for 1 task: B:t2\.\*\*/);
  assert.doesNotMatch(parts.body, /Not it|not to be real|guarded/, "an issue the judge held not real isn't shown");
  assert.match(parts.body, /\*\*Recommendation: fix, then merge\.\*\* 1 blocker should be fixed first\./);
  const advice = buildShapeReview({ review: shapeReview([posted("I1", "should-fix"), posted("I2", "minor"), { ...posted("I3", "blocker"), verdict: "unsure" }]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.match(advice.body, /\*\*Recommendation: merge and fast-follow\.\*\* 1 should-fix issue can be fixed after the merge\. 1 more blocker or should-fix issue the judge couldn't settle is listed for a maintainer to weigh\./, "advice rests on what the judge held real");
});

test("a long review is made compact, then cut, and stays inside the size GitHub takes", () => {
  const long = (id: number): PostedIssue => ({ ...posted(`I${id}`, id % 3 ? "minor" : "should-fix", 40), failingCase: "x".repeat(1_400) });
  const compact = buildShapeReview({ review: shapeReview(Array.from({ length: 400 }, (_, index) => long(index + 1))), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.ok(compact.body.length <= BODY_LIMIT);
  assert.doesNotMatch(compact.body, /Case: x/, "the listed issues lost their text");
  assert.doesNotMatch(compact.body, /more issues, in the review's saved results/, "but none was cut");
  const titled = (id: number): PostedIssue => ({ ...long(id), title: `${"t".repeat(300)} ${id}` });
  const cut = buildShapeReview({ review: shapeReview(Array.from({ length: 2_000 }, (_, index) => titled(index + 1))), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.ok(cut.body.length <= BODY_LIMIT);
  assert.match(cut.body, /and \d+ more issues, in the review's saved results/);
  assert.ok(cut.body.endsWith("<!-- rev-engine-shape-review re-o.n-1-1 abcdef0123456789 -->\n<!-- rev-engine-prime -->"), "the markers come after any cut");
  const problems = shapeReview([], { problems: Array.from({ length: 3_000 }, (_, index) => `problem ${index} ${"p".repeat(200)}`) });
  const longProblems = buildShapeReview({ review: problems, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.ok(longProblems.body.length <= BODY_LIMIT && longProblems.body.endsWith("<!-- rev-engine-prime -->"), "lists the cut can't shorten still leave the markers");
});

test("the findings file gives each issue at its first place in a repository file", () => {
  const issue = { ...posted("I1", "minor"), places: [{ file: "change-text.md", line: 2 }, { file: "src/a.ts", line: 11 }] };
  assert.deepEqual(toFinding(issue, "p"), { file: "src/a.ts", start_line: 11, end_line: 11, message: "Issue I1. Cause: the cause. Consequence: the effect. Case: the case", producer: "p" });
});

test("a changed file is an unread spot when two finders name it and no issue cites it", () => {
  const unread = [{ finder: "A:x", unread: ["src/b.ts past line 300"] }, { finder: "B:x", unread: ["could not open src/b.ts"] }, { finder: "B:y", unread: ["src/a.ts"] }];
  assert.deepEqual(unreadSpots(["src/a.ts", "src/b.ts"], unread, new Set()), ["src/b.ts"]);
  assert.deepEqual(unreadSpots(["src/b.ts"], unread, new Set(["src/b.ts"])), []);
});

test("a failure stops the review for its reason, a refusal by its category alone, and at the limit as the limit", () => {
  const later = Date.now() + 3_600_000;
  assert.deepEqual(stopReasonOf(new ModelRefused(500, "cyber_policy"), later), { reason: "refused", category: "cyber_policy" });
  assert.deepEqual(stopReasonOf(new ModelUnavailable(502, "no usable credential"), later), { reason: "sol-unavailable" });
  assert.deepEqual(stopReasonOf(new Error("gpt-6.1-sol ran out of time before submitting"), later), { reason: "time" });
  assert.deepEqual(stopReasonOf(new ModelError(400, "bad request"), later), { reason: "failed" });
  // A call cut off at the review's limit looks unreachable, and is the limit; a refusal there is still a refusal.
  assert.deepEqual(stopReasonOf(new ModelUnavailable(502, "aborted"), Date.now() + 30_000), { reason: "time" });
  assert.deepEqual(stopReasonOf(new ModelRefused(500, "bio_policy"), Date.now()), { reason: "refused", category: "bio_policy" });
  assert.deepEqual(stopFor(new ModelRefused(500, "cyber_policy"), later, "a Sol call (all A:t1)"), { reason: "refused", category: "cyber_policy", detail: "a Sol call (all A:t1) was refused (cyber_policy)" });
});

test("a plan with no areas is repaired into one, and repaired names never collide", async () => {
  const empty = await repairPlan({ facts: [], note: "", areas: [] }, context({ "src/a.ts": 10 }));
  assert.deepEqual(empty.plan.areas.map((area) => [area.name, area.tasks.map((task) => task.id)]), [["all", ["whole-nolens"]]]);
  assert.match(empty.repairs[0]!, /had no areas/);
  const plan: Plan = { facts: [], note: "", areas: [
    { name: "area-2", files: ["src/a.ts"], questions: [], tasks: [{ id: "t2", slice: { kind: "files", files: ["src/a.ts"] }, lenses: [] }, { id: "bad id", slice: { kind: "files", files: ["src/a.ts"] }, lenses: [] }] },
    { name: "Bad Name", files: ["test/a.test.ts"], questions: [], tasks: [{ id: "t", slice: { kind: "tests", files: ["test/a.test.ts"] }, lenses: [] }] },
    { name: "rest", files: [], questions: [], tasks: [{ id: "r", slice: { kind: "files", files: ["missing.ts"] }, lenses: [] }] },
  ] };
  const { plan: repaired, repairs } = await repairPlan(plan, context({ "src/a.ts": 10, "test/a.test.ts": 10, "lib/b.ts": 10 }));
  // The plan's own "rest" kept nothing and was dropped, so the repair's area for the files left over can take the name.
  assert.deepEqual(repaired.areas.map((area) => area.name), ["area-2", "area-2-2", "rest"]);
  assert.deepEqual(repaired.areas[0]!.tasks.map((task) => task.id), ["t2", "t2-2"]);
  assert.ok(repairs.some((repair) => repair.includes("area rest was dropped")));
});

test("a quoted file name in the diff is mapped by its +++ line", () => {
  const quoted = `diff --git "a/my file.ts" "b/my file.ts"\nindex 1..2 100644\n--- "a/my file.ts"\n+++ "b/my file.ts"\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.deepEqual([...diffParts(quoted).lines], [["my file.ts", [1, 7]]]);
  const deleted = `diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\ndeleted file mode 100644\nindex 1..0\n--- "a/caf\\303\\251.ts"\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n`;
  assert.deepEqual([...diffParts(deleted).lines].map(([path]) => path), ["caf\\303\\251.ts"], "a deleted file is named by its --- line");
});

test("a text is numbered from its own first line, and an empty one has no line to cite", () => {
  assert.equal(numbered("\n\nfirst\nsecond\n\n"), "1: \n2: \n3: first\n4: second");
  assert.equal(numberedLines("\n\nfirst\nsecond\n\n"), 4);
  assert.equal(numbered("  \n"), "(none)");
  assert.equal(numberedLines(""), 0);
});

test("lockfiles, generated files and vendored directories are left to their source", () => {
  assert.ok(["npm-shrinkwrap.json", "bun.lockb", "bun.lock", "web/yarn.lock"].every(leftToSource), "every lockfile the dependencies job knows");
  assert.ok(leftToSource("package-lock.json") && leftToSource("dist/app.min.js") && leftToSource("vendor/lib/x.go") && leftToSource("src/third_party/y.c"));
  assert.ok(leftToSource("vendored/x.js") && leftToSource("lib/third-party/y.js"), "each vendored directory name");
  assert.ok(!leftToSource("src/vendors.ts") && !leftToSource("src/a.ts"));
});

test("once asked to hand in, a model reads nothing more, and a run that never submits ends", async () => {
  const read = (id: string): ChatMessage => ({ role: "assistant", content: null, contextTokens: 500, tool_calls: [{ id, type: "function", function: { name: "read_diff", arguments: "{}" } }] });
  const { chat, requests } = scripted([read("r1"), read("r2"), read("r3"), read("r4"), read("r5")]);
  const reads: string[] = [];
  const counting = { call: async (name: string) => { reads.push(name); return "{}"; } } as unknown as Workspace;
  await assert.rejects(runAgent({ chat, model: "m", system: "s", prompt: "p", workspace: counting, tools: [readTool], submit: doneTool, deadline: Date.now() + 600_000, maxTurns: 100, log: () => {}, contextBound: 100, handInTurns: 3 }), /did not submit in the 3 turns after it was asked to/);
  assert.equal(reads.length, 1, "only the read before the bound ran");
  assert.equal(requests.length, 4, "the first turn, then three requests once the ask is in, the one that carries it included");
  assert.match(requests[2]!.messages.at(-1)!.content ?? "", /reading has stopped; call done now/);

  // The reader passes no handInTurns: its reads are still answered after the ask, as on main.
  const reader = scripted([read("r1"), read("r2"), submit("done", { ok: 1 })]);
  const readerReads: string[] = [];
  const readerSpace = { call: async (name: string) => { readerReads.push(name); return "{}"; } } as unknown as Workspace;
  await runAgent({ chat: reader.chat, model: "m", system: "s", prompt: "p", workspace: readerSpace, tools: [readTool], submit: doneTool, deadline: Date.now() + 600_000, maxTurns: 100, log: () => {}, contextBound: 100 });
  assert.equal(readerReads.length, 2);
});

test("a reply with no usage is held to the bound by its conversation's size", async () => {
  const { chat, requests } = scripted([
    { role: "assistant", content: null, tool_calls: [{ id: "r1", type: "function", function: { name: "read_diff", arguments: "{}" } }] },
    submit("done", { ok: 1 }),
  ]);
  const report = { bounded: false };
  await runAgent({ chat, model: "m", system: "s", prompt: "p".repeat(3_000), workspace, tools: [readTool], submit: doneTool, deadline: Date.now() + 600_000, maxTurns: 10, log: () => {}, contextBound: 900, report });
  assert.equal(report.bounded, true);
  assert.equal(requests[1]!.forceTool, "done");
});

test("ModelUnavailable ends the run at once, and a tool that wasn't offered isn't run", async () => {
  const unavailable = scripted([new ModelUnavailable(502, "no seat")]);
  await assert.rejects(runAgent({ chat: unavailable.chat, model: "m", system: "s", prompt: "p", workspace, submit: doneTool, deadline: Date.now() + 600_000, maxTurns: 10, log: () => {} }), ModelUnavailable);
  assert.equal(unavailable.requests.length, 1, "it isn't asked for a submission");
  const reads: string[] = [];
  const counting = { call: async (name: string) => { reads.push(name); return "{}"; } } as unknown as Workspace;
  const logged: string[] = [];
  const { chat } = scripted([
    { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    submit("done", { ok: 1 }),
  ]);
  await runAgent({ chat, model: "m", system: "s", prompt: "p", workspace: counting, tools: [], submit: doneTool, deadline: Date.now() + 600_000, maxTurns: 10, log: (message) => logged.push(message) });
  assert.deepEqual(reads, []);
  assert.ok(logged.some((line) => line.includes("called read_file, which it wasn't offered")));
});

test("a posted review's mentions are made inert, outside code and addresses", () => {
  assert.equal(quietMentions("ask @octocat or @org/team"), "ask @\u200boctocat or @\u200borg/team");
  assert.equal(quietMentions("`@types/node` and ```\n@scope/pkg\n``` stay"), "`@types/node` and ```\n@scope/pkg\n``` stay");
  assert.equal(quietMentions("mail a@b.example, see node_modules/@scope/pkg"), "mail a@b.example, see node_modules/@scope/pkg");
  const parts = quietParts({ body: "(@someone)", comments: [{ path: "a", line: 1, side: "RIGHT", body: "@x said" }] });
  assert.deepEqual([parts.body, parts.comments[0]!.body], ["(@\u200bsomeone)", "@\u200bx said"]);
});

test("an empty grouping is asked of the large grouper, each at its own effort, and an untitled issue takes its first finding's claim", async () => {
  const findings = [finding("A:t[0]"), finding("B:t[0]")];
  const untitled = submit("submit_issues", { issues: [{ title: "", causes: ["c"], consequences: ["d"], members: ["A:t[0]", "B:t[0]"] }] });
  const { chat, requests } = scripted([submit("submit_issues", { issues: [] }), untitled, untitled]);
  const grouping = await groupFindings(findings, { chat, smallModel: "small", largeModel: "large", smallEffort: "max", largeEffort: "high", workspace, deadline: Date.now() + 60_000, log: () => {}, caller: "group" });
  assert.deepEqual(requests.map((request) => [request.model, request.effort]), [["small", "max"], ["large", "high"], ["large", "high"]], "an empty grouping is no grouping, and a titleless one is asked again");
  assert.equal(grouping.issues[0]!.title, "claim A:t[0]");
  assert.ok(grouping.problems.some((problem) => problem.includes("titled by the claim of their first finding")));
});

test("the judge is given the plan's facts, a repeat without its exception settled is asked again, and a failed call's reason is kept", async () => {
  const prior = { entries: [{ id: "P1", file: "src/a.ts", title: "old", decision: "wont_fix" as const, round: 1, source: "" }], omitted: 0 };
  const { chat, requests } = scripted([
    submit("submit_verdicts", { verdicts: [
      { issue: "I1", verdict: "real", severity: "minor", repeatOf: "P1" },
      { issue: "I2", verdict: "real", severity: "minor", repeatOf: "", exceptionHolds: false },
    ] }),
    new ModelError(529, "QUOTED PROVIDER TEXT"),
  ]);
  const judging = await judgeIssues(["I1", "I2"].map(issue), [finding("A:t[0]")], {
    chat, model: "opus", effort: "high", workspace: () => workspace, prior, change: { title: "T", description: "", commitMessages: "", facts: ["F1, from the docs"] },
    deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge",
  });
  const prompt = requests[0]!.messages[1]!.content ?? "";
  assert.match(prompt, /- F1, from the docs/);
  assert.match(prompt, /Otherwise set repeatOf to ''\./);
  assert.equal(requests[0]!.effort, "high");
  assert.match(requests[1]!.messages[1]!.content ?? "", /one for each issue: I1\./);
  assert.deepEqual(judging.verdicts.map((verdict) => verdict.issue), ["I2"]);
  assert.deepEqual(judging.unjudged, ["I1"]);
  assert.equal(judging.errors.length, 1);
  assert.equal(judging.errors[0], "ModelError, status 529", "a failed call is named by its class and status, never the provider's words");
});

test("a repeat whose exception doesn't hold is decided before, whatever its verdict word, and isn't asked again", async () => {
  const prior = { entries: [{ id: "P1", file: "src/a.ts", title: "old", decision: "wont_fix" as const, round: 1, source: "" }], omitted: 0 };
  const { chat, requests } = scripted([
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "decided", severity: "minor", repeatOf: "P1", exceptionHolds: false }] }),
  ]);
  const judging = await judgeIssues([issue("I1")], [finding("A:t[0]")], {
    chat, model: "opus", effort: "high", workspace: () => workspace, prior, change: { title: "T", description: "", commitMessages: "", facts: [] },
    deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge",
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(judging.unjudged, []);
  assert.deepEqual(judging.verdicts.map((verdict) => [verdict.issue, verdict.repeatOf]), [["I1", "P1"]]);
});

test("a grouping whose members are no finding's is no grouping, and goes to the large grouper", async () => {
  const findings = [finding("A:t[0]"), finding("B:t[0]")];
  const mangled = submit("submit_issues", { issues: [{ title: "t", causes: ["c"], consequences: ["d"], members: ["A:t[9]", "x"] }] });
  const good = submit("submit_issues", { issues: [{ title: "t", causes: ["c"], consequences: ["d"], members: ["A:t[0]", "B:t[0]"] }] });
  const { chat, requests } = scripted([mangled, good]);
  const grouping = await groupFindings(findings, { chat, smallModel: "small", largeModel: "large", smallEffort: "max", largeEffort: "high", workspace, deadline: Date.now() + 60_000, log: () => {}, caller: "group" });
  assert.deepEqual(requests.map((request) => request.model), ["small", "large"]);
  assert.deepEqual(grouping.issues.map((issue) => issue.findings), [["A:t[0]", "B:t[0]"]]);
});

test("a judge's verdict that isn't one of the three is no verdict, and its issue is asked again alone", async () => {
  const { chat, requests } = scripted([
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "probably", severity: "minor" }, { issue: "I2", verdict: "real", severity: "minor" }] }),
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "not-real", severity: "minor" }] }),
  ]);
  const judging = await judgeIssues(["I1", "I2"].map(issue), [finding("A:t[0]")], {
    chat, model: "opus", effort: "high", workspace: () => workspace, prior: { entries: [], omitted: 0 }, change: { title: "T", description: "", commitMessages: "", facts: [] },
    deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge",
  });
  assert.equal(requests.length, 2);
  assert.match(requests[1]!.messages[1]!.content ?? "", /one for each issue: I1\./);
  assert.deepEqual(judging.verdicts.map((verdict) => [verdict.issue, verdict.verdict]), [["I2", "real"], ["I1", "not-real"]]);
});

test("the severity check is told which issues the judge couldn't settle", () => {
  const prompt = severityPrompt([{ id: "I1", title: "t", causes: [], consequences: [], severity: "blocker", verdict: "unsure", why: "w" }, { id: "I2", title: "u", causes: [], consequences: [], severity: "minor", verdict: "real", why: "w" }]);
  assert.match(prompt, /The judge's verdict: unsure\. Its grade: blocker\./);
  assert.doesNotMatch(prompt, /confirmed each one/);
});

test("in a plan of several areas a state reader keeps to its area's files, and questions are sized by what they read", async () => {
  const state = taskBrief({ id: "s", slice: { kind: "state", state: "the counter." }, lenses: [] }, { ...change, areaFiles: ["src/a.ts"] }, lenses);
  assert.match(state, /This review reads one area of a larger change, its files src\/a\.ts: for src\/a\.ts, read_diff lines 1 to 9 show what changed in it\./);
  assert.match(state, /Find every place in the area's files, and in the code they touch, that creates/);
  const question = taskBrief({ id: "q1", slice: { kind: "question", question: "Q?" }, lenses: [] }, change, lenses);
  assert.match(question, /read_diff shows the whole change\. The question: Q\?/);
  const plan: Plan = { facts: [], note: "", areas: [{ name: "all", files: [], questions: ["Q?"], tasks: [{ id: "a", slice: { kind: "files", files: ["src/a.ts"] }, lenses: [] }] }] };
  assert.ok((await checkPlan(plan, context({ "src/a.ts": 100_000 }))).some((problem) => problem.includes("its questions are read over 100,000 characters")));
});

test("malformed findings are counted as dropped, and a real top-level a/ directory keeps its name", async () => {
  const call = { battery: "B", id: "t", tasks: [{ id: "t", slice: { kind: "whole" as const }, lenses: [] }] };
  const lines = async (path: string) => (path === "a/x.ts" || path === "y.ts" ? { lines: 5, base: false } : null);
  const { findings, dropped } = await checkedFindings([
    { places: [{ file: "a/x.ts", line: 2 }], kind: "code", claim: "c1", failingCase: "f", severity: "minor" },
    { places: [{ file: "b/y.ts", line: 2 }], kind: "code", claim: "c2", failingCase: "f", severity: "minor" },
    { places: [{ file: "y.ts", line: 1 }], kind: "code", claim: "", failingCase: "f", severity: "minor" },
    "not a finding",
  ], "B", call, lines);
  assert.deepEqual(findings.map((item) => item.places[0]!.file), ["a/x.ts", "y.ts"]);
  assert.equal(dropped, 2);
  assert.equal((await checkedFindings({ claim: "x" }, "B", call, lines)).dropped, 1, "a findings value that isn't a list");
});

test("a kept answer to no call of the plan is set aside, and an answer that can't be kept is still the run's", async () => {
  const haiku: Battery = { letter: "B", model: "haiku", effort: null, perCall: 1, contextTokens: 90_000, countdown: false };
  const stale = { battery: "B", call: "old", findings: [], unread: [], note: "", bounded: false, dropped: 0 };
  const { chat, requests } = scripted([submit("submit_findings", { findings: [], unread: [], note: "" })]);
  const logs: string[] = [];
  const outcome = await runFind({
    chat, batteries: [haiku], tasks: [{ id: "t", slice: { kind: "whole" }, lenses: [] }], change, lenses, workspace: () => workspace, placeLines: async () => null,
    deadline: Date.now() + 60_000, maxTurns: 4, log: (message) => logs.push(message), scope: "all", kept: [stale], onAnswer: async () => { throw new Error("disk full"); },
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(outcome.answers.map((answer) => answer.call), ["t"]);
  assert.deepEqual(outcome.failed, []);
  assert.ok(logs.some((message) => message.includes("couldn't be kept for a resume: disk full")));
});

test("a path is named only as a whole, not inside a longer one", () => {
  assert.ok(namesPath("could not read src/a.ts.", "src/a.ts"));
  assert.ok(namesPath("(src/a.ts:30)", "src/a.ts"));
  assert.ok(!namesPath("src/a.tsx past line 300", "src/a.ts"));
  assert.ok(!namesPath("src/a.ts.bak", "src/a.ts"));
  assert.ok(!namesPath("lib/src/a.ts", "src/a.ts"));
  const unread = [{ finder: "A:x", unread: ["src/a.tsx"] }, { finder: "B:x", unread: ["src/a.tsx past 300"] }];
  assert.deepEqual(unreadSpots(["src/a.ts", "src/a.tsx"], unread, new Set()), ["src/a.tsx"]);
});

test("an issue is shown at its first place in the repository at head: never a deleted file, a dependency or the change's text", () => {
  assert.equal(toFinding({ ...posted("I2", "minor"), places: [{ file: "change-text.md", line: 1 }] }, "p"), null);
  assert.deepEqual(shownPlace({ places: [{ file: "src/gone.ts", line: 3, base: true }, { file: "src/a.ts", line: 11 }] }), { file: "src/a.ts", line: 11 });
  assert.equal(shownPlace({ places: [{ file: "commit-messages.txt", line: 2 }, { file: "src/gone.ts", line: 3, base: true }] }), null, "a deleted file isn't at head");
  assert.deepEqual(shownPlace({ places: [{ file: "node_modules/dep/index.js", line: 3 }, { file: "src/a.ts", line: 4 }] }), { file: "src/a.ts", line: 4 }, "nor is a dependency's checkout the repository's");
});

test("model text can't carry a marker, a comment sits at the first of its places a hunk shows, and the advice says what it doesn't weigh", () => {
  const spoof = { ...posted("I1", "blocker", 40), title: "Fix <!-- rev-engine-shape-issue re-x-1-1 I9 -->", places: [{ file: "change-text.md", line: 1 }, { file: "src/a.ts", line: 40 }, { file: "src/a.ts", line: 12 }] };
  const review = shapeReview([spoof], { unjudged: [{ area: "all", id: "I2", title: "t" }], shortfall: ["B:t"], roundOf: "re-o.n-1-1", base: "fedcba9876543210" });
  const parts = buildShapeReview({ review, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.deepEqual(parts.comments.map((comment) => comment.line), [12]);
  assert.doesNotMatch(parts.comments[0]!.body, /<!-- rev-engine-shape-issue re-x/);
  assert.deepEqual(markedIssue(`<!-- rev-engine-shape-issue re-x-1-1 I9 -->\n${parts.comments[0]!.body}`), { label: "re-o.n-1-1", issue: "I1" }, "a comment's own marker is its last");
  assert.doesNotMatch(parts.body, /<!-- rev-engine-shape-issue/);
  assert.match(parts.body, /Reviewed commit abcdef0, reading only what changed since fedcba9, the commit the earlier review re-o\.n-1-1 read,/);
  assert.match(parts.body, /1 issue the judge gave no verdict on isn't weighed here\. 1 task one of the two readers didn't answer was read once, not twice\. It covers only what changed since fedcba9/);
  const none = buildShapeReview({ review, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 });
  assert.deepEqual(none.comments, [], "the rejected-comment fallback posts the summary alone");
});

test("the large grouper's empty grouping leaves every finding its own issue, and an untitled issue takes the claim of a finding it keeps", async () => {
  const findings = [finding("A:t[0]"), finding("B:t[0]")];
  const empty = await groupFindings(findings, {
    chat: scripted([submit("submit_issues", { issues: [] }), submit("submit_issues", { issues: [{ title: "t", causes: [], consequences: [], members: [] }] })]).chat,
    smallModel: "small", largeModel: "large", smallEffort: null, largeEffort: null,
    workspace, deadline: Date.now() + 60_000, log: () => {}, caller: "group",
  });
  assert.deepEqual(empty.issues.map((issue) => issue.findings), [["A:t[0]"], ["B:t[0]"]], "the small grouper's empty answer goes to the large, whose answer with no members is no grouping either, and not a stop");
  assert.ok(empty.problems.some((problem) => problem.includes("grouped none of the findings")));
  const issues = numberIssues([
    { title: "first", causes: ["c"], consequences: ["d"], members: ["A:t[0]"] },
    { title: "", causes: ["c"], consequences: ["d"], members: ["A:t[0]", "B:t[0]"] },
  ], findings);
  assert.equal(issues.find((issue) => issue.findings[0] === "B:t[0]")!.title, "claim B:t[0]", "the claim of the finding it keeps, not of one it lost");
});

test("a Sol failure is judged as of when it happened, its last turn's reserve counted as the limit", () => {
  // Looked at inside the limit's margin, as the review looks at its failures once every call has finished.
  const deadline = Date.now() + 60_000;
  const early = deadline - 30 * 60_000;
  assert.deepEqual(stopReasonOf(new ModelUnavailable(502, "no seat"), deadline, early), { reason: "sol-unavailable" }, "an early failure isn't the limit, however late it's looked at");
  assert.deepEqual(stopReasonOf(new ModelUnavailable(502, "aborted"), deadline, deadline - 10 * 60_000, 17 * 60_000), { reason: "time" });
  assert.deepEqual(stopReasonOf(new ModelError(400, "bad"), deadline, deadline - 60_000), { reason: "failed" }, "a request the API rejected fails, however near the limit");
  assert.deepEqual(stopReasonOf(new ModelError(408, "request timeout"), deadline, deadline - 60_000), { reason: "time" }, "a request timeout near the limit is the limit");
  assert.deepEqual(stopReasonOf(new ModelError(429, "slow down"), deadline, deadline - 60_000), { reason: "time" }, "a rate limit near the limit is the limit");
});

test("a refusal decides the stop over a failure a later run can get past, and that over any other", () => {
  const of = (reason: StopReason, call: string) => ({ call, why: { reason } });
  assert.equal(decidingFailure([of("failed", "a"), of("sol-unavailable", "b"), of("refused", "c"), of("time", "d")])!.call, "c");
  assert.equal(decidingFailure([of("failed", "a"), of("time", "b"), of("sol-unavailable", "c")])!.call, "b");
  assert.equal(decidingFailure([of("failed", "a")])!.call, "a");
  assert.equal(decidingFailure([]), undefined);
});

test("a cut never splits a surrogate pair, which GitHub would refuse", () => {
  assert.equal(cut("ab\u{1F600}cd", 3), "ab");
  assert.equal(cut("ab\u{1F600}cd", 4), "ab\u{1F600}");
  assert.equal(cut("abc", 2), "ab");
});

test("a several-area plan whose areas all drop, with every changed file left to its source, is read as one whole area", async () => {
  const plan: Plan = { facts: [], note: "", areas: [
    { name: "one", files: ["src/gone.ts"], questions: [], tasks: [{ id: "t", slice: { kind: "files", files: ["src/gone.ts"] }, lenses: [] }] },
    { name: "two", files: ["lib/gone.ts"], questions: ["Q?"], tasks: [{ id: "u", slice: { kind: "files", files: ["lib/gone.ts"] }, lenses: [] }] },
  ] };
  const { plan: repaired, repairs } = await repairPlan(plan, context({ "yarn.lock": 10 }));
  assert.deepEqual(repaired.areas.map((area) => [area.name, area.tasks.map((task) => [task.id, task.slice.kind])]), [["all", [["whole-nolens", "whole"]]]]);
  assert.match(repairs.at(-1)!, /no area named a file the change changes, so the whole change is read as one area/);
});

test("a kept plan is taken only when it is this review's and has an area to read", () => {
  const identity = { label: "re-o.r-1-1", base: "b", head: "h", rulesBase: "b" };
  const plan: Plan = { facts: [], note: "", areas: [{ name: "all", files: [], questions: [], tasks: [{ id: "t", slice: { kind: "whole" }, lenses: [] }] }] };
  const kept = { ...identity, plan, problems: [] };
  assert.equal(keptPlanOf(kept, identity), kept);
  assert.equal(keptPlanOf({ ...kept, plan: { ...plan, areas: [] } }, identity), null, "a plan with no area would review nothing");
  for (const field of ["label", "base", "head", "rulesBase"] as const) assert.equal(keptPlanOf({ ...kept, [field]: "other" }, identity), null, `another ${field}`);
  assert.equal(keptPlanOf({ ...kept, plan: { ...plan, areas: { length: 1 } as unknown as Plan["areas"] } }, identity), null, "areas that aren't a list");
  assert.equal(keptPlanOf(null, identity), null);
});

test("a cited path is kept as the file tools spell it, and one outside the checkout is no place", async () => {
  const call = { battery: "A", id: "t", tasks: [] };
  // Every path has lines here, so only the path check can drop a place.
  const asked: string[] = [];
  const lines = async (path: string) => (asked.push(path), { lines: 5, base: false });
  const { findings, dropped } = await checkedFindings([
    { places: [{ file: "src\\a.ts", line: 2 }], kind: "code", claim: "c1", failingCase: "f", severity: "minor" },
    { places: [{ file: "../src/a.ts", line: 2 }], kind: "code", claim: "c2", failingCase: "f", severity: "minor" },
    { places: [{ file: "/src/a.ts", line: 2 }], kind: "code", claim: "c3", failingCase: "f", severity: "minor" },
  ], "A", call, lines);
  assert.deepEqual(findings.map((item) => item.places[0]!.file), ["src/a.ts"]);
  assert.equal(dropped, 2);
  assert.deepEqual(asked, ["src/a.ts"], "a path outside the checkout is never looked up");
});

test("a review whose readers had no installed dependencies says so where it says what it couldn't read", () => {
  const without = buildShapeReview({ review: { ...shapeReview([posted("I1", "should-fix")]), withoutDependencies: true }, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.match(without.body, /The readers had no installed dependencies \(none to install, or none installed\), so a dependency's behaviour was known only from the repository's own text\.\n/);
  assert.doesNotMatch(without.body, /Every reader covered its part/);
  const with_ = buildShapeReview({ review: shapeReview([posted("I1", "should-fix")]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.doesNotMatch(with_.body, /no installed dependencies/);
  const ranges = buildShapeReview({ review: { ...shapeReview([posted("I1", "should-fix")]), dependenciesFromRanges: true }, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.match(ranges.body, /The head has no lockfile at its root, so its dependencies were installed from package\.json's version ranges/);
});

test("the readers are told where the dependencies came from by the marker the dependencies job leaves", async () => {
  const repo = makeTemp(joinPath(tempRoot(), "shape-around-"));
  writeTo(joinPath(repo, "package.json"), "{}");
  assert.deepEqual((({ installed, fromRanges }) => ({ installed, fromRanges }))(await surroundings(repo)), { installed: false, fromRanges: false });
  makeDir(joinPath(repo, "node_modules"));
  const locked = await surroundings(repo);
  assert.deepEqual([locked.installed, locked.fromRanges], [true, false]);
  assert.match(locked.text, /installed in node_modules, from its lockfile\./);
  writeTo(joinPath(repo, "node_modules", ".installed-from-ranges"), "");
  const ranged = await surroundings(repo);
  assert.deepEqual([ranged.installed, ranged.fromRanges], [true, true]);
  assert.match(ranged.text, /from its package\.json's version ranges, since it has no lockfile at its root/);
});

test("a comment too long for GitHub is cut, naming the artifact that holds it whole as code", () => {
  const body = shapeCommentBody({ ...posted("I1", "blocker"), failingCase: "x".repeat(30_000) }, shapeReview([]));
  assert.ok(body.length < 21_000);
  assert.match(body, /\.\.\. \(cut; the `rev-engine-shape-NUMBER-ROUND` artifact of this review's Actions run, named by the pull request and round, holds it whole\)/);
});
