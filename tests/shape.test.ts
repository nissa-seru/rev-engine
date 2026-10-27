import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.ts";
import { ModelError, ModelRefused, ModelUnavailable, type Chat, type ChatMessage, type ChatRequest } from "../src/llm.ts";
import { Workspace, type ReadRecord, type ToolDefinition } from "../src/tools.ts";
import { callPrompt, callsOf, checkedFindings, numbered, numberedLines, runFind, taskBrief, type Battery, type ChangeBrief, type FindAnswer } from "../src/shape/find.ts";
import { checkGrouping, groupFindings, numberIssues } from "../src/shape/group.ts";
import { judgeIssues, knownTexts, parseKnown, parseVerdicts, type JudgeVerdict, type Known } from "../src/shape/judge.ts";
import { checkPlan, parsePlan, repairPlan, type Lens, type Plan, type PlanContext } from "../src/shape/plan.ts";
import { assembleReview, outcomeLine, knownProblem, loadKnown, decidingFailure, diffHeaderPath, diffParts, keptAnswers, keptPlanOf, leftToSource, shownPlace, stopFor, stopReasonOf, surroundings, toFinding, unreadChanges, type PostedIssue, type StopReason } from "../src/shape/run.ts";
import { mkdirSync as makeDir, mkdtempSync as makeTemp, writeFileSync as writeTo } from "node:fs";
import { tmpdir as tempRoot } from "node:os";
import { join as joinPath } from "node:path";
import { settleSeverities, severityPrompt } from "../src/shape/severity.ts";
import { clause, entryHunks, type Finding, type Hunk, type Issue } from "../src/shape/types.ts";
import { buildShapeReview, BODY_LIMIT, cut, markedIssue, shapeCommentBody, shapeRecommendation, type ShapeReview } from "../action/shape.ts";
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

function context(chars: Record<string, number>, hunks: Map<string, Hunk[]> = new Map()): PlanContext {
  return {
    lensIds,
    diffChars: new Map(Object.entries(chars)),
    hunks,
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

/** A diff of one file, big.ts, in two hunks: one changing head lines 10–12 and one only removing, after head line 500. */
const TWO_HUNKS = `diff --git a/big.ts b/big.ts
index 1111111..2222222 100644
--- a/big.ts
+++ b/big.ts
@@ -10,2 +10,3 @@ first
 context
+${"a".repeat(60_000)}
 context
@@ -499,2 +500,0 @@ second
-${"b".repeat(60_000)}
-gone
`;

test("a file's hunks give the read_diff lines, the size and the head lines of each", () => {
  const parts = diffParts(TWO_HUNKS);
  const [first, second] = parts.hunks.get("big.ts")!;
  assert.deepEqual([first!.lines, first!.head, second!.lines, second!.head], [[5, 8], [10, 12], [9, 11], [500, 501]], "a hunk that only removes spans the lines around it");
  assert.equal(first!.chars + second!.chars, TWO_HUNKS.length - TWO_HUNKS.indexOf("@@"), "every line after the header is in one hunk");
  assert.deepEqual(diffParts("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3 +3 @@\n-o\n+n\n").hunks.get("x")![0]!.head, [3, 3], "a header without a count spans one line");
});

test("a slice of part of a file is measured by the hunks that reach into its lines, each once", async () => {
  const parts = diffParts(TWO_HUNKS);
  const plan = (files: string[]): Plan => ({ facts: [], note: "", areas: [{ name: "all", files: [], questions: [], tasks: [{ id: "t", slice: { kind: "files", files }, lenses: [] }] }] });
  const check = async (files: string[]) => (await checkPlan(plan(files), { ...context({ "big.ts": parts.chars.get("big.ts")! }, parts.hunks), headLines: async () => 600 })).filter((problem) => problem.includes("a reader can take"));
  assert.equal((await check(["big.ts"])).length, 1, "the whole file is past the limit");
  assert.deepEqual(await check(["big.ts:1-100"]), [], "its first hunk alone fits");
  assert.deepEqual(await check(["big.ts:400-600"]), [], "and so does its second");
  assert.deepEqual(await check(["big.ts:1-11", "big.ts:12-20"]), [], "two ranges in one hunk count it once");
  assert.equal((await check(["big.ts:1-100", "big.ts:400-600"])).length, 1, "both hunks are past the limit again");
  assert.equal((await check(["big.ts:11-11", "big.ts:400-600"])).length, 1, "a range that changes one line of a hunk counts the whole hunk");
  const one = diffParts(TWO_HUNKS.slice(0, TWO_HUNKS.indexOf("@@ -499")));
  const fits = await checkPlan(plan(["big.ts", "big.ts:1-100"]), { ...context({ "big.ts": one.chars.get("big.ts")! }, one.hunks), headLines: async () => 600 });
  assert.deepEqual(fits.filter((problem) => problem.includes("a reader can take")), [], "a range of a file the slice reads whole adds nothing");
  const unread = async (files: string[], kind: "files" | "tests" = "files") => {
    const given = plan(files);
    given.areas[0]!.tasks[0]!.slice = { kind, files };
    return (await checkPlan(given, { ...context({ "big.ts": parts.chars.get("big.ts")! }, parts.hunks), headLines: async () => 600 })).filter((problem) => problem.includes("no task's slice"));
  };
  assert.deepEqual(await unread(["big.ts:1-100"]), ["these changed files are in no task's slice, or only in ranges, which read a file only when they take every hunk that changes it (a file whose change has no hunk, such as a rename, needs a whole entry): big.ts"], "a range that leaves a hunk unread doesn't read the file");
  assert.deepEqual(await unread(["big.ts:1-100", "big.ts:400-600"]), [], "ranges that take every hunk do");
  assert.deepEqual(await unread(["big.ts"]), []);
  assert.deepEqual(await unread(["big.ts:1-100", "big.ts:400-600"], "tests"), [], "so do a tests slice's");
  assert.deepEqual(await unread(["big.ts:1-100"], "tests"), ["these changed files are in no task's slice, or only in ranges, which read a file only when they take every hunk that changes it (a file whose change has no hunk, such as a rename, needs a whole entry): big.ts"]);
  const renamed = plan(["moved.ts:1-5"]);
  renamed.areas[0]!.tasks[0]!.slice = { kind: "files", files: ["moved.ts:1-5"] };
  assert.deepEqual((await checkPlan(renamed, { ...context({ "moved.ts": 120 }), headLines: async () => 10 })).filter((problem) => problem.includes("no task's slice")), ["these changed files are in no task's slice, or only in ranges, which read a file only when they take every hunk that changes it (a file whose change has no hunk, such as a rename, needs a whole entry): moved.ts"], "a file whose change has no hunk is read by no range");
  // In a plan of several areas, an area's ranges are measured against its own files the same way.
  const areas: Plan = { facts: [], note: "", areas: [
    { name: "core", files: ["big.ts"], questions: [], tasks: [{ id: "t", slice: { kind: "files", files: ["big.ts:1-100"] }, lenses: [] }] },
    { name: "more", files: ["big.ts"], questions: [], tasks: [{ id: "u", slice: { kind: "tests", files: ["big.ts:1-100", "big.ts:400-600"] }, lenses: [] }] },
  ] };
  const ranged = (await checkPlan(areas, { ...context({ "big.ts": parts.chars.get("big.ts")! }, parts.hunks), headLines: async () => 600 })).filter((problem) => problem.includes("no task's slice"));
  assert.deepEqual(ranged, ["area core names files that are in no task's slice, or only in ranges, which read a file only when they take every hunk that changes it (a file whose change has no hunk, such as a rename, needs a whole entry): big.ts"]);
  const repaired = await repairPlan(plan(["big.ts:1-100"]), { ...context({ "big.ts": parts.chars.get("big.ts")! }, parts.hunks), headLines: async () => 600 });
  assert.deepEqual(repaired.plan.areas[0]!.tasks.at(-1)!.slice, { kind: "files", files: ["big.ts"] });
  assert.equal(repaired.repairs[0], "changed files that no task read, whole or by ranges taking every hunk that changes them, got a task of their own, with no lens: big.ts");
});

test("a plan's file entries are named as the diff names them, so a range of ./src/a.ts measures src/a.ts's hunks", async () => {
  const parsed = parsePlan({ areas: [{ name: "a", files: ["./src/a.ts", "lib/"], tasks: [{ id: "t", slice: { kind: "files", files: ["./src/a.ts:1-5", "src\\b.ts", "././c.ts"] }, lenses: [] }] }] });
  assert.deepEqual(parsed.areas[0]!.files, ["src/a.ts", "lib"]);
  assert.deepEqual(parsed.areas[0]!.tasks[0]!.slice.files, ["src/a.ts:1-5", "src/b.ts", "c.ts"]);
  const parts = diffParts(DIFF);
  const ranged = parsePlan({ areas: [{ name: "a", tasks: [{ id: "t", slice: { kind: "files", files: ["./src/a.ts:1-100", "./test/a.test.ts"] }, lenses: [] }] }] });
  const problems = await checkPlan(ranged, { ...context(Object.fromEntries(parts.chars), parts.hunks), headLines: async () => 100 });
  assert.deepEqual(problems.filter((problem) => problem.includes("no task's slice")), [], "the range takes src/a.ts's hunks, and the whole entry its file");
});

test("a range takes a hunk whose head lines it touches at either end", () => {
  const hunks = diffParts(TWO_HUNKS).hunks;
  const heads = (entry: string) => entryHunks(hunks, entry).map((hunk) => hunk.head);
  assert.deepEqual(heads("big.ts:12-20"), [[10, 12]], "its last line");
  assert.deepEqual(heads("big.ts:1-10"), [[10, 12]], "its first line");
  assert.deepEqual(heads("big.ts:13-499"), [], "the lines between the hunks");
  assert.deepEqual(heads("big.ts:501-501"), [[500, 501]]);
  assert.deepEqual(heads("big.ts"), [[10, 12], [500, 501]], "a whole file takes every hunk");
});

test("a reader of part of a file is pointed to the hunks that reach into it", () => {
  const two: ChangeBrief = { ...change, diffLines: diffParts(TWO_HUNKS).lines, hunks: diffParts(TWO_HUNKS).hunks };
  const brief = (file: string) => taskBrief({ id: "t", slice: { kind: "files", files: [file] }, lenses: [] }, two, lenses);
  assert.match(brief("big.ts"), /read_diff lines 1 to 11 show what changed in it/);
  assert.match(brief("big.ts:400-600"), /big\.ts \(lines 400–600\)\. read_diff lines 9 to 11 show the changes around those lines/);
  assert.match(brief("big.ts:1-600"), /read_diff lines 5 to 11 show the changes around those lines/);
  assert.match(brief("big.ts:100-200"), /no hunk of the diff reaches those lines/);
  const tests = (files: string[]) => taskBrief({ id: "t", slice: { kind: "tests", files }, lenses: [] }, two, lenses);
  assert.match(tests(["big.ts:400-600"]), /its tests are big\.ts \(lines 400–600\), and for big\.ts \(lines 400–600\), read_diff lines 9 to 11 show the changes around those lines\./, "a ranged tests slice is pointed to its hunks too");
  assert.match(tests(["big.ts"]), /its tests are big\.ts\. /, "a whole test file needs no pointer of its own");
  // Two ranges of one file in one slice: each pointer names its range, as the tests brief does.
  const both = taskBrief({ id: "t", slice: { kind: "files", files: ["big.ts:1-100", "big.ts:400-600"] }, lenses: [] }, two, lenses);
  assert.match(both, /for big\.ts \(lines 1–100\), read_diff lines 5 to 8 show the changes around those lines; for big\.ts \(lines 400–600\), read_diff lines 9 to 11/);
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
  assert.deepEqual([grouping.issues[1]!.causes, grouping.issues[1]!.consequences], [[], []], "a finding on its own states no cause or consequence beyond its claim and case");
  assert.deepEqual(requests[0]!.tools.map((tool) => tool.function.name), ["submit_issues"], "the grouper reads nothing");
});

/** What a real or unsure verdict must also say. */
const OWN = { origin: "change", security: false, text: "What goes wrong, by reading.", confirm: "Run the case." };
const issue = (id: string): Issue => ({ id, title: `title ${id}`, causes: ["c"], consequences: ["d"], findings: ["A:t[0]"], kind: "code", severity: "minor" });

test("verdicts are taken for asked issues once each, and a repeat of a decided finding is decided before", () => {
  const prior = { entries: [{ id: "P1", file: "src/a.ts", title: "old", decision: "wont_fix" as const, round: 1, source: "" }], omitted: 0 };
  const verdicts = parseVerdicts({ verdicts: [
    { issue: "I1", verdict: "real", severity: "should-fix", repeatOf: "P1", exceptionHolds: false, why: "w", evidence: [], confidence: "high", notRealKind: "" },
    { issue: "I1", verdict: "not-real" },
    { issue: "I2", verdict: "not-real", notRealKind: "cannot happen", severity: "minor", repeatOf: "P9" },
    { issue: "I3", verdict: "not-real", notRealKind: "because" },
    { issue: "I4", verdict: "real", severity: "huge", ...OWN },
    { issue: "I7", verdict: "real" },
  ] }, ["I1", "I2", "I3", "I4"].map(issue).map((one) => ({ ...one, severity: "should-fix" as const })), prior);
  assert.deepEqual(verdicts.map((verdict) => [verdict.issue, verdict.verdict, verdict.repeatOf]), [["I1", "decided-before", "P1"], ["I2", "not-real", undefined], ["I3", "not-real", undefined], ["I4", "real", undefined]]);
  assert.equal(verdicts[2]!.notRealKind, "unstated", "a kind nobody gave isn't filled in");
  assert.equal(verdicts[3]!.severity, "should-fix", "a grade the judge didn't give keeps the readers'");
});

test("an issue a judging call leaves out is asked again alone", async () => {
  const issues = ["I1", "I2", "I3"].map(issue);
  const { chat, requests } = scripted([
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "real", severity: "minor", ...OWN }, { issue: "", verdict: "real", ...OWN }] }),
    submit("submit_verdicts", { verdicts: [{ issue: "I2", verdict: "unsure", severity: "should-fix", ...OWN }] }),
    new Error("judge failed"),
  ]);
  const judging = await judgeIssues(issues, [finding("A:t[0]")], { chat, model: "opus", effort: "high", workspace: () => workspace, prior: null, change: { title: "T", description: "The body.", commitMessages: "commit abc", facts: [] }, deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge", known: null, dependencies: "", withoutDependencies: false, laterRound: false });
  assert.equal(requests.length, 3);
  assert.match(requests[0]!.messages[1]!.content ?? "", /<description>\n1: The body\.\n<\/description>/, "the judge reads the text it judges text issues against");
  assert.match(requests[0]!.messages[1]!.content ?? "", /should-fix: a real defect or gap, with a realistic trigger/, "and grades by the readers' definitions");
  assert.deepEqual(judging.verdicts.map((verdict) => verdict.issue), ["I1", "I2"]);
  assert.deepEqual(judging.unjudged, ["I3"]);
});

