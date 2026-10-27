// Stage 2 of the review shape: the two batteries. Every task of the plan, and each of its questions as a task of its
// own, is read once by each battery: battery A on terra or Sol, two consecutive tasks to a call, and battery B on haiku, one
// task to a call, every call at once. Ported from the review workflow's find stage (FIND_SOURCE): its brief for each
// slice kind, its two-part calls, its lenses' "Look for" lists and its answer, with RevEngine's read tools in place
// of a shell in a scratch copy. A battery A call that doesn't answer stops the review, with every answer kept, and
// haiku never reads in its place.
import { runAgent } from "../agent.ts";
import { told, type Chat } from "../llm.ts";
import { UNTRUSTED } from "../prompts.ts";
import { changeTextTool, readTools, safeRelativePath, type ChangeTexts, type ReadRecord, type ToolDefinition, type Workspace } from "../tools.ts";
import { entryHunks, entryOf, HAND_IN_TURNS, KINDS, SEVERITIES, type Finding, type Hunk, type Kind, type Place, type Severity } from "./types.ts";
import type { Lens, Task } from "./plan.ts";

export const FIND_SOURCE = { name: "workflow:review-find", blob: "60c0f6a769e451edb1cf2174ed7a895f7733c7fb" };

/** The change's own text, which a finding may cite as a place. Finders read both with read_change_text, and their brief gives each one's length. */
export const TEXT_FILES = ["change-text.md", "commit-messages.txt"];

/** A text's lines as they are numbered: its own, from its first, with blank lines at its end left off. */
function textLines(text: string): string[] {
  const kept = text.trimEnd();
  return kept ? kept.split("\n") : [];
}

/** A text with each line numbered as it is cited (change-text.md:3), or "(none)" for none. */
export function numbered(text: string): string {
  const lines = textLines(text);
  return lines.length ? lines.map((line, index) => `${index + 1}: ${line}`).join("\n") : "(none)";
}

/** How many lines numbered() shows of a text, 0 for one it shows as "(none)", which no place can cite. */
export function numberedLines(text: string): number {
  return textLines(text).length;
}

export interface Battery {
  /** A capital letter: A for terra or Sol, B for haiku. */
  letter: string;
  model: string;
  effort: string | null;
  /** Tasks per call: 2 for battery A, 1 for haiku. */
  perCall: number;
  /** The context size, in tokens, at which a finder is made to hand in what it has. */
  contextTokens: number;
  /** Whether the model is shown a countdown of its context, as haiku is. */
  countdown: boolean;
  /** Time kept back for the last turn near the review's limit, when the model's turns take longer than the loop's default. */
  wrapUpMs?: number;
}

/** One call of a battery: its id joins its tasks' ids with +, which a task id can't hold. */
export interface FindCall {
  battery: string;
  id: string;
  tasks: Task[];
}

/** What one call handed in, as kept in the run directory, so a resumed review asks only the calls without one. */
export interface FindAnswer {
  battery: string;
  call: string;
  findings: Finding[];
  unread: string[];
  note: string;
  /** True when the finder reached its context bound and was made to hand in what it had. */
  bounded: boolean;
  /** Findings dropped because they were malformed or no place they cite exists, said in the review. */
  dropped: number;
  /** What the finder read, as its workspace recorded it, which says what the review read of the change. */
  reads: ReadRecord[];
}

export const SEVERITY_TEXT = [
  "- blocker: merged as is, it breaks something its users rely on, loses or corrupts data, opens a containment or credential hole, or leaves the change's stated purpose unmet;",
  "- should-fix: a real defect or gap, with a realistic trigger, that review would ask to fix in this change, such as a missed sibling place, a requirement no test pins, or a claim that would mislead whoever acts on it;",
  "- minor: a defect with no realistic trigger, or a stale comment that would mislead whoever maintains the code.",
].join("\n");

const PAIR = "This task has two parts. Each part is a review that a separate worker would otherwise do alone. Do both, and report every defect either part shows in one list, each defect once.";

