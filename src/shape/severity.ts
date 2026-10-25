// The severity check at the end of the review, when the judge kept two or more issues: one call reads every one,
// across every area of the review, and settles their severities against one another. Each judging call grades only its own few issues, so
// grades can drift between calls; the review is then grouped by the severities this check gives. Being the one call
// that reads every kept issue, it also names an issue that repeats an earlier one, as areas read apart can raise one
// defect each.
import { runAgent } from "../agent.ts";
import { told, type Chat } from "../llm.ts";
import { UNTRUSTED } from "../prompts.ts";
import type { ToolDefinition, Workspace } from "../tools.ts";
import { SEVERITY_TEXT } from "./find.ts";
import { HAND_IN_TURNS, SEVERITIES, type Severity } from "./types.ts";

/** One kept issue as the check reads it. `id` is unique across the review, such as `core/I3`. */
export interface Graded {
  id: string;
  title: string;
  causes: string[];
  consequences: string[];
  severity: Severity;
  /** real, or unsure when the judge couldn't settle it from the code. */
  verdict: "real" | "unsure";
  why: string;
  /** Its finding's case, for an issue with no consequences of its own (one left-out finding). */
  failingCase?: string;
}

const severitiesTool: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_severities",
    description: "Hand in one severity for every issue you were given.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["severities"],
      properties: {
        severities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["issue", "severity", "sameAs"],
            properties: {
              issue: { type: "string", description: "The issue id, exactly as given." },
              severity: { type: "string", enum: [...SEVERITIES] },
              sameAs: { type: "string", description: "The id of the first issue above this one that names the same defect, or '' for none." },
            },
          },
        },
      },
    },
  },
};

export function severityPrompt(issues: Graded[]): string {
  return `A review of a code change found the issues below, and a judge who read the code held each one real, or, where it says unsure, couldn't settle it from the code. The judge graded them a few at a time, so grades given in different batches may not agree with one another. Settle every issue's severity against the others, so that issues that matter alike are graded alike across the whole review.

The three severities, judged against the code as it is used, as the review's readers and its judge graded by them:
${SEVERITY_TEXT}

Keep the judge's grade where it fits these definitions beside the others. Change it where the issue, read beside the rest, belongs in another. Judge from what each issue and the judge's reason say; you don't need to read the code.

The review read its parts apart, so two issues can name one defect: the same wrong outcome from the same cause, found from different code. For such an issue, give sameAs the id of the first issue above it in this list that names that defect, and grade both alike. Issues that only touch the same code, or share a cause but go wrong differently, aren't the same. '' for every other issue.

Hand in a severity for every issue, by its id, by calling submit_severities.

${issues.map((issue) => [`### ${issue.id}: ${issue.title}`, `The judge's verdict: ${issue.verdict}. Its grade: ${issue.severity}.`, ...(issue.causes.length ? [`Causes: ${issue.causes.join("; ")}`] : []), ...(issue.consequences.length ? [`Consequences: ${issue.consequences.join("; ")}`] : issue.failingCase ? [`Its case: ${issue.failingCase}`] : []), `The judge's reason: ${issue.why}`].join("\n")).join("\n\n")}`;
}

export interface SeverityOptions {
  chat: Chat;
  model: string;
  effort: string | null;
  /** The check reads nothing, so this is only the loop's required workspace. */
  workspace: Workspace;
  deadline: number;
  log: (message: string) => void;
}

/**
 * The settled severity of each issue, by id, and each repeat's first issue, by the repeat's id. An issue the check
 * leaves out or gives no known grade, or a check that fails, keeps the judge's grade, and `problem` says so for the
 * review. Only an issue's first entry counts. A sameAs is taken, with or without a grade, only when it names an issue
 * earlier in the list, and is followed to the first of its chain, so no repeat is left without an issue that stands.
 */
export async function settleSeverities(issues: Graded[], options: SeverityOptions): Promise<{ severities: Map<string, Severity>; sameAs: Map<string, string>; problem: string | null }> {
  const severities = new Map(issues.map((issue) => [issue.id, issue.severity]));
  const sameAs = new Map<string, string>();
  if (issues.length < 2) return { severities, sameAs, problem: null };
  const order = new Map(issues.map((issue, index) => [issue.id, index]));
  try {
    const submission = await runAgent({
      chat: options.chat, model: options.model, system: `You settle the severities of a code review's issues.\n\n${UNTRUSTED}`, prompt: severityPrompt(issues),
      workspace: options.workspace, tools: [], submit: severitiesTool, deadline: options.deadline, maxTurns: 4, handInTurns: HAND_IN_TURNS, log: options.log, caller: "severity check",
      ...(options.effort ? { effort: options.effort } : {}),
    });
    const seen = new Set<string>();
    const given = new Set<string>();
    for (const entry of Array.isArray(submission.severities) ? submission.severities : []) {
      if (!entry || typeof entry !== "object") continue;
      const { issue: named, severity, sameAs: first } = entry as Record<string, unknown>;
      // Read trimmed, as its sameAs and grade are: an id the model wrote with a space round it is still the issue's.
      const issue = typeof named === "string" ? named.trim() : "";
      if (!severities.has(issue) || seen.has(issue)) continue;
      seen.add(issue);
      // A repeat is taken whatever grade comes with it: it decides what folds, and so whether a copy is held.
      if (typeof first === "string" && order.has(first.trim()) && order.get(first.trim())! < order.get(issue)!) sameAs.set(issue, first.trim());
      const grade = SEVERITIES.find((known) => known === (typeof severity === "string" ? severity.trim() : severity));
      if (!grade) continue;
      given.add(issue);
      severities.set(issue, grade);
    }
    // Each repeat points at an earlier issue, so following the chain ends, at an issue that repeats none; the bound
    // keeps a cycle, were that rule ever broken, from looping for ever.
    for (const issue of [...sameAs.keys()]) {
      let root = sameAs.get(issue)!;
      for (let steps = 0; sameAs.has(root) && steps < issues.length; steps += 1) root = sameAs.get(root)!;
      sameAs.set(issue, root);
    }
    const left = issues.filter((issue) => !given.has(issue.id)).map((issue) => issue.id);
    return { severities, sameAs, problem: left.length ? `The severity check gave no grade for ${left.join(", ")}, which keep the judge's.` : null };
  } catch (error) {
    options.log(`severity check failed, keeping the judge's grades: ${told(error)}`);
    return { severities, sameAs, problem: "The severity check gave no answer, so every issue keeps the judge's grade, and no issue is folded into another it repeats." };
  }
}