test("a verdict without its confirming run is asked again alone, and kept from that ask, so a real blocker isn't lost for the sentence", async () => {
  const { chat, requests } = scripted([
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "real", severity: "blocker", ...OWN, confirm: "" }, { issue: "I2", verdict: "real", severity: "minor", ...OWN }] }),
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "real", severity: "blocker", ...OWN, confirm: " " }] }),
  ]);
  const judging = await judgeIssues(["I1", "I2"].map(issue), [finding("A:t[0]")], { chat, model: "opus", effort: "high", workspace: () => workspace, prior: null, change: { title: "T", description: "", commitMessages: "", facts: [] }, deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge", known: null, dependencies: "", withoutDependencies: false, laterRound: false });
  assert.equal(requests.length, 2, "I1 is asked once more, alone");
  // Every real or unsure issue is asked for its run, a minor one too, in the brief and in the tool.
  assert.match(requests[0]!.messages[1]!.content ?? "", /- \*\*confirm:\*\* for a real or unsure issue, whatever its grade, since a later check may raise it, the run that would confirm it/);
  const verdictItems = requests[0]!.tools.find((tool) => tool.function.name === "submit_verdicts")!.function.parameters as { properties: { verdicts: { items: { properties: { confirm: { description: string } } } } } };
  assert.equal(verdictItems.properties.verdicts.items.properties.confirm.description, "For a real or unsure issue, whatever its grade: the run that would confirm it. '' otherwise.");
  assert.deepEqual(judging.verdicts.map((verdict) => [verdict.issue, verdict.verdict, verdict.confirm]), [["I2", "real", "Run the case."], ["I1", "real", ""]]);
  assert.deepEqual(judging.unjudged, []);
  assert.deepEqual(parseVerdicts({ verdicts: [{ issue: "I1", verdict: "real", severity: "blocker", ...OWN, confirm: "" }] }, [issue("I1")], null).map((verdict) => verdict.issue), [], "a batch's verdict needs its run");
  assert.deepEqual(parseVerdicts({ verdicts: [{ issue: "I1", verdict: "real", severity: "blocker", ...OWN, text: "", confirm: "" }] }, [issue("I1")], null, new Set(), false).map((verdict) => verdict.issue), [], "the alone ask still needs the other fields");
});

test("the severity check settles every grade it gives, and keeps the judge's for the rest", async () => {
  const graded = ["a", "b", "c"].map((id) => ({ id, title: id, causes: [], consequences: [], severity: "minor" as const, verdict: "real" as const, why: "" }));
  const { chat } = scripted([submit("submit_severities", { severities: [{ issue: "a", severity: "blocker" }, { issue: "b", severity: "nope" }] })]);
  const settled = await settleSeverities(graded, { chat, model: "opus", effort: "high", workspace, deadline: Date.now() + 60_000, log: () => {} });
  assert.deepEqual([...settled.severities], [["a", "blocker"], ["b", "minor"], ["c", "minor"]]);
  assert.match(settled.problem ?? "", /no grade for b, c/);
});

const sol: Battery = { letter: "A", model: "sol", effort: "xhigh", perCall: 2, contextTokens: 300_000, countdown: false };
const change: ChangeBrief = { diffLines: diffParts(DIFF).lines, hunks: diffParts(DIFF).hunks, title: "T", description: "D", commitMessages: "M", facts: ["F"], dependencies: "deps", roundNote: "", areaFiles: null };

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
  origin: "change", security: false, knownAt: "", reasonHolds: false, text: `What goes wrong for ${id}, by reading.`, confirm: `Run the case for ${id}.`, repeats: [],
});

function shapeReview(issues: PostedIssue[], extra: Partial<ShapeReview> = {}): ShapeReview {
  return {
    label: "re-o.n-1-1", head: "abcdef0123456789", models: { planner: "opus", batteryA: "sol", batteryB: "haiku", judge: "opus" }, issues,
    notReal: [], decided: [], unjudged: [], unreadChanges: { changed: 4, unread: 0, files: [] }, empty: [], shortfall: [], bounded: [], dropped: 0, problems: [], planNote: "", leftOut: [],
    base: "0123456789abcdef", roundOf: null, repo: "o/n", held: [], ...extra,
  };
}