export const foundTool: ToolDefinition = {
  type: "function",
  function: {
    name: "submit_findings",
    description: "Hand in the defects you found, what you could not cover, and an optional note.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["findings", "unread", "note"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["places", "kind", "claim", "failingCase", "severity"],
            properties: {
              places: {
                type: "array",
                description: "Every place the defect involves, as file and line at head, or at the base for a file the change deletes. The change's own text is change-text.md or commit-messages.txt.",
                items: { type: "object", additionalProperties: false, required: ["file", "line"], properties: { file: { type: "string" }, line: { type: "integer" } } },
              },
              kind: { type: "string", enum: [...KINDS], description: "code: wrong behaviour; test: a requirement or consequent the tests do not pin, or a test that cannot fail; text: a claim the code does not bear out, which would mislead whoever acts on it." },
              claim: { type: "string", description: "One sentence: what is wrong, and the mechanism that makes it so." },
              failingCase: { type: "string", description: "The input, state or sequence that shows it: what should happen, and what happens." },
              severity: { type: "string", enum: [...SEVERITIES] },
            },
          },
        },
        unread: { type: "array", items: { type: "string" }, description: "Parts of the slice you could not cover, if any." },
        note: { type: "string", description: "Optional: anything you want to tell whoever runs this review about doing this task. '' for none." },
      },
    },
  },
};

/** What a finder is told about the change it reads, the same for every task. */
export interface ChangeBrief {
  /** The diff lines (as read_diff numbers them) each changed file's part of the diff spans. */
  diffLines: Map<string, [number, number]>;
  /** Each changed file's hunks, which point a reader of part of a file to the diff lines that change it. */
  hunks: Map<string, Hunk[]>;
  title: string;
  /** The description and commit messages, which the finders read with read_change_text: the prompt gives their size. */
  description: string;
  commitMessages: string;
  facts: string[];
  /** Where dependencies' source is, if the review job installed them. */
  dependencies: string;
  /** Said when the base is the head of an earlier review rather than where the pull request branches. */
  roundNote: string;
  /** The area's files when the plan has several areas, which its state and question readers keep to; null for one. */
  areaFiles: string[] | null;
}

function lensText(ids: string[], lenses: Record<string, Lens>): string {
  return ids.map((id) => `**${lenses[id]!.title}**\n${lenses[id]!.lookFor.trim()}`).join("\n\n");
}

const pathOf = (entry: string): string => entryOf(entry).path;
function fileText(entry: string): string {
  const { path, range } = entryOf(entry);
  return range ? `${path} (lines ${range[0]}–${range[1]})` : entry;
}
const filesText = (entries: string[]): string => entries.map(fileText).join(", ");
const purposeText = (purpose: string | undefined): string => purpose?.trim() ? ` Responsibility to check against the code: ${purpose.trim().replace(/([^.!?])$/, "$1.")}` : "";

/** Where read_diff shows what changed in a file, or for part of one, in the hunks that reach into that part. */
function diffOf(change: ChangeBrief, file?: string): string {
  if (!file) return "read_diff shows the whole change";
  const lines = change.diffLines.get(pathOf(file));
  if (!lines) return "the diff doesn't touch it";
  if (!entryOf(file).range) return `read_diff lines ${lines[0]} to ${lines[1]} show what changed in it`;
  const hunks = entryHunks(change.hunks, file);
  return hunks.length ? `read_diff lines ${hunks[0]!.lines[0]} to ${hunks.at(-1)!.lines[1]} show the changes around those lines` : "no hunk of the diff reaches those lines";
}

/** What a state or question reader reads: the whole change, or in a plan of several areas, the area's files. */
function reachOf(change: ChangeBrief): { diff: string; where: string } {
  const files = change.areaFiles;
  if (!files?.length) return { diff: diffOf(change), where: "the change, and in the code it touches" };
  return {
    diff: `This review reads one area of a larger change, its files ${filesText(files)}: ${files.map((file) => `for ${file}, ${diffOf(change, file)}`).join("; ")}`,
    where: "the area's files, and in the code they touch",
  };
}

