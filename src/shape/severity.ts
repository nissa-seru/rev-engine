// The severity check at the end of the review: one call reads every issue the judge kept, across every area of the
// review, and settles their severities against one another. Each judging call grades only its own few issues, so
// grades can drift between calls; the review is then grouped by the severities this check gives.
import { runAgent } from "../agent.ts";
import type { Chat } from "../llm.ts";
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
            required: ["issue", "severity"],
            properties: {
              issue: { type: "string", description: "The issue id, exactly as given." },
              severity: { type: "string", enum: [...SEVERITIES] },
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

Hand in a severity for every issue, by its id, by calling submit_severities.

${issues.map((issue) => `### ${issue.id}: ${issue.title}\nThe judge's verdict: ${issue.verdict}. Its grade: ${issue.severity}.\nCauses: ${issue.causes.join("; ")}\nConsequences: ${issue.consequences.join("; ")}\nThe judge's reason: ${issue.why}`).join("\n\n")}`;
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
 * The settled severity of each issue, by id. An issue the check leaves out, or a check that fails, keeps the judge's
 * grade, and `problem` says so for the review.
 */
export async function settleSeverities(issues: Graded[], options: SeverityOptions): Promise<{ severities: Map<string, Severity>; problem: string | null }> {
  const severities = new Map(issues.map((issue) => [issue.id, issue.severity]));
  if (issues.length < 2) return { severities, problem: null };
  try {
    const submission = await runAgent({
      chat: options.chat, model: options.model, system: `You settle the severities of a code review's issues.\n\n${UNTRUSTED}`, prompt: severityPrompt(issues),
      workspace: options.workspace, tools: [], submit: severitiesTool, deadline: options.deadline, maxTurns: 4, handInTurns: HAND_IN_TURNS, log: options.log, caller: "severity check",
      ...(options.effort ? { effort: options.effort } : {}),
    });
    const given = new Set<string>();
    for (const entry of Array.isArray(submission.severities) ? submission.severities : []) {
      if (!entry || typeof entry !== "object") continue;
      const { issue, severity } = entry as Record<string, unknown>;
      const grade = SEVERITIES.find((known) => known === severity);
      if (typeof issue !== "string" || !severities.has(issue) || !grade || given.has(issue)) continue;
      given.add(issue);
      severities.set(issue, grade);
    }
    const left = issues.filter((issue) => !given.has(issue.id)).map((issue) => issue.id);
    return { severities, problem: left.length ? `The severity check gave no grade for ${left.join(", ")}, which keep the judge's.` : null };
  } catch (error) {
    options.log(`severity check failed, keeping the judge's grades: ${error instanceof Error ? error.message : String(error)}`);
    return { severities, problem: "The severity check gave no answer, so every issue keeps the judge's grade." };
  }
}