test("a summary given the deep command ends by naming it, before the markers a later round reads, whatever it cut", () => {
  const onSol = "For a review with Sol in place of Terra as one of its two readers, a maintainer can comment `/review deep`.";
  const lines = (body: string) => body.split("\n").filter(Boolean);
  const given = buildShapeReview({ review: shapeReview([posted("I1", "blocker")]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10, deepCommand: "/review deep" }).body;
  assert.equal(lines(given).at(-3), onSol);
  assert.match(lines(given).at(-2)!, /^<!-- rev-engine-shape-review re-o\.n-1-1 abcdef0123456789 -->$/, "the review's own marker stays the last line but one");
  const cut = buildShapeReview({ review: shapeReview(Array.from({ length: 2_000 }, (_, index) => ({ ...posted(`I${index + 1}`, "minor"), title: `Issue ${index + 1} ${"t".repeat(200)}` }))), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10, deepCommand: "/review deep" }).body;
  assert.equal(lines(cut).at(-3), onSol, "and survives the summary's cut");
  assert.doesNotMatch(buildShapeReview({ review: shapeReview([posted("I1", "blocker")]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body, /in place of Terra/, "without the command, nothing is named");
});

test("the review comments on blockers and should-fix issues a hunk shows, and lists every issue by severity", () => {
  const review = shapeReview([posted("I1", "blocker"), posted("I2", "should-fix", 12, ["B"]), posted("I3", "should-fix", 40), posted("I4", "minor")], {
    shortfall: ["B:t2"], notReal: [{ area: "all", id: "I5", title: "Not it", notRealKind: "cannot happen", why: "guarded", places: [{ file: "src/a.ts", line: 1 }] }],
  });
  const parts = buildShapeReview({ review, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.deepEqual(parts.comments.map((comment) => comment.line), [11, 12], "I3's line is outside every hunk, and minor gets no comment");
  assert.equal(parts.comments[0]!.body.split("<!--")[0], "**Blocker. Issue I1.**\n\nWhat goes wrong for I1, by reading.\n\nTo confirm: Run the case for I1.\n\n", "a comment is the judge's text and the run that would confirm it, nothing more");
  const order = ["#### Blockers (1)", "#### Should fix (2)", "#### Minor (1)"].map((heading) => parts.body.indexOf(heading));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)), "grouped by severity, most severe first");
  assert.match(parts.body, /- \*\*Should fix\. Issue I3\.\*\* \[`src\/a\.ts:40`\]\(https:\/\/github\.com\/o\/n\/blob\/abcdef0123456789\/src\/a\.ts#L40\) What goes wrong for I3, by reading\. To confirm: Run the case for I3\./, "a listed issue links its place at the reviewed commit");
  assert.match(parts.body, /two readers on every task of it, sol and haiku \(haiku gave no answer on 1 task, which sol alone read\); their findings/, "a task only one reader read is counted, so two readers on every task isn't claimed for it");
  assert.doesNotMatch(parts.body, /B:t2|Found by/, "how the review went otherwise stays off the thread");
  assert.match(buildShapeReview({ review: shapeReview([posted("I1", "blocker")]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body, /two readers on every task of it, sol and haiku; their findings/);
  assert.doesNotMatch(parts.body, /Not it|not to be real|guarded/, "an issue the judge held not real isn't shown");
  assert.match(parts.body, /\*\*Recommendation: fix, then merge\.\*\* 1 blocker should be fixed first, and 2 should-fix issues fixed in this pull request or filed as an issue before merging\./);
  assert.match(parts.body, /Nothing was run, so each issue is a lead from reading, and each blocker or should-fix says the run that would confirm it\./);
  // Promised only when each one says it, in its comment or its entry listed whole.
  const promise = /says the run that would confirm it/;
  const without = buildShapeReview({ review: shapeReview([posted("I1", "blocker"), { ...posted("I2", "should-fix", 40), confirm: "" }]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body;
  assert.match(without, /Nothing was run, so each issue is a lead from reading\.\n/, "a should-fix the judge gave no run");
  const minorWithout = buildShapeReview({ review: shapeReview([posted("I1", "blocker"), { ...posted("I2", "minor"), confirm: "" }]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body;
  assert.match(minorWithout, promise, "a minor issue's run isn't promised");
  const baseWithout = buildShapeReview({ review: shapeReview([posted("I1", "blocker"), { ...posted("I2", "blocker"), origin: "base", confirm: "" }]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body;
  assert.doesNotMatch(baseWithout, promise, "nor when an existing code's blocker it lists has none: the sentence says each blocker");
  assert.doesNotMatch(buildShapeReview({ review: shapeReview([posted("I1", "minor")]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body, promise, "and not at all when no blocker or should-fix is listed");
  const earlier = posted("I1", "blocker");
  const repeated = buildShapeReview({ review: shapeReview([earlier]), hunks: parseHunks(DIFF), existing: [{ id: 5, path: "src/a.ts", line: 11, start_line: null, body: shapeCommentBody(earlier), html_url: "https://github.com/o/n/pull/1#discussion_r5" }], minSeverity: "medium", maxComments: 10 }).body;
  assert.doesNotMatch(repeated, promise, "an entry pointing at an earlier comment doesn't say it");
  const unsureAgain = buildShapeReview({ review: shapeReview([{ ...earlier, verdict: "unsure" }]), hunks: parseHunks(DIFF), existing: [{ id: 5, path: "src/a.ts", line: 11, start_line: null, body: shapeCommentBody(earlier), html_url: "https://github.com/o/n/pull/1#discussion_r5" }], minSeverity: "medium", maxComments: 10 }).body;
  assert.match(unsureAgain, /Already raised in \[this comment\]\([^)]+\)\. The judge couldn't settle it from the code/, "a repeat still says the judge couldn't settle it");
  const advice = buildShapeReview({ review: shapeReview([posted("I1", "should-fix"), posted("I2", "minor"), { ...posted("I3", "blocker"), verdict: "unsure" }]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.match(advice.body, /\*\*Recommendation: fix here or file an issue for each, then merge\.\*\* 1 should-fix issue should be fixed in this pull request or filed as an issue before merging\. 1 more blocker or should-fix issue the judge couldn't settle is listed for a maintainer to weigh\./, "advice rests on what the judge held real");
  assert.doesNotMatch(advice.body, /fast-follow/);
});

test("a long review is made compact, then cut, and stays inside the size GitHub takes", () => {
  const long = (id: number): PostedIssue => ({ ...posted(`I${id}`, id % 3 ? "minor" : "should-fix", 40), text: "x".repeat(1_400) });
  const compact = buildShapeReview({ review: shapeReview(Array.from({ length: 400 }, (_, index) => long(index + 1))), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.ok(compact.body.length <= BODY_LIMIT);
  assert.doesNotMatch(compact.body, /x{100}/, "the listed issues lost their text");
  assert.doesNotMatch(compact.body, /more issues, in the run this review saved/, "but none was cut");
  assert.doesNotMatch(compact.body, /says the run that would confirm it/, "its compact should-fix entries don't say their runs, so they aren't promised");
  // Minor issues and existing code's are made compact first: the change's should-fix issues keep their text.
  const firstPass = buildShapeReview({ review: shapeReview([posted("I1", "should-fix", 40), ...Array.from({ length: 60 }, (_, index): PostedIssue => ({ ...long(index + 2), severity: "blocker", origin: "base" }))]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 });
  assert.match(firstPass.body, /Issue I1\.\*\* \[[^\n]+ What goes wrong for I1, by reading\. To confirm: Run the case for I1\./, "the should-fix keeps its text and run");
  assert.doesNotMatch(firstPass.body, /x{100}/, "while existing code's entries lost theirs");
  assert.doesNotMatch(firstPass.body, /says the run that would confirm it/, "so their runs aren't promised");
  const titled = (id: number): PostedIssue => ({ ...long(id), title: `${"t".repeat(300)} ${id}` });
  const cut = buildShapeReview({ review: shapeReview(Array.from({ length: 2_000 }, (_, index) => titled(index + 1))), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.ok(cut.body.length <= BODY_LIMIT);
  assert.match(cut.body, /and \d+ more issues, in the run this review saved, sealed with this review's model key\./);
  assert.ok(cut.body.endsWith("<!-- rev-engine-shape-review re-o.n-1-1 abcdef0123456789 -->\n<!-- rev-engine-prime -->"), "the markers come after any cut");
});

test("an issue already named keeps where it was named when its entry is compact or its text is cut", () => {
  const filed = { ...posted("I1", "should-fix"), knownAt: "https://github.com/o/n/issues/7", text: "y".repeat(5_000) };
  const full = buildShapeReview({ review: shapeReview([filed]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.match(full.body, /y{100}[^\n]*Already raised in \[#7\]\(https:\/\/github\.com\/o\/n\/issues\/7\)\./, "after a text cut to its length");
  const many = Array.from({ length: 400 }, (_, index): PostedIssue => ({ ...posted(`I${index + 2}`, "should-fix", 40), text: "x".repeat(1_400) }));
  const compact = buildShapeReview({ review: shapeReview([{ ...filed, text: "short" }, ...many]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 });
  assert.doesNotMatch(compact.body, /x{100}/, "the entries are compact");
  assert.match(compact.body, /- \*\*Should fix\. Issue I1\.\*\* \[`src\/a\.ts:11`\]\([^)]+\) Already raised in \[#7\]\(https:\/\/github\.com\/o\/n\/issues\/7\)\./, "and the named one keeps its link");
});

test("an issue's title is one line in its entry and its comment's head", () => {
  const broken = { ...posted("I1", "should-fix"), title: "Two\nlines  of title." };
  const built = buildShapeReview({ review: shapeReview([broken]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.match(built.comments[0]!.body, /^\*\*Should fix\. Two lines of title\.\*\*/);
  const listed = buildShapeReview({ review: shapeReview([broken]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 }).body;
  assert.match(listed, /- \*\*Should fix\. Two lines of title\.\*\* /);
});

test("a compact entry with no comment to say it still says the judge couldn't settle it", () => {
  const many = Array.from({ length: 400 }, (_, index): PostedIssue => ({ ...posted(`I${index + 3}`, "should-fix", 40), text: "x".repeat(1_400) }));
  const unsure = { ...posted("I1", "should-fix"), verdict: "unsure" as const };
  const existing = { ...posted("I2", "blocker"), origin: "base" as const, verdict: "unsure" as const };
  const compact = buildShapeReview({ review: shapeReview([unsure, existing, ...many]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 });
  assert.doesNotMatch(compact.body, /x{100}/, "the entries are compact");
  assert.match(compact.body, /- \*\*Should fix\. Issue I1\.\*\* \[`src\/a\.ts:11`\]\([^)]+\) The judge couldn't settle it from the code, so it is listed for a maintainer to weigh\./);
  assert.match(compact.body, /- \*\*Blocker\. Issue I2\.\*\* \[`src\/a\.ts:11`\]\([^)]+\) The judge couldn't settle it from the code/, "existing code's too, which never gets a comment");
  const linked = buildShapeReview({ review: shapeReview([unsure, existing, ...many]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }, ["https://github.com/o/n/pull/1#discussion_r9"]);
  assert.match(linked.body, /- \*\*Should fix\. \[Issue I1\]\(https:\/\/github\.com\/o\/n\/pull\/1#discussion_r9\)\.\*\* \[`src\/a\.ts:11`\]\([^)]+\)\n/, "one whose comment says it doesn't say it again");
});

test("how the review went stays in its saved results: no process note is posted", () => {
  const review = shapeReview([posted("I1", "should-fix")], {
    problems: ["Grouping: a problem note."], planNote: "The planner's note.", empty: ["A:empty-finder"], bounded: ["B:bounded-finder"], dropped: 3, leftOut: ["src/left-out.ts"],
    decided: [{ area: "all", id: "I9", title: "Decided before", repeatOf: "P1" }],
    notReal: [{ area: "all", id: "I8", title: "Not it", notRealKind: "cannot happen", why: "guarded", places: [] }],
    held: [{ ...posted("I7", "blocker"), title: "Held hole", origin: "base", security: true }],
  });
  const body = buildShapeReview({ review, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body;
  assert.doesNotMatch(body, /problem note|planner's note|empty-finder|bounded-finder|dropped|left-out\.ts|Decided before|P1|Not it|Held hole|I7|I8|I9/);
});

test("an issue with a comment links its title to it, and one an earlier comment raised links that comment", () => {
  const issue = posted("I1", "blocker");
  const existing = [{ id: 5, path: "src/a.ts", line: 11, start_line: null, body: shapeCommentBody(issue), html_url: "https://github.com/o/n/pull/1#discussion_r5" }];
  const again = buildShapeReview({ review: shapeReview([issue]), hunks: parseHunks(DIFF), existing, minSeverity: "medium", maxComments: 10 });
  assert.deepEqual(again.comments, [], "no second comment");
  assert.match(again.body, /- \*\*Blocker\. Issue I1\.\*\* \[`src\/a\.ts:11`\]\([^)]+\) Already raised in \[this comment\]\(https:\/\/github\.com\/o\/n\/pull\/1#discussion_r5\)\./);
  const settled = buildShapeReview({ review: shapeReview([issue]), hunks: parseHunks(DIFF), existing, settled: new Set([5]), minSeverity: "medium", maxComments: 10 });
  assert.equal(settled.comments.length, 1, "a settled earlier comment is no repeat");
  const linked = buildShapeReview({ review: shapeReview([issue]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }, ["https://github.com/o/n/pull/1#discussion_r6"]);
  assert.match(linked.body, /- \*\*Blocker\. \[Issue I1\]\(https:\/\/github\.com\/o\/n\/pull\/1#discussion_r6\)\.\*\* \[`src\/a\.ts:11`\]\([^)]+\)\n/, "listed by its title, linked to its comment, without its text");
});

test("a review too long in full is made compact for its minor and base issues first", () => {
  const minors = Array.from({ length: 400 }, (_, index): PostedIssue => ({ ...posted(`I${index + 2}`, "minor", 40), text: "x".repeat(1_400) }));
  const body = buildShapeReview({ review: shapeReview([{ ...posted("I1", "should-fix"), text: "The should-fix issue's own words." }, ...minors]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 }).body;
  assert.ok(body.length <= BODY_LIMIT);
  assert.doesNotMatch(body, /x{100}/, "the minor issues lost their text");
  assert.match(body, /The should-fix issue's own words\./, "the should-fix issue kept its own");
});

test("a place's path is escaped in its link", () => {
  const issue = { ...posted("I1", "should-fix"), places: [{ file: "src/a dir/b#c.ts", line: 3 }] };
  assert.match(buildShapeReview({ review: shapeReview([issue]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 }).body, /\[`src\/a dir\/b#c\.ts:3`\]\(https:\/\/github\.com\/o\/n\/blob\/abcdef0123456789\/src\/a%20dir\/b%23c\.ts#L3\)/);
});

test("permalinks point into the GitHub the review runs on", () => {
  const body = (server?: string) => buildShapeReview({ review: shapeReview([posted("I1", "should-fix", 40)]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0, ...(server === undefined ? {} : { server }) }).body;
  assert.match(body(), /\(https:\/\/github\.com\/o\/n\/blob\/abcdef0123456789\/src\/a\.ts#L40\)/);
  assert.match(body("https://git.example.com/"), /\(https:\/\/git\.example\.com\/o\/n\/blob\/abcdef0123456789\/src\/a\.ts#L40\)/);
});

test("the findings file gives each issue at its first place in a repository file", () => {
  const issue = { ...posted("I1", "minor"), places: [{ file: "change-text.md", line: 2 }, { file: "src/a.ts", line: 11 }] };
  assert.deepEqual(toFinding(issue, "p"), { file: "src/a.ts", start_line: 11, end_line: 11, message: "Issue I1. Cause: the cause. Consequence: the effect. Case: the case", producer: "p" });
});

test("a failure stops the review for its reason, a refusal by its category alone, and at the limit as the limit", () => {
  const later = Date.now() + 3_600_000;
  assert.deepEqual(stopReasonOf(new ModelRefused(500, "cyber_policy"), later), { reason: "refused", category: "cyber_policy" });
  assert.deepEqual(stopReasonOf(new ModelUnavailable(502, "no usable credential"), later), { reason: "unavailable" });
  assert.deepEqual(stopReasonOf(new Error("gpt-6.1-sol ran out of time before submitting"), later), { reason: "time" });
  assert.deepEqual(stopReasonOf(new ModelError(400, "bad request"), later), { reason: "failed" });
  // A provider's body that quotes the phrase decides nothing: the stop reads what told() says.
  assert.deepEqual(stopReasonOf(new ModelError(500, "model API returned 500: gpt-6.1-sol ran out of time before submitting"), later), { reason: "failed" });
  assert.deepEqual(stopReasonOf(new ModelUnavailable(503, "model API returned 503: ran out of time before submitting"), later), { reason: "unavailable" });
  // A call cut off at the review's limit looks unreachable, and is the limit; a refusal there is still a refusal.
  assert.deepEqual(stopReasonOf(new ModelUnavailable(502, "aborted"), Date.now() + 30_000), { reason: "time" });
  assert.deepEqual(stopReasonOf(new ModelRefused(500, "bio_policy"), Date.now()), { reason: "refused", category: "bio_policy" });
  assert.deepEqual(stopFor(new ModelRefused(500, "cyber_policy"), later, "a Sol call (all A:t1)"), { reason: "refused", category: "cyber_policy", detail: "a Sol call (all A:t1) was refused (cyber_policy)" });
});

test("no stage's log or stop carries a provider's error body, which can quote the request", async () => {
  const body = "model API returned 500: echoed request: held issue text";
  const failing = () => scripted([new ModelError(500, body), new ModelError(500, body), new ModelError(500, body)]).chat;
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const graded = ["a", "b"].map((id) => ({ id, title: id, causes: [], consequences: [], severity: "minor" as const, verdict: "real" as const, why: "" }));
  await settleSeverities(graded, { chat: failing(), model: "opus", effort: "high", workspace, deadline: Date.now() + 60_000, log });
  await groupFindings([finding("A:t[0]"), finding("B:t[0]")], { chat: failing(), smallModel: "small", largeModel: "large", smallEffort: "max", largeEffort: "high", workspace, deadline: Date.now() + 60_000, log, caller: "group" }).catch(() => null);
  const haiku: Battery = { letter: "B", model: "haiku", effort: null, perCall: 1, contextTokens: 90_000, countdown: false };
  await runFind({ chat: failing(), batteries: [haiku], tasks: [{ id: "t", slice: { kind: "whole" }, lenses: [] }], change, lenses, workspace: () => workspace, placeLines: async () => null, deadline: Date.now() + 60_000, maxTurns: 1, log, scope: "all", kept: [], onAnswer: async () => {} });
  const judging = await judgeIssues([issue("I1")], [finding("A:t[0]")], { chat: failing(), model: "opus", effort: "high", workspace: () => workspace, prior: null, change: { title: "T", description: "", commitMessages: "", facts: [] }, deadline: Date.now() + 60_000, maxTurns: 4, log, caller: "judge", known: null, dependencies: "", withoutDependencies: false, laterRound: false });
  assert.deepEqual(judging.errors, ["ModelError, status 500"], "the judge's kept reason, which the review's problems take");
  const stop = stopFor(new ModelError(500, body), Date.now() + 3_600_000, "the judge");
  assert.ok(logs.some((line) => line.includes("ModelError, status 500")), logs.join("\n"));
  assert.ok(logs.filter((line) => line.includes("ModelError, status 500")).length >= 4, "each stage said it failed");
  assert.ok(logs.some((line) => line.startsWith("judge I1 gave no verdicts: ModelError, status 500")), "the judge's own line");
  assert.ok(!logs.some((line) => line.includes("held issue text")), logs.join("\n"));
  assert.equal(stop.detail, "the judge failed: ModelError, status 500");
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
  assert.deepEqual([...diffParts(deleted).lines].map(([path]) => path), ["café.ts"], "a deleted file is named by its --- line, its quoted name decoded as the file tools spell it");
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
  assert.ok(logged.some((line) => line.endsWith(": 1 unoffered")), "counted, and not named, since its name is the model's text");
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
      { issue: "I1", verdict: "real", severity: "minor", repeatOf: "P1", ...OWN },
      { issue: "I2", verdict: "real", severity: "minor", repeatOf: "", exceptionHolds: false, ...OWN },
    ] }),
    new ModelError(529, "QUOTED PROVIDER TEXT"),
  ]);
  const judging = await judgeIssues(["I1", "I2"].map(issue), [finding("A:t[0]")], {
    chat, model: "opus", effort: "high", workspace: () => workspace, prior, change: { title: "T", description: "", commitMessages: "", facts: ["F1, from the docs"] },
    deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge", known: null, dependencies: "", withoutDependencies: false, laterRound: false,
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
    deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge", known: null, dependencies: "", withoutDependencies: false, laterRound: false,
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
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "probably", severity: "minor" }, { issue: "I2", verdict: "real", severity: "minor", ...OWN }] }),
    submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "not-real", severity: "minor" }] }),
  ]);
  const judging = await judgeIssues(["I1", "I2"].map(issue), [finding("A:t[0]")], {
    chat, model: "opus", effort: "high", workspace: () => workspace, prior: { entries: [], omitted: 0 }, change: { title: "T", description: "", commitMessages: "", facts: [] },
    deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge", known: null, dependencies: "", withoutDependencies: false, laterRound: false,
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
  const stale = { battery: "B", call: "old", findings: [], unread: [], note: "", bounded: false, dropped: 0, reads: [] };
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
  assert.deepEqual(markedIssue(parts.comments[0]!.body.replaceAll("\n", "\r\n")), { label: "re-o.n-1-1", issue: "I1" }, "with the line ends GitHub may give back");
  // Another review's comment that quotes a marker, on a line of its own or inside one, names no issue.
  assert.equal(markedIssue("A reader comment quoting\n<!-- rev-engine-shape-issue re-x-1-1 I9 -->\nand going on.\n<!-- rev-engine-prime -->"), null);
  assert.equal(markedIssue("A reader comment, then <!-- rev-engine-shape-issue re-x-1-1 I9 --> in a line\n<!-- rev-engine-prime -->"), null);
  assert.doesNotMatch(parts.body, /<!-- rev-engine-shape-issue/);
  assert.match(parts.body, /Reviewed commit abcdef0, reading only what changed since fedcba9, the commit the earlier review re-o\.n-1-1 read,/);
  assert.match(parts.body, /1 issue the judge gave no verdict on isn't weighed here\. It covers only what changed since fedcba9/);
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

test("a battery A failure is judged as of when it happened, its last turn's reserve counted as the limit", () => {
  // Looked at inside the limit's margin, as the review looks at its failures once every call has finished.
  const deadline = Date.now() + 60_000;
  const early = deadline - 30 * 60_000;
  assert.deepEqual(stopReasonOf(new ModelUnavailable(502, "no seat"), deadline, early), { reason: "unavailable" }, "an early failure isn't the limit, however late it's looked at");
  assert.deepEqual(stopReasonOf(new ModelUnavailable(502, "aborted"), deadline, deadline - 10 * 60_000, 17 * 60_000), { reason: "time" });
  assert.deepEqual(stopReasonOf(new ModelError(400, "bad"), deadline, deadline - 60_000), { reason: "failed" }, "a request the API rejected fails, however near the limit");
  assert.deepEqual(stopReasonOf(new ModelError(408, "request timeout"), deadline, deadline - 60_000), { reason: "time" }, "a request timeout near the limit is the limit");
  assert.deepEqual(stopReasonOf(new ModelError(429, "slow down"), deadline, deadline - 60_000), { reason: "time" }, "a rate limit near the limit is the limit");
});

test("a refusal decides the stop over a failure a later run can get past, and that over any other", () => {
  const of = (reason: StopReason, call: string) => ({ call, why: { reason } });
  assert.equal(decidingFailure([of("failed", "a"), of("unavailable", "b"), of("refused", "c"), of("time", "d")])!.call, "c");
  assert.equal(decidingFailure([of("failed", "a"), of("time", "b"), of("unavailable", "c")])!.call, "b");
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
  const identity = { label: "re-o.r-1-1", base: "b", head: "h", rulesBase: "b", batteryA: "gpt-6.1-terra" };
  const plan: Plan = { facts: [], note: "", areas: [{ name: "all", files: [], questions: [], tasks: [{ id: "t", slice: { kind: "whole" }, lenses: [] }] }] };
  const kept = { ...identity, plan, problems: [] };
  assert.equal(keptPlanOf(kept, identity), kept);
  assert.equal(keptPlanOf({ ...kept, plan: { ...plan, areas: [] } }, identity), null, "a plan with no area would review nothing");
  for (const field of ["label", "base", "head", "rulesBase", "batteryA"] as const) assert.equal(keptPlanOf({ ...kept, [field]: "other" }, identity), null, `another ${field}`);
  assert.equal(keptPlanOf({ ...kept, batteryA: undefined }, identity), null, "a plan kept before battery A's model was named");
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
  assert.match(without.body, /changed line of the change \(4 in all\)\. A line counts when[^\n]*\. The readers had no installed dependencies \(none to install, or none installed or placed\), so a dependency's behaviour was known only from the repository's own text\.\n/);
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

test("an issue's text and its run end with one full stop, a minor issue has no run, and the findings file keeps cause and consequence", () => {
  const stopped = shapeCommentBody({ ...posted("I1", "blocker"), text: "It fails at src/a.ts:11 ", confirm: "run the case." });
  assert.match(stopped, /\*\*Blocker\. Issue I1\.\*\*\n\nIt fails at src\/a\.ts:11\.\n\nTo confirm: run the case\.\n\n<!--/);
  const minor = shapeCommentBody({ ...posted("I2", "minor"), confirm: "a run nobody needs" });
  assert.doesNotMatch(minor, /To confirm/, "a minor issue isn't a lead for a run");
  const unsure = shapeCommentBody({ ...posted("I3", "should-fix"), verdict: "unsure", knownAt: "description", reasonHolds: false });
  assert.match(unsure, /The judge couldn't settle it from the code, so it is listed for a maintainer to weigh\.\n\nNamed in this pull request's description or commit messages, and it still weighs in the recommendation: by reading, nothing there gives a reason for leaving it that holds\./);
  assert.equal(clause(["why it fails?"]), "why it fails?", "a question keeps its own mark");
  assert.equal(clause(["a,", "b:"]), "a; b.");
  assert.deepEqual(toFinding({ ...posted("I3", "minor"), causes: ["c."], consequences: [] }, "p")?.message, "Issue I3. Cause: c. Case: the case");
  assert.deepEqual(toFinding({ ...posted("I3", "minor"), causes: ["c1.", "c2"], consequences: ["d1;", "d2."] }, "p")?.message, "Issue I3. Cause: c1; c2. Consequence: d1; d2. Case: the case");
  const alonePrompt = severityPrompt([{ id: "I4", title: "t", verdict: "real", severity: "minor", causes: [], consequences: [], why: "w", failingCase: "the input that shows it" }]);
  assert.doesNotMatch(alonePrompt, /Causes:|Consequences:/);
  assert.match(alonePrompt, /Its case: the input that shows it/, "an issue of one finding keeps its case for the severity check");
  const grouped = severityPrompt([{ id: "I5", title: "t", verdict: "real", severity: "minor", causes: ["c1", "c2"], consequences: ["d"], why: "w", failingCase: "unused" }]);
  assert.match(grouped, /Causes: c1; c2\nConsequences: d\n/);
  assert.doesNotMatch(grouped, /Its case/, "an issue with consequences is graded on them, as before");
});

test("the shipped lenses each have their text and source, and speak to any project", async () => {
  const { readFile } = await import("node:fs/promises");
  const shipped = JSON.parse(await readFile(new URL("../src/shape/lenses.json", import.meta.url), "utf8")) as Record<string, Lens>;
  assert.ok(Object.keys(shipped).length >= 10);
  for (const [id, lens] of Object.entries(shipped)) {
    assert.ok(lens.title && lens.lookFor && lens.name && /^[0-9a-f]{40}$/.test(lens.blob), id);
    // A public reviewer reads others' code: its lenses don't speak of a household of their own, or of someone's consent.
    assert.doesNotMatch(`${lens.title}\n${lens.lookFor}`, /\bhouse('s)?\b|\bher consent\b/i, id);
  }
});

test("a comment too long for GitHub is cut, saying where it's kept whole", () => {
  const body = shapeCommentBody({ ...posted("I1", "blocker"), text: "x".repeat(30_000) });
  assert.ok(body.length < 21_000);
  assert.match(body, /\.\.\. \(cut; the run this review saved holds it whole, sealed with this review's model key\)\n\nTo confirm: Run the case for I1\./, "only the text is cut: the run it promises follows");
  // An entry listed whole cuts its text the same way, saying where it's whole, and keeps its run.
  const long = buildShapeReview({ review: shapeReview([{ ...posted("I2", "should-fix", 40), text: "y".repeat(5_000) }]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 }).body;
  assert.match(long, /y{1500}\.\.\. \(cut; the run this review saved holds it whole, sealed with this review's model key\) To confirm: Run the case for I2\./);
  assert.match(long, /says the run that would confirm it/);
});

const UNREAD_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,5 @@ function a() {",
  " context", // diff line 6: base 10, head 10
  "-old eleven", // 7: base 11
  "-old twelve", // 8: base 12
  "+new eleven", // 9: head 11
  "+new twelve", // 10: head 12
  "+new thirteen", // 11: head 13
  " context", // 12: base 13, head 14
  "@@ -40,2 +41,3 @@",
  " context", // 14: base 40, head 41
  "+++ an added line that reads like a header", // 15: head 42
  "--- a removed line that reads like a header", // 16: base 41
  "\\ No newline at end of file", // 17: neither side's line
  "+new last", // 18: head 43
  "diff --git a/old.ts b/new.ts",
  "similarity index 50%",
  "rename from old.ts",
  "rename to new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1,2 +1,2 @@",
  "-gone", // 26: old.ts at the base, line 1
  "+come", // 27: new.ts at head, line 1
  " same",
  "diff --git a/del.ts b/del.ts",
  "deleted file mode 100644",
  "index 3333333..0000000",
  "--- a/del.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-first", // 35: base 1
  "-second", // 36: base 2
  "",
].join("\n");

test("the changed lines no finder's read returned are found by file: added ones at head, removed ones at the base", () => {
  const unread = unreadChanges(UNREAD_DIFF, [
    { tool: "read_diff", lines: [9, 10] },
    { tool: "read_file", path: "src/a.ts", lines: [13, 13] },
    { tool: "read_file", path: "src/a.ts", lines: [43, 43] },
    { tool: "read_base_file", path: "src/a.ts", lines: [11, 11] },
    { tool: "search", query: "header", hits: [{ path: "src/a.ts", line: 42 }] },
    { tool: "read_base_file", path: "new.ts", lines: [1, 1] },
    { tool: "read_diff", lines: [35, 35] },
    { tool: "read_change_text", path: "change-text.md", lines: [1, 50] },
    { tool: "list_files", path: "" },
    { tool: "read_file", path: "src/a.ts" },
    // Head lines 12 and 41 are added and context lines; the base's 12 and 41 are removed lines a read at head never returned.
    { tool: "read_file", path: "src/a.ts", lines: [12, 12] },
    { tool: "read_file", path: "src/a.ts", lines: [41, 41] },
  ]);
  assert.deepEqual(unread, {
    changed: 12,
    unread: 7,
    files: [
      { path: "src/a.ts", added: [[42, 42]], removed: [[11, 12], [41, 41]] },
      { path: "new.ts", basePath: "old.ts", added: [[1, 1]], removed: [[1, 1]] },
      { path: "del.ts", added: [], removed: [[2, 2]] },
    ],
  }, "a search hit isn't a read, a read at the base or at head doesn't read a removed line, and the marker for a missing newline is no line");
  assert.deepEqual(unreadChanges(DIFF, []), { changed: 4, unread: 4, files: [{ path: "src/a.ts", added: [[11, 12]], removed: [] }, { path: "test/a.test.ts", added: [[1, 2]], removed: [] }] });
  assert.deepEqual(unreadChanges(DIFF, [{ tool: "read_diff", lines: [1, 400] }]), { changed: 4, unread: 0, files: [] }, "a read past the diff's end reads to its end");
  const moved = unreadChanges(UNREAD_DIFF, [{ tool: "read_diff", lines: [1, 25] }, { tool: "read_diff", lines: [27, 400] }, { tool: "read_base_file", path: "old.ts", lines: [1, 1] }]);
  assert.deepEqual(moved, { changed: 12, unread: 1, files: [{ path: "new.ts", basePath: "old.ts", added: [], removed: [[1, 1]] }] }, "a removed line is read only in the diff, not at the base, even under a moved file's old name");
  assert.deepEqual(unreadChanges(UNREAD_DIFF, [{ tool: "read_diff", lines: [1, 400] }]), { changed: 12, unread: 0, files: [] });
  // A repository file named as a change text is: git leaves out a hunk's count of one line.
  const named = "diff --git a/change-text.md b/change-text.md\nindex 1..2 100644\n--- a/change-text.md\n+++ b/change-text.md\n@@ -1 +1 @@\n-old\n+new\n";
  assert.deepEqual(unreadChanges(named, [{ tool: "read_change_text", path: "change-text.md", lines: [1, 5] }]), { changed: 2, unread: 2, files: [{ path: "change-text.md", added: [[1, 1]], removed: [[1, 1]] }] }, "reading the pull request's text reads none of a repository file of that name");
  assert.deepEqual(unreadChanges(named, [{ tool: "read_file", path: "change-text.md", lines: [1, 1] }]).unread, 1);
  // Git quotes a name holding a quote, a backslash or a tab, and writes them as escapes.
  const quoted = `diff --git "a/we\\"ird\\tname.ts" "b/we\\"ird\\tname.ts"\nindex 1..2 100644\n--- "a/we\\"ird\\tname.ts"\n+++ "b/we\\"ird\\tname.ts"\n@@ -1 +1 @@\n-old\n+new\n`;
  assert.deepEqual(unreadChanges(quoted, [{ tool: "read_file", path: 'we"ird\tname.ts', lines: [1, 1] }]), { changed: 2, unread: 1, files: [{ path: 'we"ird\tname.ts', added: [], removed: [[1, 1]] }] });
  // Without core.quotePath=false git writes a name past ASCII as octal bytes.
  const octal = `diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\nindex 1..2 100644\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1,2 @@\n one\n+two\n`;
  assert.deepEqual(unreadChanges(octal, [{ tool: "read_file", path: "café.ts", lines: [1, 2] }]), { changed: 1, unread: 0, files: [] });
});

test("a diff header's quoted path is decoded as git escapes it", () => {
  assert.equal(diffHeaderPath('"b/caf\\303\\251 \\"\\\\\\t.ts"'), 'b/café "\\\t.ts', "as a +++ line writes it after its four characters");
  assert.equal(diffHeaderPath("b/plain name.ts"), "b/plain name.ts");
  assert.equal(diffHeaderPath('"b/\u{1F600}.ts"'), "b/\u{1F600}.ts", "a character outside the basic plane passes whole");
  assert.equal(diffHeaderPath('"'), '"');
  assert.equal(diffHeaderPath('"b/\\a\\b\\n\\v\\f\\r"'), "b/\x07\b\n\v\f\r", "every escape git writes for a control character");
  // A name holding a space is written unquoted and followed by a tab; a space at its end is the name's own.
  assert.equal(diffHeaderPath("b/my file.ts\t"), "b/my file.ts");
  assert.equal(diffHeaderPath("b/notes \t"), "b/notes ");
  const spaced = "diff --git a/notes  b/notes \nindex 1..2 100644\n--- a/notes \t\n+++ b/notes \t\n@@ -1 +1 @@\n-a\n+b\n";
  assert.deepEqual(unreadChanges(spaced, [{ tool: "read_file", path: "notes ", lines: [1, 1] }]).files, [{ path: "notes ", added: [], removed: [[1, 1]] }]);
  const tabbed = `diff --git "a/t\\tab.ts" "b/t\\tab.ts"\nindex 1..2 100644\n--- "a/t\\tab.ts"\n+++ "b/t\\tab.ts"\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.deepEqual([...diffParts(tabbed).lines].map(([path]) => path), ["t\tab.ts"], "a modified file is named by its +++ line, decoded");
});

test("each finder's answer keeps what it read, and the change's text is read with a tool of its own rather than given in the prompt", async () => {
  const dir = makeTemp(joinPath(tempRoot(), "rep-find-"));
  writeTo(joinPath(dir, "diff.patch"), DIFF);
  const texts = { description: "D-first\nD-second", commitMessages: "M-one" };
  const given: unknown[] = [];
  const answers = joinPath(dir, "answers");
  makeDir(answers);
  const haiku: Battery = { letter: "B", model: "haiku", effort: null, perCall: 1, contextTokens: 90_000, countdown: true };
  const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
  const { chat, requests } = scripted([
    { role: "assistant", content: null, tool_calls: [toolCall("r1", "read_change_text", { which: "description", start_line: 1, line_count: 400 }), toolCall("r2", "read_diff", { start_line: 7, line_count: 1 })] },
    submit("submit_findings", { findings: [], unread: [], note: "" }),
  ]);
  const outcome = await runFind({
    chat, batteries: [haiku], tasks: [{ id: "t", slice: { kind: "whole" }, lenses: [] }], change: { ...change, ...texts }, lenses,
    workspace: (served) => (given.push(served), new Workspace(dir, joinPath(dir, "diff.patch"), "HEAD", served)), placeLines: async () => null,
    // Far enough off that the finder isn't already being asked to hand in, when it would read nothing.
    deadline: Date.now() + 3_600_000, maxTurns: 4, log: () => {}, scope: "all", kept: [],
    // As the shape keeps each answer for a resume.
    onAnswer: async (answer) => writeTo(joinPath(answers, `${answer.battery}-${answer.call}.json`), JSON.stringify(answer)),
  });
  assert.deepEqual(given, [texts], "the workspace serves the texts the brief gives the length of");
  assert.deepEqual(outcome.answers[0]!.reads, [{ tool: "read_change_text", path: "change-text.md", lines: [1, 2] }, { tool: "read_diff", lines: [7, 7] }]);
  assert.deepEqual(requests[0]!.tools.map((tool) => tool.function.name), ["read_diff", "read_file", "read_base_file", "list_files", "search", "read_change_text", "submit_findings"]);
  const selector = requests[0]!.tools.find((tool) => tool.function.name === "read_change_text")!.function.parameters as { required: string[]; properties: { which: { enum: string[] } } };
  assert.deepEqual([selector.required, selector.properties.which.enum], [["which", "start_line", "line_count"], ["description", "commit-messages"]]);
  const prompt = String(requests[0]!.messages.find((message) => message.role === "user")?.content);
  assert.match(prompt, /Its description \(2 lines\) and commit messages \(1 line\) aren't files in the checkout: read them with read_change_text, and cite them as change-text\.md and commit-messages\.txt/);
  assert.doesNotMatch(prompt, /D-first|M-one/, "the texts themselves aren't in the prompt");
  const served = requests[1]!.messages.find((message) => message.role === "tool" && message.tool_call_id === "r1");
  assert.match(String(served?.content), /1: D-first\\n2: D-second/, "the tool returned the description, numbered as it's cited");
  const resumed = await keptAnswers(dir, () => {});
  assert.deepEqual(resumed.map((answer) => answer.reads), [outcome.answers[0]!.reads], "a kept answer comes back with its reads");
  assert.deepEqual(unreadChanges(DIFF, resumed.flatMap((answer) => answer.reads)).unread, 3, "a kept answer's read of the diff counts, and its read of the change's text reads no changed line");
});

test("each call's answer keeps its own reads, and a call that reads and then fails leaves its reads in no answer", async () => {
  const dir = makeTemp(joinPath(tempRoot(), "rep-two-"));
  writeTo(joinPath(dir, "diff.patch"), DIFF);
  const haiku: Battery = { letter: "B", model: "haiku", effort: null, perCall: 1, contextTokens: 90_000, countdown: true };
  const read = (start: number): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id: `r${start}`, type: "function", function: { name: "read_diff", arguments: JSON.stringify({ start_line: start, line_count: 1 }) } }] });
  // Each call's conversation has its own script, whichever order the calls run in.
  const scripts: Record<string, Array<ChatMessage | Error>> = {
    "all B:a": [read(7), submit("submit_findings", { findings: [], unread: [], note: "" })],
    // A finder's failed turn ends its run with that error (onFailedTurn "throw"): it isn't asked again.
    "all B:b": [read(8), new ModelError(500, "the call failed after reading")],
  };
  const made: Workspace[] = [];
  const chat: Chat = async (request) => {
    const next = scripts[String(request.conversation)]!.shift()!;
    if (next instanceof Error) throw next;
    return next;
  };
  const outcome = await runFind({
    chat, batteries: [haiku], tasks: ["a", "b"].map((id) => ({ id, slice: { kind: "whole" as const }, lenses: [] })), change, lenses,
    workspace: (texts) => { const made_ = new Workspace(dir, joinPath(dir, "diff.patch"), "HEAD", texts); made.push(made_); return made_; }, placeLines: async () => null,
    deadline: Date.now() + 3_600_000, maxTurns: 4, log: () => {}, scope: "all", kept: [], onAnswer: async () => {},
  });
  assert.deepEqual(outcome.answers.map((answer) => [answer.call, answer.reads]), [["a", [{ tool: "read_diff", lines: [7, 7] }]]]);
  assert.deepEqual(outcome.failed.map((failure) => [failure.call, (failure.error as Error).message]), [["b", "the call failed after reading"]]);
  assert.deepEqual(made.map((workspace) => workspace.reads).sort((x, y) => x[0]!.lines![0] - y[0]!.lines![0]), [[{ tool: "read_diff", lines: [7, 7] }], [{ tool: "read_diff", lines: [8, 8] }]], "the failed call read line 8 in its own workspace before it failed");
});

test("a kept answer that holds no reads is asked again, as one that can't be read is", async () => {
  const dir = makeTemp(joinPath(tempRoot(), "rep-kept-"));
  makeDir(joinPath(dir, "answers"));
  const answer = { battery: "B", call: "t", findings: [], unread: [], note: "", bounded: false, dropped: 0 };
  writeTo(joinPath(dir, "answers", "B-t.json"), JSON.stringify(answer));
  writeTo(joinPath(dir, "answers", "B-u.json"), JSON.stringify({ ...answer, call: "u", reads: [{ tool: "read_diff", lines: [1, 2] }] }));
  writeTo(joinPath(dir, "answers", "B-v.json"), "{ not json");
  writeTo(joinPath(dir, "answers", "B-w.json"), JSON.stringify({ ...answer, call: "w", reads: [] }));
  const logs: string[] = [];
  const kept = await keptAnswers(dir, (message) => logs.push(message));
  assert.deepEqual(kept.map((item) => item.call), ["u", "w"], "an answer whose finder read nothing still says so");
  assert.ok(logs.some((message) => message.endsWith("B-t.json holds no reads, so its call is asked again")), logs.join("\n"));
  assert.ok(logs.some((message) => message.endsWith("B-v.json can't be read, so its call is asked again")), logs.join("\n"));
});

test("the review says which changed lines no reader's read returned, by file, in place of what each reader said it couldn't cover", () => {
  const files = [
    { path: "src/a.ts", added: [[42, 42]] as Array<[number, number]>, removed: [[12, 12], [41, 41]] as Array<[number, number]> },
    { path: "new.ts", basePath: "old.ts", added: [[1, 3]] as Array<[number, number]>, removed: [[1, 1]] as Array<[number, number]> },
    { path: "package-lock.json", added: [[5, 9]] as Array<[number, number]>, removed: [] },
  ];
  const build = (extra: Partial<ShapeReview>) => buildShapeReview({ review: shapeReview([posted("I1", "should-fix")], extra), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body;
  const some = build({ unreadChanges: { changed: 120, unread: 14, files: [...files, { path: "del.ts", added: [], removed: [[1, 2]] }] }, leftOut: ["package-lock.json"] });
  assert.match(some, /\n\n14 of the change's 120 changed lines weren't returned by any read of a reader that answered: `src\/a\.ts`: line 42; removed lines 12, 41 at the base; `new\.ts`: lines 1–3; removed line 1 of `old\.ts` at the base; `package-lock\.json`, which the plan left out of every area: lines 5–9; `del\.ts`: removed lines 1–2 at the base\. A line counts when a read by a reader that answered returned it whole: an added line from the diff or from its file, a removed line from the diff\. A search that matched it doesn't count\./);
  assert.match(build({ unreadChanges: { changed: 1, unread: 1, files: [{ path: "a.ts", added: [[3, 3]], removed: [] }] } }), /\n\n1 of the change's 1 changed line wasn't returned by any read of a reader that answered: `a\.ts`: line 3\./);
  assert.doesNotMatch(some, /couldn't cover|No reader read these changed files|Every reader covered/);
  assert.match(build({ unreadChanges: { changed: 120, unread: 0, files: [] } }), /that tried to refute each issue\. Nothing was run[^\n]*\n\nBetween them, the reads of the readers that answered returned every changed line of the change \(120 in all\)\./);
  assert.match(build({ unreadChanges: { changed: 0, unread: 0, files: [] } }), /\n\nThe change adds or removes no line of text\./);
  const many = Array.from({ length: 6_000 }, (_, index) => ({ path: `src/${"d".repeat(60)}/file-${index}.ts`, added: [[1, 2]] as Array<[number, number]>, removed: [] }));
  const cut = build({ unreadChanges: { changed: 20_000, unread: 12_000, files: many } });
  assert.ok(cut.length <= BODY_LIMIT);
  assert.match(cut, /; and \d+ more files\. A line counts when/, "a list too long for GitHub names the rest by their count");
});

test("the review's unread changes take every area's answers, of both batteries, together", () => {
  const answer = (battery: string, call: string, reads: ReadRecord[]): FindAnswer => ({ battery, call, findings: [], unread: [], note: "", bounded: false, dropped: 0, reads });
  const area = (name: string) => ({ name, files: [], tasks: [], questions: [] });
  const result = (name: string, answers: FindAnswer[]) => ({ area: area(name), answers, failed: [], grouping: { issues: [], problems: [] }, judging: { verdicts: [], unjudged: [] }, all: [] });
  const plan = { areas: [area("core"), area("tests")], facts: [], note: "" } as unknown as Plan;
  const review = assembleReview({ label: "re-o.n-1-1", round: 1, roundOf: null, outDir: "", keptDir: null }, "h", "b", { planner: "opus", batteryA: "sol", batteryB: "haiku", judge: "opus" }, [
    result("core", [answer("A", "x", [{ tool: "read_diff", lines: [7, 7] }]), answer("B", "x", [{ tool: "read_diff", lines: [8, 8] }])]),
    result("tests", [answer("B", "y", [{ tool: "read_file", path: "test/a.test.ts", lines: [1, 1] }])]),
  ], plan, [], ["src/a.ts", "test/a.test.ts"], (name, id) => `${name}/${id}`, DIFF);
  assert.deepEqual(review.unreadChanges, { changed: 4, unread: 1, files: [{ path: "test/a.test.ts", added: [[2, 2]], removed: [] }] });
});

test("a limit the change's own text names weighs in the advice only when no reason given there holds", () => {
  // The judge's answer means something only for an issue the change's own text names.
  const [named, linked] = parseVerdicts({ verdicts: [
    { issue: "I1", verdict: "real", severity: "should-fix", ...OWN, knownAt: "description", reasonHolds: true },
    { issue: "I2", verdict: "real", severity: "should-fix", ...OWN, knownAt: "https://github.com/o/n/issues/7", reasonHolds: true },
  ] }, [issue("I1"), issue("I2")], null, new Set(["https://github.com/o/n/issues/7"]));
  assert.deepEqual([named!.reasonHolds, linked!.reasonHolds], [true, false]);
  const left = { ...posted("I1", "should-fix"), knownAt: "description", reasonHolds: true };
  const weighs = { ...posted("I1", "should-fix"), knownAt: "description", reasonHolds: false };
  assert.equal(shapeRecommendation({ issues: [left], unjudged: [], roundOf: null, base: "b".repeat(40) }), "**Recommendation: merge.** The review found no other blocker or should-fix issue in the change that its judge held real. 1 more blocker or should-fix issue the description or commit messages name, with a reason for leaving it that holds, is listed apart and doesn't weigh here.", "a named limit whose reason holds is the author's call, and the advice says it's there");
  assert.match(shapeRecommendation({ issues: [weighs], unjudged: [], roundOf: null, base: "b".repeat(40) }), /^\*\*Recommendation: fix here or file an issue for each, then merge\.\*\* 1 should-fix issue/, "one with no reason that holds still weighs");
  assert.match(shapeRecommendation({ issues: [left, { ...posted("I2", "should-fix") }], unjudged: [], roundOf: null, base: "b".repeat(40) }), / 1 should-fix issue should be/, "and only the other counts");
  const body = buildShapeReview({ review: shapeReview([left]), hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body;
  assert.match(body, /Named in this pull request's description or commit messages, with a reason for leaving it that holds by reading, so it doesn't weigh in the recommendation\./, "the review says which, beside the issue");
  assert.match(body, /#### Named in this pull request \(1\)\n\n<details>\n<summary>1 issue the description or commit messages name, with a reason for leaving it that holds by reading, which doesn't weigh in the recommendation<\/summary>/, "listed apart, as information");
  assert.doesNotMatch(body, /#### Should fix/, "not among the should-fix issues the advice counts");
  assert.match(shapeCommentBody({ ...posted("I3", "minor"), knownAt: "description" }), /\n\nNamed in this pull request's description or commit messages\.\n/, "a minor issue, which never weighs, isn't said to weigh still");
  const { reasonHolds: _, ...unanswered } = { ...posted("I5", "should-fix"), knownAt: "description" };
  assert.match(shapeCommentBody(unanswered), /\n\nNamed in this pull request's description or commit messages\.\n/, "nor is one from a review saved before the judge answered");
  assert.match(shapeCommentBody({ ...posted("I4", "should-fix"), origin: "base", knownAt: "description", reasonHolds: true }), /\n\nNamed in this pull request's description or commit messages\.\n/, "nor is existing code's");
  assert.match(body, /Besides those this pull request names itself, below, the review found no issue in the change/);
});

test("a posted verdict without its origin, security answer, text or confirming run is asked again, and knownAt names only the description or an indexed URL", () => {
  const indexed = "https://github.com/o/n/issues/7";
  const verdicts = parseVerdicts({ verdicts: [
    { issue: "I1", verdict: "real", severity: "minor", ...OWN, origin: "elsewhere" },
    { issue: "I2", verdict: "unsure", severity: "minor", ...OWN, security: "yes" },
    { issue: "I3", verdict: "real", severity: "minor", ...OWN, text: "  " },
    { issue: "I4", verdict: "not-real", notRealKind: "asks what the project doesn't promise", text: "ignored", confirm: "ignored" },
    { issue: "I5", verdict: "real", severity: " blocker ", ...OWN, origin: "base", security: true, knownAt: ` ${indexed} `, confirm: " run it " },
    { issue: "I6", verdict: "real", severity: "minor", ...OWN, knownAt: "https://elsewhere.example/x" },
    { issue: "I7", verdict: "real", severity: "minor", ...OWN, knownAt: "description" },
    { issue: "I8", verdict: "unsure", severity: "minor", ...OWN, confirm: " " },
    { issue: "I9", verdict: " real ", severity: "minor", ...OWN, origin: " base", security: true, confidence: " high" },
    { issue: "I10", verdict: "not-real ", notRealKind: " asks what the project doesn't promise" },
  ] }, ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10"].map(issue), null, new Set([indexed]));
  assert.deepEqual(verdicts.map((verdict) => verdict.issue), ["I4", "I5", "I6", "I7", "I9", "I10"], "I1-I3 and I8 are asked again: a minor needs its run too, since a later check may raise it");
  assert.deepEqual([verdicts[4]!.verdict, verdicts[4]!.origin, verdicts[4]!.confidence], ["real", "base", "high"], "a verdict, an origin and a confidence with spaces round them are read, so a security issue placed in the base is held");
  assert.deepEqual([verdicts[5]!.verdict, verdicts[5]!.notRealKind], ["not-real", "asks what the project doesn't promise"]);
  assert.deepEqual([verdicts[0]!.notRealKind, verdicts[0]!.text, verdicts[0]!.confirm], ["asks what the project doesn't promise", "", ""], "a not-real verdict needs none of them, and posts no text");
  assert.deepEqual([verdicts[1]!.origin, verdicts[1]!.security, verdicts[1]!.knownAt, verdicts[1]!.confirm, verdicts[1]!.text, verdicts[1]!.severity], ["base", true, indexed, "run it", "What goes wrong, by reading.", "blocker"], "a grade with spaces round it is read, not the readers' minor");
  assert.equal(verdicts[2]!.knownAt, "", "a URL the index didn't give names nothing");
  assert.equal(verdicts[3]!.knownAt, "description");
});

const KNOWN: Known = {
  thread: [{ kind: "review", author: "ann", url: "https://github.com/o/n/pull/1#pullrequestreview-9", body: "\nFirst line of it\nsecond\n" }],
  issues: [{ number: 7, title: "Crash on empty", url: "https://github.com/o/n/issues/7", body: "steps" }, { number: 8, title: "t8", url: "https://github.com/o/n/issues/8", body: "" }],
  more: true,
  issuesError: "",
};

test("the thread and open issues are served numbered as the judge's index places them, and searched", async () => {
  const { texts, index, urls } = knownTexts(KNOWN);
  assert.match(index, /The thread \(1 item, read_known which thread\):\n- line 1: review by ann, https:\/\/github\.com\/o\/n\/pull\/1#pullrequestreview-9: First line of it\n/);
  assert.match(index, /The open issues \(2, the newest; there are more, which you aren't shown, read_known which issues\):\n- line 1: #7 Crash on empty, https:\/\/github\.com\/o\/n\/issues\/7\n- line 4: #8 t8, https:\/\/github\.com\/o\/n\/issues\/8$/);
  assert.deepEqual([...urls], [KNOWN.thread[0]!.url, KNOWN.issues[0]!.url, KNOWN.issues[1]!.url]);
  const space = new Workspace("/tmp", "/dev/null", "HEAD", null, texts);
  const read = JSON.parse(await space.call("read_known", JSON.stringify({ which: "issues", start_line: 4, line_count: 1 }))) as { content: string };
  assert.equal(read.content, "4: === #8: t8, https://github.com/o/n/issues/8");
  const thread = JSON.parse(await space.call("read_known", JSON.stringify({ which: "thread", start_line: 1, line_count: 5 }))) as { content: string; total_lines: number };
  assert.deepEqual([thread.content.split("\n")[3], thread.total_lines], ["4: second", 4]);
  const found = JSON.parse(await space.call("search_known", JSON.stringify({ query: "SECOND", ignore_case: true }))) as { results: unknown[] };
  assert.deepEqual(found.results, [{ which: "thread", line: 4, text: "second" }]);
  const inIssues = JSON.parse(await space.call("search_known", JSON.stringify({ query: "steps", ignore_case: false }))) as { results: unknown[] };
  assert.deepEqual(inIssues.results, [{ which: "issues", line: 2, text: "steps" }], "the open issues are searched too");
  assert.match(await space.call("read_known", JSON.stringify({ which: "nope", start_line: 1, line_count: 1 })), /which is thread or issues/);
  assert.match(await workspace.call("read_known", JSON.stringify({ which: "thread", start_line: 1, line_count: 1 })), /unknown tool/, "a workspace given none doesn't serve them");
  assert.match(knownTexts({ thread: [], issues: [], more: false, issuesError: "" }).index, /- none, besides this review's own posts\n\nThe open issues \(0, read_known which issues\):\n- none/);
  const unread = knownTexts({ ...KNOWN, issues: [], more: false, issuesError: "status 403" }).index;
  assert.match(unread, /\n\nThe repository's open issues couldn't be read, so you can't tell an issue filed there\.$/, "open issues that couldn't be read aren't shown as none");
  const long = knownTexts({ ...KNOWN, thread: [{ ...KNOWN.thread[0]!, body: `${"w".repeat(200)}\nnext` }] }).index;
  assert.match(long, new RegExp(`: ${"w".repeat(120)}…\n`), "an index entry gives its first line, cut at 120 characters");
  // A header field with a line break in it, such as a title, stays one line, so each later pointer still names its item.
  const broken = knownTexts({ ...KNOWN, thread: [{ ...KNOWN.thread[0]!, kind: "review\ncomment", author: "ann\n" }], issues: [{ ...KNOWN.issues[0]!, title: "Crash\non empty" }, KNOWN.issues[1]!] });
  assert.match(broken.index, /- line 1: review comment by ann, https:\/\/github\.com\/o\/n\/pull\/1#pullrequestreview-9: First line of it\n/);
  assert.match(broken.index, /- line 4: #8 t8, /);
  const brokenSpace = new Workspace("/tmp", "/dev/null", "HEAD", null, broken.texts);
  const pointed = JSON.parse(await brokenSpace.call("read_known", JSON.stringify({ which: "issues", start_line: 4, line_count: 1 }))) as { content: string };
  assert.equal(pointed.content, "4: === #8: t8, https://github.com/o/n/issues/8", "the line the index names is the item's header");
  assert.match(broken.texts.issues, /^=== #7: Crash on empty, /);
  assert.match(broken.texts.thread, /^=== review comment by ann, https:\/\/github\.com\/o\/n\/pull\/1#pullrequestreview-9\n\nFirst line of it\n/, "the thread's header is one line too");
  const cased = JSON.parse(await space.call("search_known", JSON.stringify({ query: "SECOND", ignore_case: false }))) as { results: unknown[] };
  assert.deepEqual(cased.results, [], "matched by case unless told otherwise");
  for (const query of ["", "q".repeat(501)]) assert.match(await space.call("search_known", JSON.stringify({ query, ignore_case: false })), /query is invalid/);
  const many = new Workspace("/tmp", "/dev/null", "HEAD", null, { thread: "x\n".repeat(70), issues: "x" });
  const capped = JSON.parse(await many.call("search_known", JSON.stringify({ query: "x", ignore_case: false }))) as { results: unknown[]; truncated: boolean };
  assert.deepEqual([capped.results.length, capped.truncated], [60, true], "a search stops at its hit limit, saying so");
});

test("known.json is read as the collector writes it, an item missing a field left out, and anything else is none", async () => {
  // Each field of an item, missing or of the wrong type, leaves that item out.
  const item = { kind: "comment", author: "x", url: "u", body: "b" };
  const thread = (["kind", "author", "url", "body"] as const).flatMap((field) => [{ ...item, [field]: undefined }, { ...item, [field]: 5 }]);
  const one = { number: 9, title: "t", url: "u", body: "" };
  const issues = (["number", "title", "url", "body"] as const).flatMap((field) => [{ ...one, [field]: undefined }, { ...one, [field]: field === "number" ? "9" : 5 }]);
  assert.deepEqual(parseKnown({ ...KNOWN, thread: [...KNOWN.thread, ...thread, null, 3], issues: [...KNOWN.issues, ...issues, { ...one, number: 1.5 }] }), KNOWN);
  assert.deepEqual(parseKnown({ ...KNOWN, thread: [item], issues: [one] }), { ...KNOWN, thread: [item], issues: [one] }, "a whole item is kept");
  const { issuesError: _none, ...older } = KNOWN;
  assert.deepEqual(parseKnown(older), KNOWN, "a file without issuesError read its open issues");
  assert.deepEqual(parseKnown({ ...KNOWN, issuesError: "status 403" })!.issuesError, "status 403");
  assert.equal(parseKnown({ ...KNOWN, issuesError: 403 }), null);
  assert.equal(parseKnown({ ...KNOWN, more: "yes" }), null);
  assert.equal(parseKnown({ ...KNOWN, thread: {} }), null);
  assert.equal(parseKnown({ ...KNOWN, issues: {} }), null);
  assert.equal(parseKnown({ thread: [], issues: [] }), null);
  assert.match(knownProblem(null)!, /^The pull request's thread and the repository's open issues weren't read/);
  assert.equal(knownProblem({ ...KNOWN, issuesError: "the open issues query failed: Resource not accessible by integration." }), "The repository's open issues weren't read, so an issue filed there before may be raised here again. Where GitHub refused them, the workflow needs the permission issues: read. The collector said: the open issues query failed: Resource not accessible by integration.");
  assert.equal(knownProblem(KNOWN), "The judge read the newest 2 of the repository's open issues, not the older ones, so an issue filed in one of those may be raised here again.");
  assert.equal(knownProblem({ ...KNOWN, more: false }), null, "all of them read, nothing to say");
  assert.equal(parseKnown([]), null);
  const dir = makeTemp(joinPath(tempRoot(), "shape-known-"));
  const logged: string[] = [];
  assert.equal(await loadKnown(joinPath(dir, "known.json"), (line) => logged.push(line)), null);
  writeTo(joinPath(dir, "known.json"), "{not json");
  assert.equal(await loadKnown(joinPath(dir, "known.json"), (line) => logged.push(line)), null);
  writeTo(joinPath(dir, "known.json"), JSON.stringify(KNOWN));
  assert.deepEqual(await loadKnown(joinPath(dir, "known.json"), (line) => logged.push(line)), KNOWN);
  writeTo(joinPath(dir, "known.json"), JSON.stringify({ ...KNOWN, issues: [], more: false, issuesError: "the open issues query failed with status 403" }));
  assert.equal((await loadKnown(joinPath(dir, "known.json"), (line) => logged.push(line)))?.issuesError, "the open issues query failed with status 403");
  assert.deepEqual(logged, ["no thread or open issues were collected, so the judge can't tell an issue raised before", "ignoring known.json, which isn't the collector's shape", "the judge reads 1 thread item(s) and 2 open issue(s), the newest of more", "the judge reads 1 thread item(s) and no open issues (the open issues query failed with status 403)"]);
});

test("the judge is offered the thread and open issues only when it has them, told what a missing dependency leaves unsettled, and in a later round where its base is", async () => {
  const ask = async (known: Known | null, withoutDependencies: boolean, laterRound = false) => {
    const { chat, requests } = scripted([submit("submit_verdicts", { verdicts: [{ issue: "I1", verdict: "not-real", notRealKind: "cannot happen" }] })]);
    const served: unknown[] = [];
    await judgeIssues([issue("I1")], [finding("A:t[0]")], {
      chat, model: "opus", effort: "high", workspace: (texts) => (served.push(texts), workspace), prior: null, change: { title: "T", description: "", commitMessages: "", facts: [] },
      known, dependencies: "The head's dependencies are not installed here.", withoutDependencies, laterRound, deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge",
    });
    return { tools: requests[0]!.tools.map((tool) => tool.function.name), definitions: requests[0]!.tools, prompt: requests[0]!.messages[1]!.content ?? "", served };
  };
  // A knownAt naming an indexed URL survives judging; one the index didn't give names nothing.
  const named = scripted([submit("submit_verdicts", { verdicts: [
    { issue: "I1", verdict: "real", severity: "minor", ...OWN, knownAt: KNOWN.issues[0]!.url },
    { issue: "I2", verdict: "real", severity: "minor", ...OWN, knownAt: "https://github.com/o/n/issues/99" },
  ] })]);
  const judged = await judgeIssues([issue("I1"), issue("I2")], [finding("A:t[0]")], {
    chat: named.chat, model: "opus", effort: "high", workspace: () => workspace, prior: null, change: { title: "T", description: "", commitMessages: "", facts: [] },
    known: KNOWN, dependencies: "", withoutDependencies: false, laterRound: false, deadline: Date.now() + 60_000, maxTurns: 4, log: () => {}, caller: "judge",
  });
  assert.deepEqual(judged.verdicts.map((verdict) => verdict.knownAt), [KNOWN.issues[0]!.url, ""]);
  const given = await ask(KNOWN, true);
  assert.deepEqual(given.tools, ["read_diff", "read_file", "read_base_file", "list_files", "search", "read_known", "search_known", "submit_verdicts"]);
  // The schemas the model is given: what a verdict must hold, and how the known tools are called.
  const schema = (name: string) => given.definitions.find((tool) => tool.function.name === name)!.function.parameters as { required: string[]; properties: Record<string, { enum?: string[]; items?: { required: string[]; properties: Record<string, { enum?: string[] }> } }> };
  const verdict = schema("submit_verdicts").properties.verdicts!.items!;
  assert.deepEqual(["origin", "security", "knownAt", "text", "confirm"].filter((field) => !verdict.required.includes(field)), [], "each verdict carries origin, security, knownAt, text and confirm");
  assert.deepEqual(verdict.properties.origin!.enum, ["change", "base"]);
  assert.ok(verdict.properties.notRealKind!.enum!.includes("asks what the project doesn't promise"));
  assert.deepEqual([schema("read_known").required, schema("read_known").properties.which!.enum], [["which", "start_line", "line_count"], ["thread", "issues"]]);
  assert.deepEqual(schema("search_known").required, ["query", "ignore_case"]);
  // The rules the verdict's new fields are given by.
  assert.match(given.prompt, /- \*\*origin:\*\* change when the defect is in what the change adds or alters, or when the change newly makes an older defect reachable or worse; base when it is in code the base already has and would be there, as bad, without the change\. Read the base with read_base_file to tell\./);
  assert.match(given.prompt, /- \*\*security:\*\* true when fixing it would close a way for someone to read, change or run what they shouldn't[^\n]*When you can't tell, true\./);
  assert.match(given.prompt, /Nothing was run: say what you found by reading as reading, such as "by reading, no test checks that the entry is cleared", never as a run's result/);
  assert.match(given.prompt, /or the issue asks for something the project doesn't promise[^\n]*Before you call such an ask real, read what the project does promise: its README, CONTRIBUTING, release or changelog conventions[^\n]*Hold the ask real only where one of them makes that promise\./);
  assert.deepEqual(given.served, [knownTexts(KNOWN).texts]);
  assert.match(given.prompt, /## Where an issue may already be named\n\n[^\n]+\n\nThe thread \(1 item, read_known which thread\):/);
  assert.match(given.prompt, /The head's dependencies are not installed here\. So an issue whose case rests on what a dependency does, or on what its types allow, is at most unsure/);
  assert.match(given.prompt, /or the URL of the thread item or open issue that names it, from the index below/);
  const none = await ask(null, false);
  assert.deepEqual(none.tools, ["read_diff", "read_file", "read_base_file", "list_files", "search", "submit_verdicts"]);
  assert.deepEqual(none.served, [null]);
  assert.doesNotMatch(none.prompt, /Where an issue may already be named|read_known|from the index below|at most unsure|earlier review of this pull request/);
  assert.match(none.prompt, /## The thread and open issues\n\nThe pull request's thread and the repository's open issues couldn't be read for this review, so you can't tell whether one of them already names an issue\./, "the judge is told its look for an issue raised before was blind");
  const later = await ask(null, false, true);
  assert.match(later.prompt, /This review reads only what changed since an earlier review of this pull request: read_diff shows that\. read_base_file reads the code the pull request is to be merged into, before any of its commits, so code the pull request added in an earlier round is the change's own/);
});

test("the severity check names a repeat only of an issue above it, and a chain of repeats ends at the first", async () => {
  const graded = ["a", "b", "c", "d", "e"].map((id) => ({ id, title: id, causes: [], consequences: [], severity: "minor" as const, verdict: "real" as const, why: "" }));
  const { chat, requests } = scripted([submit("submit_severities", { severities: [
    { issue: "a", severity: "minor", sameAs: "b" },
    { issue: "b", severity: "minor", sameAs: "a" },
    { issue: "c", severity: "should-fix", sameAs: "b" },
    { issue: "d", severity: "minor", sameAs: "d" },
    { issue: "e", severity: "minor", sameAs: "zz" },
  ] })]);
  const settled = await settleSeverities(graded, { chat, model: "opus", effort: "high", workspace, deadline: Date.now() + 60_000, log: () => {} });
  assert.deepEqual([...settled.sameAs], [["b", "a"], ["c", "a"]], "a points nowhere above it, and d at itself; c follows b to a");
  const ungraded = scripted([submit("submit_severities", { severities: [
    { issue: "a", severity: "minor", sameAs: "" },
    { issue: "b", severity: "nope", sameAs: "a" },
    { issue: "c", sameAs: "a" },
    { issue: "c", severity: "blocker", sameAs: "" },
  ] })]);
  const kept = await settleSeverities(graded, { chat: ungraded.chat, model: "opus", effort: "high", workspace, deadline: Date.now() + 60_000, log: () => {} });
  assert.deepEqual([...kept.sameAs], [["b", "a"], ["c", "a"]], "a repeat named without a usable grade still folds");
  assert.deepEqual([kept.severities.get("b"), kept.severities.get("c")], ["minor", "minor"], "and keeps the judge's grade; a second entry for an issue counts for nothing");
  assert.match(kept.problem ?? "", /no grade for b, c, d, e/);
  const spaced = scripted([submit("submit_severities", { severities: [{ issue: 7, severity: "minor" }, { severity: "minor" }, { issue: " b ", severity: " blocker ", sameAs: " a" }] })]);
  const trimmed = await settleSeverities(graded, { chat: spaced.chat, model: "opus", effort: "high", workspace, deadline: Date.now() + 60_000, log: () => {} });
  assert.deepEqual([[...trimmed.sameAs], trimmed.severities.get("b")], [[["b", "a"]], "blocker"], "an id and a grade written with a space round them are read as its sameAs is, after entries with no id at all");
  const failed = await settleSeverities(graded, { chat: scripted([new ModelError(500, "down")]).chat, model: "opus", effort: "high", workspace, deadline: Date.now() + 60_000, log: () => {} });
  assert.deepEqual([failed.sameAs.size, failed.problem], [0, "The severity check gave no answer, so every issue keeps the judge's grade, and no issue is folded into another it repeats."], "a failed check folds nothing, and says so");
  assert.match(requests[0]!.messages[1]!.content ?? "", /give sameAs the id of the first issue above it in this list that names that defect/);
  const severities = requests[0]!.tools.find((tool) => tool.function.name === "submit_severities")!.function.parameters as { properties: { severities: { items: { required: string[] } } } };
  assert.deepEqual(severities.properties.severities.items.required, ["issue", "severity", "sameAs"]);
});

test("a repeat folds into the issue it repeats, which keeps the graver grade, and a security issue any judge placed in the base's code is held", () => {
  const verdict = (id: string, severity: JudgeVerdict["severity"], extra: Partial<JudgeVerdict> = {}): JudgeVerdict => ({
    issue: id, verdict: "real", notRealKind: "", severity, judgedSeverity: severity, why: "w", evidence: [], confidence: "high",
    origin: "change", security: false, knownAt: "", reasonHolds: false, text: `text ${id}`, confirm: "", ...extra,
  });
  const located = (key: string, file: string, line: number): Finding => ({ ...finding(key), places: [{ file, line }] });
  const area = (name: string) => ({ name, files: [], tasks: [], questions: [] });
  const grouped = (id: string, ...members: string[]): Issue => ({ ...issue(id), findings: members });
  const core = { area: area("core"), answers: [], failed: [],
    all: [located("A:t[0]", "src/a.ts", 11), located("A:t[1]", "src/a.ts", 11), located("A:t[2]", "src/old.ts", 3), located("A:t[3]", "src/old.ts", 8), located("A:t[4]", "src/old.ts", 20), located("A:t[5]", "src/c.ts", 2), located("A:t[6]", "src/old.ts", 30),
      located("A:t[7]", "src/e.ts", 1), located("A:t[8]", "src/e.ts", 1), located("A:t[9]", "src/f.ts", 1), located("A:t[10]", "src/old.ts", 40), located("A:t[11]", "src/g.ts", 1)],
    grouping: { issues: [grouped("I1", "A:t[0]", "A:t[1]"), grouped("I2", "A:t[2]"), grouped("I3", "A:t[3]"), grouped("I4", "A:t[4]"), grouped("I5", "A:t[5]"), grouped("I6", "A:t[6]"),
      grouped("I7", "A:t[7]", "A:t[8]"), grouped("I8", "A:t[9]"), grouped("I9", "A:t[10]"), grouped("I10", "A:t[11]")], problems: [] },
    judging: { verdicts: [
      verdict("I1", "should-fix", { verdict: "unsure" }),
      verdict("I2", "minor", { origin: "base", security: true }),
      verdict("I3", "minor", { origin: "base", security: true }),
      verdict("I4", "minor", { origin: "base" }),
      verdict("I5", "minor", { confirm: "run core/I5" }),
      verdict("I6", "minor", { origin: "base" }),
      verdict("I7", "minor"),
      verdict("I8", "should-fix", { verdict: "unsure", knownAt: "description" }),
      verdict("I9", "minor", { origin: "base" }),
      verdict("I10", "minor", { security: true }),
    ], unjudged: [], errors: [] } };
  const tests = { area: area("tests"), answers: [], failed: [],
    all: [located("B:t[0]", "src/b.ts", 5), located("B:t[1]", "src/a.ts", 11), located("B:t[2]", "src/old.ts", 8), located("B:t[3]", "src/c.ts", 2), located("B:t[4]", "src/old.ts", 30), located("B:t[5]", "src/d.ts", 4), located("A:u[0]", "src/f.ts", 2), located("B:t[6]", "src/old.ts", 41), located("B:t[7]", "src/old.ts", 50)],
    grouping: { issues: [grouped("I1", "B:t[0]", "B:t[1]"), grouped("I2", "B:t[2]"), grouped("I3", "B:t[3]"), grouped("I4", "B:t[4]"), grouped("I5", "B:t[5]"), grouped("I6", "A:u[0]"), grouped("I7", "B:t[6]"), grouped("I8", "B:t[7]")], problems: [] },
    judging: { verdicts: [
      verdict("I1", "blocker", { origin: "base", security: true, knownAt: "description", reasonHolds: true, confirm: "run tests/I1" }),
      verdict("I2", "minor", { confirm: "run tests/I2" }),
      verdict("I3", "should-fix", { security: true, confirm: "run tests/I3" }),
      verdict("I4", "minor"),
      verdict("I5", "blocker", { confirm: "run tests/I5" }),
      verdict("I6", "minor", { verdict: "unsure" }),
      verdict("I7", "minor", { origin: "base" }),
      verdict("I8", "minor", { origin: "base" }),
    ], unjudged: [], errors: [] } };
  const plan = { areas: [area("core"), area("tests")], facts: [], note: "" } as unknown as Plan;
  const review = assembleReview({ label: "re-o.n-1-1", round: 1, roundOf: null, outDir: "", keptDir: null }, "h", "b", { planner: "opus", batteryA: "sol", batteryB: "haiku", judge: "opus" },
    [core, tests], plan, [], ["src/a.ts"], (name, id) => `${name}/${id}`, DIFF, new Map([["tests/I1", "core/I1"], ["tests/I2", "core/I3"], ["tests/I3", "core/I5"], ["tests/I4", "core/I6"], ["tests/I5", "core/I5"], ["tests/I6", "core/I8"], ["tests/I7", "core/I9"], ["tests/I8", "core/I10"]]), "o/n");
  assert.deepEqual(review.held.map((held) => held.id), ["core/I1", "core/I2", "core/I3", "core/I10"], "a security issue either judge placed in the base's code is held, whichever of the two came first");
  assert.deepEqual([review.held[3]!.origin, review.held[3]!.security, review.held[3]!.repeats], ["base", true, ["tests/I8"]], "held too when one judge calls it security in the change's code and the other places it, not as security, in the base's");
  const [first, , third] = review.held;
  assert.deepEqual([first!.severity, first!.verdict, first!.readers, first!.places, first!.repeats], ["blocker", "real", ["A", "B"], [{ file: "src/a.ts", line: 11 }, { file: "src/b.ts", line: 5 }], ["tests/I1"]], "the graver grade, real when either is, and each place once, its own repeats among them");
  assert.deepEqual([first!.security, first!.origin, first!.knownAt, first!.reasonHolds, first!.text, first!.confirm], [true, "base", "description", true, "text I1", "run tests/I1"], "its own text, and the repeat's run, naming and the reason it gave, where it had none");
  assert.deepEqual([third!.origin, third!.security, third!.repeats, third!.text, third!.confirm], ["base", true, ["tests/I2"], "text I3", "run tests/I2"]);
  assert.deepEqual(review.issues.map((posted) => posted.id), ["core/I5", "core/I8", "core/I4", "core/I6", "core/I7", "core/I9"], "a security issue only in the change's own code posts, and so does an issue in the base's code that isn't security");
  const [own, unsure, older, either, alone, bothBase] = review.issues;
  assert.deepEqual([own!.severity, own!.origin, own!.security, own!.repeats, own!.text, own!.confirm, own!.places.length], ["blocker", "change", true, ["tests/I3", "tests/I5"], "text I5", "run core/I5", 2], "its own run stands, and every repeat folds in");
  assert.deepEqual([older!.origin, older!.security], ["base", false]);
  assert.deepEqual([either!.origin, either!.security, either!.repeats], ["change", false, ["tests/I4"]], "an issue that isn't security is the change's own when either judge says so");
  assert.deepEqual(alone!.places, [{ file: "src/e.ts", line: 1 }], "an issue with no repeat names each of its places once too");
  assert.deepEqual([unsure!.severity, unsure!.verdict, unsure!.readers, unsure!.knownAt, unsure!.repeats], ["should-fix", "unsure", ["A"], "description", ["tests/I6"]], "the kept grade when it's the graver, unsure when both are, each reader once, and where the kept issue was named");
  assert.deepEqual([bothBase!.origin, bothBase!.security, bothBase!.repeats], ["base", false, ["tests/I7"]], "in the base's code when both judges say so, and posted, since it isn't security");
  assert.equal(review.repo, "o/n");
});

test("the public log's outcome line counts only what the posted review shows, so no count subtracts to a held issue", () => {
  const line = outcomeLine({ issues: [posted("I1", "blocker")], unjudged: [{ area: "all", id: "I4", title: "t" }] });
  assert.equal(line, "1 issue(s) to post, 1 unjudged");
});

test("issues in existing code are listed apart, below the change's own, and don't weigh in the advice, an issue named before gets no comment, and a held one is never shown", () => {
  const base = { ...posted("I1", "blocker"), origin: "base" as const, title: "Old bug" };
  const filed = { ...posted("I2", "should-fix", 12), knownAt: "https://github.com/o/n/issues/7" };
  const thread = { ...posted("I3", "should-fix", 11), knownAt: "https://github.com/o/n/pull/1#issuecomment-5" };
  const minors = [{ ...posted("I4", "minor"), places: [{ file: "src/z.ts", line: 2 }] }, { ...posted("I5", "minor"), places: [{ file: "src/b.ts", line: 9 }] }];
  const secret = { ...posted("I6", "blocker"), title: "Secret hole", origin: "base" as const, security: true };
  const review = shapeReview([base, filed, thread, ...minors], { held: [secret] });
  const parts = buildShapeReview({ review, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 });
  assert.deepEqual(parts.comments, [], "the base's issue and the two named before get no comment");
  assert.match(parts.body, /\*\*Recommendation: fix here or file an issue for each, then merge\.\*\* 2 should-fix issues should be/, "the base's blocker doesn't weigh");
  assert.match(parts.body, /Already raised in \[#7\]\(https:\/\/github\.com\/o\/n\/issues\/7\)\./);
  assert.match(parts.body, /Already raised \[on this pull request\]\(https:\/\/github\.com\/o\/n\/pull\/1#issuecomment-5\)\./);
  assert.match(parts.body, /#### In existing code \(1\)\n\n<details>\n<summary>1 issue in code that was there before this change, which doesn't weigh in the recommendation<\/summary>\n\n- \*\*Blocker\. Old bug\.\*\* \[`src\/a\.ts:11`\]/);
  assert.ok(parts.body.indexOf("src/b.ts:9") < parts.body.indexOf("src/z.ts:2"), "minor issues are listed by file");
  assert.ok(parts.body.indexOf("#### Minor (2)") < parts.body.indexOf("#### In existing code (1)"), "existing code's issues come after every list of the change's own");
  assert.match(parts.body, /<summary>2 minor issues, by file<\/summary>\n\n- Issue I5\. \[`src\/b\.ts:9`\]/, "a minor issue isn't graded again under its heading");
  assert.doesNotMatch(parts.body, /Secret hole|I6/, "a held issue appears nowhere");
  const deleted = shapeReview([{ ...posted("I7", "should-fix"), places: [{ file: "gone.ts", line: 4, base: true as const }, { file: "change-text.md", line: 2 }] }]);
  assert.match(buildShapeReview({ review: deleted, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body, /\[`gone\.ts:4` \(at the base\)\]\(https:\/\/github\.com\/o\/n\/blob\/0123456789abcdef\/gone\.ts#L4\)/, "a deleted file's place links into the base the review read");
  const spread = shapeReview([{ ...posted("I9", "should-fix"), places: [1, 2, 3, 4, 5].map((line) => ({ file: "src/a.ts", line })) }]);
  assert.match(buildShapeReview({ review: spread, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 0 }).body, /src\/a\.ts#L3\) and 2 more places /, "an issue links its first three places and counts the rest");
  const textOnly = shapeReview([{ ...posted("I8", "should-fix"), places: [{ file: "change-text.md", line: 2 }] }]);
  assert.match(buildShapeReview({ review: textOnly, hunks: parseHunks(DIFF), existing: [], minSeverity: "medium", maxComments: 10 }).body, /Issue I8\.\*\* the description, line 2 /);
});