/** The brief for one task, as the ported find stage words it for each kind of slice. */
export function taskBrief(task: Task, change: ChangeBrief, lenses: Record<string, Lens>): string {
  const slice = task.slice;
  const ids = task.lenses;
  const through = ids.length === 1 ? " through this one lens, and report the defects it shows:" : " Look for defects through these lenses:";
  if (slice.kind === "whole") {
    return ids.length
      ? `You are reviewing a code change. ${diffOf(change)}. Review the whole change${ids.length === 1 ? through : `.${through}`}\n\n${lensText(ids, lenses)}`
      : `You are reviewing a code change. ${diffOf(change)}. Review the whole change and report the defects you find.`;
  }
  if (slice.kind === "files") {
    const files = slice.files ?? [];
    const one = files.length === 1;
    const head = one
      ? `You are reviewing one file of a code change: ${fileText(files[0]!)}. ${diffOf(change, files[0])}.${purposeText(slice.purpose)}`
      : `You are reviewing these files of a code change: ${filesText(files)}. ${diffOf(change)}; ${files.map((file) => `for ${fileText(file)}, ${diffOf(change, file)}`).join("; ")}.${purposeText(slice.purpose)}`;
    return ids.length
      ? `${head} Read what ${one ? "it touches" : "they touch"} as you need to.${ids.length === 1 ? ` Review ${one ? "it" : "them"}${through}` : through}\n\n${lensText(ids, lenses)}`
      : `${head} Read what ${one ? "it touches" : "they touch"} as you need to, and report the defects you find.`;
  }
  if (slice.kind === "tests") {
    const lensed = ids.length === 1 ? " Review them through this one lens, and report the defects it shows:" : through;
    // A ranged entry is sized by the hunks that reach its lines, so its brief points at them, as a files slice's does.
    const ranged = (slice.files ?? []).filter((file) => entryOf(file).range);
    return `You are reviewing the tests of a code change against its code. ${reachOf(change).diff}; its tests are ${filesText(slice.files ?? [])}${ranged.length ? `, and ${ranged.map((file) => `for ${fileText(file)}, ${diffOf(change, file)}`).join("; ")}` : ""}.${purposeText(slice.purpose)}${ids.length ? `${lensed}\n\n${lensText(ids, lenses)}` : " Report the defects you find in them, and the requirements of the change no test pins."}`;
  }
  if (slice.kind === "state") {
    const reach = reachOf(change);
    return `You are reviewing a code change by following one piece of state. ${reach.diff}. The state: ${(slice.state ?? "").trim()} Find every place in ${reach.where}, that creates, reads, changes or discards it, and check that each one handles it correctly in every case. Report the defects you find.${ids.length ? ` These lenses may help:\n\n${lensText(ids, lenses)}` : ""}`;
  }
  // a question of the plan
  return `You are reviewing a code change to answer one question about it. ${reachOf(change).diff}. The question: ${(slice.question ?? "").trim()}\nAnswer it from the code, at the base and at head as it needs. Report each defect the answer shows. If it shows none, return an empty list.`;
}

/**
 * Where the change's description and commit messages are, and how many lines each has. They aren't in the prompt, as
 * the ported find stage leaves them as files a finder reads when it wants them: written into the prompt, they took that
 * much of every finder's context in every request, before it read any code.
 */
export function changeTextsText(change: ChangeBrief): string {
  const size = (text: string): string => {
    const lines = numberedLines(text);
    return `${lines} line${lines === 1 ? "" : "s"}`;
  };
  return `Its description (${size(change.description)}) and commit messages (${size(change.commitMessages)}) aren't files in the checkout: read them with read_change_text, and cite them as change-text.md and commit-messages.txt by the line numbers it gives. Commit messages too long to give whole end at [cut here].`;
}

