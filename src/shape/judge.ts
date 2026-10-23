// Stage 5 of the review shape, and the severity check after it. A judge reads the code behind each issue and tries
// to refute it, a few issues per call with every call at once. Then one call over every issue it kept settles their
// severities across the whole review, since each judging call grades only its own few.
// The judge's brief is the calibrated validity judge the review shape uses (JUDGE_SOURCE), with RevEngine's read
// tools in place of a shell, and the maintainers' earlier decisions in place of an author's "known".
import { runAgent } from "../agent.ts";
import { ModelError, ModelRefused, type Chat } from "../llm.ts";
import { UNTRUSTED } from "../prompts.ts";
import { priorDecisionsVerifierSection, type PriorDecisions } from "../prior.ts";
import type { ToolDefinition, Workspace } from "../tools.ts";
import { numbered, SEVERITY_TEXT } from "./find.ts";
import { HAND_IN_TURNS, SEVERITIES, type Finding, type Issue, type Severity } from "./types.ts";

export const JUDGE_SOURCE = { name: "report:greptile-replay-validity", blob: "ca3dce8217fa65ca292fd70e8a5030af3fde943e", note: "the calibrated validity judge, adapted from one finding to a few grouped issues per call" };

/** Issues per judging call. */
export const JUDGE_BATCH = 5;

export type VerdictName = "real" | "not-real" | "unsure" | "decided-before";
export const NOT_REAL_KINDS = ["cannot happen", "happens but nothing goes wrong", "intended or documented"] as const;
/** "unstated" when the judge called an issue not real without giving one of the three kinds. */
export type NotRealKind = (typeof NOT_REAL_KINDS)[number] | "unstated";

export interface Evidence {
  file: string;
  line: number;
  quote: string;
}

export interface JudgeVerdict {
  issue: string;
  verdict: VerdictName;
  notRealKind: NotRealKind | "";
  /** The severity the review shows: the severity check's, or the judge's own when the check gave none. */
  severity: Severity;
  /** The judge's own grade before the severity check, or the readers' grade where the judge gave none. */
  judgedSeverity: Severity;
  why: string;
  evidence: Evidence[];
  confidence: "low" | "medium" | "high";
  /** The earlier decided finding this issue repeats, as P1, P2… of the earlier decisions. */
  repeatOf?: string;
}

const verdictsTool: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_verdicts",
    description: "Hand in one verdict for every issue you were given.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["verdicts"],
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["issue", "verdict", "notRealKind", "severity", "why", "evidence", "confidence", "repeatOf", "exceptionHolds"],
            properties: {
              issue: { type: "string", description: "The issue id, as given, such as I3." },
              verdict: { type: "string", enum: ["real", "not-real", "unsure"], description: "real, not-real or unsure, as the brief defines them." },
              notRealKind: { type: "string", enum: ["", ...NOT_REAL_KINDS], description: "For not-real, which of the three; '' otherwise." },
              severity: { type: "string", enum: [...SEVERITIES], description: "For real or unsure: how much it matters as the code is used, as the brief defines the three. For not-real, minor." },
              why: { type: "string", description: "The decisive reason, in a few sentences." },
              evidence: {
                type: "array",
                description: "The lines your verdict rests on, quoted exactly, with their files and lines at head (at the base for a file the change deletes).",
                items: { type: "object", additionalProperties: false, required: ["file", "line", "quote"], properties: { file: { type: "string" }, line: { type: "integer" }, quote: { type: "string" } } },
              },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
              repeatOf: { type: "string", description: "The earlier finding this issue repeats, such as P2, or '' when it repeats none or there are no earlier decisions." },
              exceptionHolds: { type: "boolean", description: "When repeatOf is set: whether the exception the earlier decisions describe holds. false otherwise." },
            },
          },
        },
      },
    },
  },
};

function place(finding: Finding): string {
  return finding.places.map((spot) => `${spot.file}:${spot.line}${spot.base ? " (at the base)" : ""}`).join(", ");
}

export function issueText(issue: Issue, byKey: Map<string, Finding>): string {
  const lines = [`### Issue ${issue.id} (${issue.kind}, raised as ${issue.severity}): ${issue.title}`];
  if (issue.causes.length) lines.push(`Causes:\n${issue.causes.map((cause) => `- ${cause}`).join("\n")}`);
  if (issue.consequences.length) lines.push(`Consequences:\n${issue.consequences.map((consequence) => `- ${consequence}`).join("\n")}`);
  issue.findings.forEach((key, index) => {
    const finding = byKey.get(key);
    if (finding) lines.push(`Finding ${index + 1} (at ${place(finding)}): ${finding.claim}\nThe case it gives: ${finding.failingCase}`);
  });
  return lines.join("\n");
}