/** The whole prompt for one call: its task's brief, or its two parts, then what every finder is told. */
export function callPrompt(call: FindCall, battery: Battery, change: ChangeBrief, lenses: Record<string, Lens>): string {
  const body = call.tasks.length === 1
    ? taskBrief(call.tasks[0]!, change, lenses)
    : `${PAIR}\n\n${call.tasks.map((task, index) => `Part ${index + 1} of ${call.tasks.length}. ${taskBrief(task, change, lenses)}`).join("\n\n")}`;
  const facts = change.facts.length
    ? `\n\nFacts about the platform and the services this code runs against, from the review's plan. Each is the planner's reading of a source it names:\n${change.facts.map((fact) => `- ${fact.trim()}`).join("\n")}`
    : "";
  const context = battery.countdown
    ? `- Your context holds about ${battery.contextTokens.toLocaleString("en-US")} tokens, and a countdown shows what is left. Stop with room to spare for your answer, and name in \`unread\` anything you were asked to cover and couldn't.`
    : `- Your context holds about ${battery.contextTokens.toLocaleString("en-US")} tokens. Stop with room to spare for your answer, and name in \`unread\` anything you were asked to cover and couldn't.`;
  return `${body}${facts}

The pull request's title: ${change.title || "(none)"}

${changeTextsText(change)}

${change.dependencies}${change.roundNote ? `\n${change.roundNote}` : ""}

How to work:
- Read with the tools: read_diff for the change, read_file for a file at head, read_base_file for a file at the base, read_change_text for the description and commit messages, list_files and search to find code. They read only this checkout, as it stood at the pull request's head, and the change's own text.
${context}

Report only defects you can point to in the code, each with every place it involves (file and line at head, or at the base for a file the change deletes), its kind, a one-sentence claim with its mechanism, the failing case, and its severity:
${SEVERITY_TEXT}
If you find nothing, return an empty list: that is a good answer when it is true.

If you'd like to tell whoever runs this review anything about doing this task, write it in \`note\`. It's optional.

Hand in your answer by calling submit_findings.`;
}

/** Each battery's calls over the plan's tasks: one task each, or `perCall` consecutive ones, the last alone when they don't divide. */
export function callsOf(battery: Battery, tasks: Task[]): FindCall[] {
  const calls: FindCall[] = [];
  for (let start = 0; start < tasks.length; start += battery.perCall) {
    const part = tasks.slice(start, start + battery.perCall);
    calls.push({ battery: battery.letter, id: part.map((task) => task.id).join("+"), tasks: part });
  }
  return calls;
}

function text(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Where a place can be read: its file's line count at head, or at the base for a file the change deletes or moves
 * (marked so), or null when neither has it.
 */
export type PlaceLines = (path: string) => Promise<{ lines: number; base: boolean } | null>;

/**
 * The findings of one submission, each with its places checked: a place in a file neither head nor base has is left
 * out, a line past the file's end is moved to its last line, and a finding with no place left is dropped and counted,
 * as is an entry with no claim, or a findings value that isn't a list.
 */
export async function checkedFindings(
  raw: unknown, battery: string, call: FindCall, placeLines: PlaceLines,
): Promise<{ findings: Finding[]; dropped: number }> {
  const findings: Finding[] = [];
  let dropped = 0;
  const task = call.tasks.length === 1 ? call.tasks[0]!.id : call.id;
  if (!Array.isArray(raw)) dropped += 1;
  for (const entry of Array.isArray(raw) ? raw : []) {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const claim = text(item.claim, 2_000);
    if (!claim) {
      dropped += 1;
      continue;
    }
    const places: Place[] = [];
    for (const spot of Array.isArray(item.places) ? item.places : []) {
      if (!spot || typeof spot !== "object") continue;
      const { file, line } = spot as Record<string, unknown>;
      if (typeof file !== "string") continue;
      // A path as given, or without a diff's a/ or b/ prefix when the path as given isn't a file. It is kept in the
      // spelling the file tools read it in (forward slashes, no ./), so the places' filters see the path itself.
      let given: string;
      try {
        given = safeRelativePath(file.trim());
      } catch {
        continue;
      }
      let path = given;
      let found = await placeLines(given);
      if (found === null && /^[ab]\//.test(given)) {
        path = given.slice(2);
        found = await placeLines(path);
      }
      if (found === null) continue;
      const number = Number.isInteger(line) && (line as number) > 0 ? line as number : 1;
      places.push({ file: path, line: Math.min(number, Math.max(found.lines, 1)), ...(found.base ? { base: true as const } : {}) });
    }
    if (!places.length) {
      dropped += 1;
      continue;
    }
    findings.push({
      key: "",
      task,
      kind: (KINDS as readonly string[]).includes(item.kind as string) ? item.kind as Kind : "code",
      severity: (SEVERITIES as readonly string[]).includes(item.severity as string) ? item.severity as Severity : "minor",
      claim,
      failingCase: text(item.failingCase, 4_000),
      places,
    });
  }
  // Keys number the kept findings in order, so a call's keys run [0], [1]… with no gaps.
  findings.forEach((finding, index) => { finding.key = `${battery}:${task}[${index}]`; });
  return { findings, dropped };
}

export interface FindOptions {
  chat: Chat;
  batteries: Battery[];
  tasks: Task[];
  change: ChangeBrief;
  lenses: Record<string, Lens>;
  /** A workspace for each call, so each finder's reads are kept apart, serving the texts it's given with read_change_text. */
  workspace: (texts: ChangeTexts) => Workspace;
  placeLines: PlaceLines;
  deadline: number;
  maxTurns: number;
  log: (message: string) => void;
  /** Names the calls and their conversations, such as "core" for an area. */
  scope: string;
  /** Answers kept from an earlier run of this review, by battery and call id: those calls aren't asked again. */
  kept: FindAnswer[];
  /** Hears each answer as it arrives, so it is kept even if a later call stops the review. */
  onAnswer: (answer: FindAnswer) => Promise<void>;
}

export interface FindOutcome {
  answers: FindAnswer[];
  /** Calls that gave no answer, with why and when. A first-battery failure stops the review; a haiku one is a shortfall. */
  failed: Array<{ battery: string; call: string; error: unknown; at: number }>;
}

/** Asks every call of every battery at once, except those with a kept answer. A kept answer to no call of these tasks is set aside. */
export async function runFind(options: FindOptions): Promise<FindOutcome> {
  const calls = options.batteries.flatMap((battery) => callsOf(battery, options.tasks).map((call) => ({ battery, call })));
  const callIds = new Set(calls.map(({ battery, call }) => `${battery.letter}:${call.id}`));
  const answers = options.kept.filter((answer) => callIds.has(`${answer.battery}:${answer.call}`));
  const keptIds = new Set(answers.map((answer) => `${answer.battery}:${answer.call}`));
  const failed: FindOutcome["failed"] = [];
  await Promise.all(calls.filter(({ battery, call }) => !keptIds.has(`${battery.letter}:${call.id}`)).map(async ({ battery, call }) => {
    const caller = `${options.scope} ${battery.letter}:${call.id}`;
    const report = { bounded: false };
    // The texts the prompt gives the length of, so what read_change_text serves is what the brief describes.
    const workspace = options.workspace({ description: options.change.description, commitMessages: options.change.commitMessages });
    try {
      const submission = await runAgent({
        chat: options.chat, model: battery.model, system: `You review a code change, reading it with read-only tools.\n\n${UNTRUSTED}`,
        prompt: callPrompt(call, battery, options.change, options.lenses), workspace, tools: [...readTools, changeTextTool], submit: foundTool,
        deadline: options.deadline, maxTurns: options.maxTurns, handInTurns: HAND_IN_TURNS, log: options.log, caller,
        ...(battery.effort ? { effort: battery.effort } : {}),
        contextBound: battery.contextTokens, report, conversation: caller, onFailedTurn: "throw",
        ...(battery.countdown ? { taskBudget: battery.contextTokens } : {}),
        ...(battery.wrapUpMs ? { wrapUpMs: battery.wrapUpMs } : {}),
      });
      const { findings, dropped } = await checkedFindings(submission.findings, battery.letter, call, options.placeLines);
      const answer: FindAnswer = {
        battery: battery.letter, call: call.id, findings, unread: Array.isArray(submission.unread) ? submission.unread.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [],
        note: typeof submission.note === "string" ? submission.note.trim() : "", bounded: report.bounded, dropped, reads: [...workspace.reads],
      };
      answers.push(answer);
      // An answer the run couldn't keep is still this run's answer; only a resume would have to ask it again.
      await options.onAnswer(answer).catch((error: unknown) => options.log(`${caller}: its answer couldn't be kept for a resume: ${told(error)}`));
      options.log(`${caller}: ${findings.length} finding(s)${dropped ? `, ${dropped} dropped as malformed or citing no file` : ""}${report.bounded ? ", handed in at its context bound" : ""}`);
    } catch (error) {
      failed.push({ battery: battery.letter, call: call.id, error, at: Date.now() });
      options.log(`${caller} gave no answer: ${told(error)}`);
    }
  }));
  return { answers, failed };
}