export const JUDGE_SYSTEM = `You check whether issues raised by a review of a code change describe real defects.

${UNTRUSTED}`;

/** The change's own text, which an issue of kind text is judged against, and the plan's facts the readers were given. */
export interface ChangeText {
  title: string;
  description: string;
  commitMessages: string;
  facts: string[];
}

export function judgePrompt(batch: Issue[], byKey: Map<string, Finding>, prior: PriorDecisions | null, change: ChangeText): string {
  return `You're checking whether each of the issues below, from a review of a code change, describes a real defect. A review of the change raised them. You aren't told who reviewed the change or how, and it doesn't matter: what matters is whether the case each issue describes actually happens in the code, and leads where it says. Judge each issue on its own.

## Your tools

You read the change with read-only tools: read_diff shows the change, read_file a file at head, read_base_file a file at the base, list_files a directory, and search finds text in the repository. The issues are about the code at head; a place marked "at the base" is in a file the change deletes or moves. When a case runs through a dependency, read the dependency's own code where the checkout holds it. The pull request's title, description and commit messages are below, at the end, cited as change-text.md and commit-messages.txt by their lines there; they aren't files in the checkout. An issue about them is judged by reading what they say against the code.

## How to work

- For each issue, start from its findings' places, then follow the case through the code: the paths that reach it, its callers, the state it depends on, the tests, and any dependency or other module it relies on. Read as far past the cited lines as the case needs.
- Try to refute each case. Look for what would stop it: a guard, a caller's precondition, an ordering, a type, a test, a documented contract. Call an issue real only when you have followed its case through the code and it holds.

## Your answer, one per issue

- **real:** the case the issue describes can happen at head and leads to the wrong outcome it names, or to one materially like it. A defect too small to be worth fixing is still real. An issue about a test is real when the test gap or the test's weakness is as it says. An issue about text is real when the text claims what the code doesn't do, or leaves out something that misleads its reader as the issue says.
- **not-real:** the case can't happen as described, because something stops it; or it happens and nothing goes wrong; or the behaviour is what the code is documented or evidently built to do.
- **unsure:** you couldn't settle it from what's here.

Give each real or unsure issue a severity, judged against the code as it is used, by the same definitions the review's readers graded by:
${SEVERITY_TEXT}

${prior?.entries.length ? `${priorDecisionsVerifierSection(prior).replaceAll("finding you check", "issue you judge").replaceAll("set repeat_of to null", "set repeatOf to ''").replaceAll("repeat_of", "repeatOf").replaceAll("exception_holds", "exceptionHolds")}\n\n` : "There are no earlier decisions on this pull request, so give every issue repeatOf '' and exceptionHolds false.\n\n"}Hand in your verdicts by calling submit_verdicts, one for each issue: ${batch.map((issue) => issue.id).join(", ")}.

## The issues

${batch.map((issue) => issueText(issue, byKey)).join("\n\n")}

${change.facts.length ? `## Facts the readers were given

The review's plan told every reader these facts about the platform and the services the code runs against. Each is the planner's reading of a source it names; check one against its source where a verdict rests on it.
${change.facts.map((fact) => `- ${fact.trim()}`).join("\n")}

` : ""}## The change's own text

The pull request's title: ${change.title || "(none)"}

Its description, cited as change-text.md, each line numbered:
<description>
${numbered(change.description)}
</description>

Its commit messages, cited as commit-messages.txt, each line numbered:
<commit_messages>
${numbered(change.commitMessages)}
</commit_messages>`;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.find((choice) => choice === value) ?? fallback;
}

/**
 * The verdicts a submission gives for the asked issues, each once; an id that wasn't asked, or repeats, is left out.
 * A grade the judge didn't give keeps the readers' grade (the issue's), and a not-real verdict without one of the three
 * kinds says "unstated", so the review shows the gap rather than a reason nobody gave. A repeat without a yes or no on
 * its exception is left out too, so the issue is asked again rather than set aside as decided on a guess.
 */
export function parseVerdicts(value: Record<string, unknown>, asked: Issue[], prior: PriorDecisions | null): JudgeVerdict[] {
  const wanted = new Map(asked.map((issue) => [issue.id, issue]));
  const known = new Set(prior?.entries.map((entry) => entry.id) ?? []);
  const verdicts: JudgeVerdict[] = [];
  for (const entry of Array.isArray(value.verdicts) ? value.verdicts : []) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const issue = typeof item.issue === "string" ? item.issue.trim() : "";
    const raised = wanted.get(issue);
    if (!raised) continue;
    const repeatOf = typeof item.repeatOf === "string" && known.has(item.repeatOf.trim()) ? item.repeatOf.trim() : "";
    if (repeatOf && typeof item.exceptionHolds !== "boolean") continue;
    // A verdict that isn't one of the three is no verdict: the issue is asked again alone, as a missing one is.
    if (!(repeatOf && item.exceptionHolds === false) && !["real", "not-real", "unsure"].includes(item.verdict as string)) continue;
    wanted.delete(issue);
    const severity = oneOf(item.severity, SEVERITIES, raised.severity);
    // A repeat of a decided finding, with no exception holding, is the maintainers' decision standing.
    const decided = Boolean(repeatOf) && item.exceptionHolds === false;
    const verdict: VerdictName = decided ? "decided-before" : oneOf(item.verdict, ["real", "not-real", "unsure"] as const, "unsure");
    const evidence = (Array.isArray(item.evidence) ? item.evidence : []).flatMap((spot): Evidence[] => {
      if (!spot || typeof spot !== "object") return [];
      const { file, line, quote } = spot as Record<string, unknown>;
      return typeof file === "string" && Number.isInteger(line) && typeof quote === "string" ? [{ file, line: line as number, quote }] : [];
    });
    verdicts.push({
      issue, verdict, notRealKind: verdict === "not-real" ? oneOf<NotRealKind>(item.notRealKind, NOT_REAL_KINDS, "unstated") : "",
      severity, judgedSeverity: severity, why: typeof item.why === "string" ? item.why.trim() : "", evidence,
      confidence: oneOf(item.confidence, ["low", "medium", "high"] as const, "low"),
      ...(repeatOf ? { repeatOf } : {}),
    });
  }
  return verdicts;
}

export interface JudgeOptions {
  chat: Chat;
  model: string;
  effort: string | null;
  /** A workspace for each call, so each judge's reads are kept apart. */
  workspace: () => Workspace;
  prior: PriorDecisions | null;
  change: ChangeText;
  deadline: number;
  maxTurns: number;
  log: (message: string) => void;
  /** Names the calls, such as "judge (area core)". */
  caller: string;
}

export interface Judging {
  verdicts: JudgeVerdict[];
  /** Issues no call gave a verdict for, even when asked alone. The review lists them as unjudged. */
  unjudged: string[];
  /** What the failed calls were, each kind once (a model error by its name and status), said beside the unjudged issues. */
  errors: string[];
}

/**
 * Judges every issue, JUDGE_BATCH to a call, all calls at once. An issue a call doesn't answer for (a call that fails,
 * or a submission that leaves it out) is asked again alone, once. A refused call stops the review, by its category.
 */
export async function judgeIssues(issues: Issue[], findings: Finding[], options: JudgeOptions): Promise<Judging> {
  const byKey = new Map(findings.map((finding) => [finding.key, finding]));
  const errors = new Set<string>();
  const ask = async (batch: Issue[], label: string): Promise<JudgeVerdict[]> => {
    try {
      const submission = await runAgent({
        chat: options.chat, model: options.model, system: JUDGE_SYSTEM, prompt: judgePrompt(batch, byKey, options.prior, options.change),
        workspace: options.workspace(), submit: verdictsTool, deadline: options.deadline, maxTurns: options.maxTurns, handInTurns: HAND_IN_TURNS, log: options.log, caller: label,
        ...(options.effort ? { effort: options.effort } : {}),
      });
      return parseVerdicts(submission, batch, options.prior);
    } catch (error) {
      if (error instanceof ModelRefused) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      // The review says what kind of failure it was; the provider's own words stay in the log.
      errors.add(error instanceof ModelError ? `${error.name}, status ${error.status}` : reason.slice(0, 200));
      options.log(`${label} gave no verdicts: ${reason}`);
      return [];
    }
  };
  const batches: Issue[][] = [];
  for (let start = 0; start < issues.length; start += JUDGE_BATCH) batches.push(issues.slice(start, start + JUDGE_BATCH));
  const verdicts = (await Promise.all(batches.map((batch) => ask(batch, `${options.caller} ${batch[0]!.id}`)))).flat();
  const answered = new Set(verdicts.map((verdict) => verdict.issue));
  const missing = issues.filter((issue) => !answered.has(issue.id));
  if (missing.length) {
    options.log(`${options.caller}: ${missing.length} issue(s) came back without a verdict (${missing.map((issue) => issue.id).join(", ")}); asking for each alone`);
    verdicts.push(...(await Promise.all(missing.map((issue) => ask([issue], `${options.caller} ${issue.id} alone`)))).flat());
  }
  const judged = new Set(verdicts.map((verdict) => verdict.issue));
  return { verdicts, unjudged: issues.filter((issue) => !judged.has(issue.id)).map((issue) => issue.id), errors: [...errors] };
}
