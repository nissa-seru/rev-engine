// Stage 1 of the review shape: a planner reads the change, what the project says about itself, and the code, and
// writes the review's plan: the facts every finder is told, and one area or several, each with its tasks (a slice
// of the change and up to four lenses) and its questions. Then the plan is checked, and asked for once more with
// its problems named; what still fails is repaired and said in the review.
import { runAgent } from "../agent.ts";
import { ModelRefused, ModelUnavailable, told, type Chat } from "../llm.ts";
import { UNTRUSTED, type ProjectRule } from "../prompts.ts";
import { repositoryPath, type ToolDefinition, type Workspace } from "../tools.ts";
import { PLAN_GUIDANCE } from "./plan-guidance.ts";
import { entryHunks, entryOf, HAND_IN_TURNS, type Hunk } from "./types.ts";

export interface Lens {
  title: string;
  lookFor: string;
  /** The reference it is ported from, and that reference's blob, so a refresh can tell when it changed. */
  name: string;
  blob: string;
}

export type SliceKind = "whole" | "files" | "tests" | "state" | "question";

export interface Slice {
  kind: SliceKind;
  /** For files and tests: paths at head, or of files the change deletes, each optionally with a line range at head as path:from-to. */
  files?: string[];
  /** For state: the one piece of state to follow, in words. */
  state?: string;
  /** For files and tests, optional: the responsibility its reader checks the code against. */
  purpose?: string;
  /** For a question of the plan, which runs as a task of its own. */
  question?: string;
}

export interface Task {
  id: string;
  slice: Slice;
  lenses: string[];
}

export interface Area {
  /** Letters, digits and dashes; "all" when the plan has one area. */
  name: string;
  /** The changed files this area covers; [] when there is one area. */
  files: string[];
  questions: string[];
  tasks: Task[];
}

export interface Plan {
  facts: string[];
  areas: Area[];
  note: string;
}

/** About what one reader can take of a slice, in characters of diff, as the review shape cuts large changes. */
export const MAX_SLICE_CHARS = 90_000;
/** Lenses one task may carry. */
export const MAX_LENSES = 4;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** An area's name, which names a run directory and is kept short for it. */
const AREA = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FILE = /^[^:\s][^:\n]*?(:[1-9][0-9]*-[1-9][0-9]*)?$/;

const sliceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["whole", "files", "tests", "state"] },
    files: { type: "array", items: { type: "string" }, description: "For files and tests: paths of files at head, or of files the change deletes, each optionally with a line range at head as path:start-end." },
    state: { type: "string", description: "For state: the one piece of state to follow, in words." },
    purpose: { type: "string", description: "Optional, and only on a files or tests slice: the responsibility its reader checks the code against, in a sentence." },
  },
};

export function planTool(lensIds: string[]): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "submit_plan",
      description: "Hand in the review's plan: its facts, and its areas with their tasks and questions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["facts", "areas", "note"],
        properties: {
          facts: { type: "array", items: { type: "string" }, description: "Each outside component's contract the change's correctness rests on, as you read it, with where you read it. [] when none." },
          areas: {
            type: "array",
            description: "One area holding the whole plan, unless the change is too large for one review; then several, which together cover every changed line.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "files", "questions", "tasks"],
              properties: {
                name: { type: "string", description: "A short name: lower-case letters, digits and dashes. 'all' when there is one area." },
                files: { type: "array", items: { type: "string" }, description: "The changed files this area covers. [] when there is one area." },
                questions: { type: "array", items: { type: "string" }, description: "What you're unsure of in this area, each as a question one reader answers over the area. [] when none." },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "slice", "lenses"],
                    properties: {
                      id: { type: "string", description: "Letters, digits, dot, dash and underscore, starting with a letter or digit; not q1, q2… (kept for the questions)." },
                      slice: sliceSchema,
                      lenses: { type: "array", items: { type: "string", enum: lensIds }, description: `The lenses this reader applies, by id, at most ${MAX_LENSES}. [] for a reader with none.` },
                    },
                  },
                },
              },
            },
          },
          note: { type: "string", description: "Anything a reader of the review should know about the plan, such as generated or vendored files left out of every slice. '' for none." },
        },
      },
    },
  };
}

export interface PlanInput {
  nwo: string;
  title: string;
  description: string;
  commitMessages: string;
  diffChars: number;
  rules: ProjectRule[];
  documents: string[];
  changedFiles: string[];
  /** Said when the review reads only what changed since an earlier review's head, which its base files then are. */
  roundNote?: string;
}

export const PLANNER_SYSTEM = `You plan the review of a code change. You read with read-only tools, and you don't review the change yourself.

${UNTRUSTED}`;

export function plannerPrompt(input: PlanInput): string {
  const rules = input.rules.length ? input.rules.map((rule) => `<project_rule path="${rule.path}">\n${rule.text}\n</project_rule>`).join("\n\n") : "(none at the base)";
  return `You're planning the review of a code change, as its author would before handing it to a review workflow. You don't review the change yourself: your plan decides how it is read. Each task in it is a reader, a model given one slice of the change and up to four lenses, and every task, and every question you ask, is read twice, by two readers working apart, one on a large model and one on a small one. So the plan's size is the review's cost: plans for changes like this one run 6 to 12 tasks and questions together.

The change is a pull request to ${input.nwo}, titled "${input.title}". read_diff reads its diff: ${input.diffChars.toLocaleString("en-US")} characters, across ${input.changedFiles.length} changed file(s). Its description and commit messages are below.

Before you plan, read what the project says about itself and its rules: its README, and the design documents beside the changed code. The project's rule files, as the base has them, are below; read_base_file reads any other file as the base has it.${input.roundNote ? ` ${input.roundNote}` : ""} Then read the change and the code around it with read_diff, read_file, list_files and search. The facts you state are your reading of the sources, so name where you read each one: where the guidance below says a fact is stated as checked, write what you read, since you can read but not run anything.

What a plan holds, from the guidance plans are written by:

${PLAN_GUIDANCE}

**A change too large for one review.** A reader can take about ${MAX_SLICE_CHARS.toLocaleString("en-US")} characters of slice. When the change's diff is larger than that, cut it into areas: each a set of changed files whose diff fits a reader, and every changed line in some area. Each area is reviewed on its own, with its own tasks and questions, and its tasks read its files through \`files\` and \`tests\` slices, since a \`whole\` slice would read the entire change. An area's questions and \`state\` slices are read over the area's own files. Lines nobody wrote by hand go in no slice: lockfiles, generated \`.min.js\`, \`.map\` and \`.snap\` files, and vendored code under \`vendor/\`, \`vendored/\`, \`third_party/\` or \`third-party/\`, wherever they sit. Name them in \`note\`. Every other changed file is in some slice. When the change fits one reader, give one area named \`all\`, with \`files: []\`.

Return the plan's facts and its areas, each with its tasks and questions, by calling submit_plan. Give each task an id, a slice and its lenses. A slice takes one of these forms: \`{ "kind": "whole" }\`; \`{ "kind": "files", "files": [...] }\` or \`{ "kind": "tests", "files": [...] }\`, each entry a path at head, a file the change deletes, or path:start-end at head, with an optional \`purpose\`; or \`{ "kind": "state", "state": "..." }\`. A purpose goes only on a files or tests slice.

<project_rules>
${rules}
</project_rules>

Design documents beside the changed code: ${input.documents.length ? input.documents.join(", ") : "none found"}.

<description>
${input.description.trim() || "(none)"}
</description>

<commit_messages>
${input.commitMessages.trim() || "(none)"}
</commit_messages>`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
}

/**
 * A plan's file entries named as the diff names them (`./src/a.ts` as `src/a.ts`), a range kept, so a slice is measured,
 * pointed to and counted against the diff's own names, as the workspace already reads it.
 */
function files(value: unknown): string[] {
  return strings(value).map((entry) => {
    const { path, range } = entryOf(entry);
    return range ? `${repositoryPath(path)}:${range[0]}-${range[1]}` : repositoryPath(entry);
  });
}

/** The plan a submission gives, read leniently: what's malformed becomes empty and is caught by the check. */
export function parsePlan(value: Record<string, unknown>): Plan {
  const areas = (Array.isArray(value.areas) ? value.areas : []).flatMap((entry): Area[] => {
    if (!entry || typeof entry !== "object") return [];
    const area = entry as Record<string, unknown>;
    const tasks = (Array.isArray(area.tasks) ? area.tasks : []).flatMap((item): Task[] => {
      if (!item || typeof item !== "object") return [];
      const task = item as Record<string, unknown>;
      const slice = (task.slice && typeof task.slice === "object" ? task.slice : {}) as Record<string, unknown>;
      const kind = (["whole", "files", "tests", "state"] as const).find((known) => known === slice.kind);
      return [{
        id: typeof task.id === "string" ? task.id.trim() : "",
        slice: {
          kind: kind ?? "whole",
          ...(kind === "files" || kind === "tests" ? { files: files(slice.files) } : {}),
          ...(kind === "state" && typeof slice.state === "string" ? { state: slice.state.trim() } : {}),
          ...((kind === "files" || kind === "tests") && typeof slice.purpose === "string" && slice.purpose.trim() ? { purpose: slice.purpose.trim() } : {}),
        },
        lenses: strings(task.lenses),
      }];
    });
    return [{ name: typeof area.name === "string" ? area.name.trim() : "", files: files(area.files), questions: strings(area.questions), tasks }];
  });
  return { facts: strings(value.facts), areas, note: typeof value.note === "string" ? value.note.trim() : "" };
}

export interface PlanContext {
  lensIds: string[];
  /** Each changed file's size in characters of diff. */
  diffChars: Map<string, number>;
  /** Each changed file's hunks, which measure a slice of part of a file. */
  hunks: Map<string, Hunk[]>;
  /** Files no slice needs to cover: generated and vendored files and lockfiles. */
  generated: (path: string) => boolean;
  /** Lines in a file at head, or null when there is no readable file there. */
  headLines: (path: string) => Promise<number | null>;
}

const pathOf = (entry: string): string => entryOf(entry).path;

/**
 * Characters of diff a state or question reader is shown: the whole change, or in a plan of several areas, its area's
 * files, as its brief says.
 */
function reachChars(area: Area, several: boolean, context: PlanContext): number {
  return several
    ? area.files.reduce((sum, path) => sum + (context.diffChars.get(path) ?? 0), 0)
    : [...context.diffChars.values()].reduce((sum, size) => sum + size, 0);
}

/**
 * Characters of diff a task's slice holds: its files' parts, a part of a file counted by the hunks that reach into its
 * range, each part or hunk once; or for a whole or state slice, what reachChars counts.
 */
function sliceChars(task: Task, area: Area, several: boolean, context: PlanContext): number {
  if (task.slice.kind === "files" || task.slice.kind === "tests") {
    const entries = task.slice.files ?? [];
    const whole = new Set(entries.filter((entry) => !entryOf(entry).range).map(pathOf));
    const parts = new Set(entries.filter((entry) => !whole.has(pathOf(entry))).flatMap((entry) => entryHunks(context.hunks, entry)));
    return [...whole].reduce((sum, path) => sum + (context.diffChars.get(path) ?? 0), 0) + [...parts].reduce((sum, hunk) => sum + hunk.chars, 0);
  }
  return reachChars(area, several, context);
}

/** The plan's problems, each said so the planner can fix it. Empty when the plan passes. */
export async function checkPlan(plan: Plan, context: PlanContext): Promise<string[]> {
  const problems: string[] = [];
  const lensIds = new Set(context.lensIds);
  if (!plan.areas.length) return ["the plan has no areas"];
  const several = plan.areas.length > 1;
  const names = plan.areas.map((area) => area.name);
  if (new Set(names).size !== names.length) problems.push("two areas have the same name");
  if (!several && plan.areas[0]!.name !== "all") problems.push(`a plan with one area names it "all", not "${plan.areas[0]!.name}"`);
  for (const area of plan.areas) {
    const where = several ? `area ${area.name}` : "the plan";
    if (several && !AREA.test(area.name)) problems.push(`area "${area.name}": a name is lower-case letters, digits and dashes, at most 40`);
    if (!area.tasks.length) problems.push(`${where} has no tasks`);
    const ids = area.tasks.map((task) => task.id);
    if (new Set(ids).size !== ids.length) problems.push(`${where}: two tasks have the same id`);
    if (several) {
      if (!area.files.length) problems.push(`area ${area.name} names no files; its tasks and questions read its files`);
      for (const file of area.files) if (!context.diffChars.has(file)) problems.push(`area ${area.name} names ${file}, which the change doesn't change`);
    }
    for (const task of area.tasks) {
      const named = `${where}, task ${task.id || "(no id)"}`;
      if (!ID.test(task.id) || /^q\d+$/.test(task.id)) problems.push(`${named}: an id is letters, digits, dot, dash and underscore, starting with a letter or digit, and not q1, q2…`);
      if (task.lenses.length > MAX_LENSES) problems.push(`${named} has ${task.lenses.length} lenses; a task takes at most ${MAX_LENSES}`);
      const unknown = task.lenses.filter((lens) => !lensIds.has(lens));
      if (unknown.length) problems.push(`${named} names lenses that don't exist: ${unknown.join(", ")}`);
      if (new Set(task.lenses).size !== task.lenses.length) problems.push(`${named} names a lens twice`);
      const slice = task.slice;
      if (slice.kind === "files" || slice.kind === "tests") {
        if (!slice.files?.length) problems.push(`${named}: a ${slice.kind} slice names its files`);
        for (const entry of slice.files ?? []) {
          const found = await entryFits(entry, context);
          if (found === "missing") problems.push(`${named}: ${entry} is not a file at head, nor one the change deletes`);
          else if (found === "range") problems.push(`${named}: ${entry} names a range that starts past the file's end at head, ends before it starts, or is in a file the change deletes`);
        }
      }
      if (slice.kind === "state" && !slice.state) problems.push(`${named}: a state slice names its state in words`);
      if (several && slice.kind === "whole") problems.push(`${named}: in a plan of several areas, a whole slice would read the entire change; read the area's files through files and tests slices`);
      const size = sliceChars(task, area, several, context);
      if (size > MAX_SLICE_CHARS) problems.push(`${named}: its slice holds ${size.toLocaleString("en-US")} characters of diff, past the ${MAX_SLICE_CHARS.toLocaleString("en-US")} a reader can take; ${several ? "cut it smaller" : "cut the change into areas"}`);
    }
    const reach = reachChars(area, several, context);
    if (area.questions.length && reach > MAX_SLICE_CHARS) problems.push(`${where}: its questions are read over ${reach.toLocaleString("en-US")} characters of diff, past the ${MAX_SLICE_CHARS.toLocaleString("en-US")} a reader can take; ${several ? "cut the area smaller" : "cut the change into areas"}`);
  }
  if (several) {
    const covered = new Set(plan.areas.flatMap((area) => area.files));
    const left = [...context.diffChars.keys()].filter((file) => !covered.has(file) && !context.generated(file));
    if (left.length) problems.push(`these changed files are in no area: ${left.join(", ")}`);
  }
  // Each changed file is some task's to read: a whole slice reads them all, and otherwise a files or tests slice names
  // it whole or its ranges take every hunk that changes it (unsliced). State and question readers follow what they're
  // asked about, not every file. Generated files go in no slice.
  for (const area of plan.areas) {
    const unread = unsliced(area, several, context);
    if (unread.length) problems.push(`${several ? `area ${area.name} names files that are` : "these changed files are"} in no task's slice, or only in ranges, which read a file only when they take every hunk that changes it (a file whose change has no hunk, such as a rename, needs a whole entry): ${unread.join(", ")}`);
  }
  return problems;
}

/**
 * The changed files a plan's area holds (its files in a plan of several, the whole change in one) that no slice of
 * it reads: none when a task reads the whole change, and never a generated, vendored or lock file. A file is read when
 * a files or tests slice names it whole, or when its slices' ranges together take every hunk that changes it.
 */
function unsliced(area: Area, several: boolean, context: PlanContext): string[] {
  if (!several && area.tasks.some((task) => task.slice.kind === "whole")) return [];
  const entries = area.tasks.flatMap((task) => task.slice.kind === "files" || task.slice.kind === "tests" ? task.slice.files ?? [] : []);
  const whole = new Set(entries.filter((entry) => !entryOf(entry).range).map(pathOf));
  const taken = new Set(entries.filter((entry) => entryOf(entry).range).flatMap((entry) => entryHunks(context.hunks, entry)));
  const ranged = (file: string): boolean => (context.hunks.get(file) ?? []).length > 0 && context.hunks.get(file)!.every((hunk) => taken.has(hunk));
  const files = several ? area.files.filter((file) => context.diffChars.has(file)) : [...context.diffChars.keys()];
  return files.filter((file) => !whole.has(file) && !ranged(file) && !context.generated(file));
}

/**
 * Whether a files or tests entry names what a reader can read: a file at head, its range (if any) starting inside
 * the file and not ending before it starts; or a file the change deletes, whole, read through its diff and the base.
 */
async function entryFits(entry: string, context: PlanContext): Promise<"ok" | "missing" | "range"> {
  if (!FILE.test(entry)) return "missing";
  const path = pathOf(entry);
  const lines = await context.headLines(path);
  const range = entry.match(/:([0-9]+)-([0-9]+)$/);
  if (lines === null) return !context.diffChars.has(path) ? "missing" : range ? "range" : "ok";
  return !range || (Number(range[1]) <= Number(range[2]) && Number(range[1]) <= lines) ? "ok" : "range";
}

/**
 * A plan that runs, from one that still fails its checks after the second ask: unknown and surplus lenses, files
 * neither at head nor deleted by the change, and ranges that don't fit their file are taken out, tasks left with nothing
 * to read are dropped, and changed files in no area get an area of their own. What was repaired is returned to be said
 * in the review.
 */
export async function repairPlan(plan: Plan, context: PlanContext): Promise<{ plan: Plan; repairs: string[] }> {
  const repairs: string[] = [];
  const lensIds = new Set(context.lensIds);
  const several = plan.areas.length > 1;
  const areas: Area[] = [];
  // Names the plan gave and the repair's own never collide, since each names a run directory and each answer's file.
  const taken = new Set(plan.areas.map((area) => area.name).filter((name) => AREA.test(name)));
  if (!plan.areas.length) {
    // A plan with no area would review nothing and read as a clean review.
    repairs.push("the plan had no areas, so the whole change is read as one area by a task with no lens");
    return { plan: { ...plan, areas: [{ name: "all", files: [], questions: [], tasks: [{ id: "whole-nolens", slice: { kind: "whole" }, lenses: [] }] }] }, repairs };
  }
  for (const [index, given] of plan.areas.entries()) {
    const name = several ? (AREA.test(given.name) && !areas.some((other) => other.name === given.name) ? given.name : unique(`area-${index + 1}`, taken)) : "all";
    // An area's files are the change's files it names: one the change doesn't change has nothing to read.
    const area = several ? { ...given, files: given.files.filter((file) => context.diffChars.has(file)) } : given;
    const unchanged = given.files.filter((file) => !area.files.includes(file));
    if (unchanged.length) repairs.push(`area ${name} lost files the change doesn't change: ${unchanged.join(", ")}`);
    const ids = new Set(area.tasks.map((task) => task.id).filter((id) => ID.test(id) && !/^q\d+$/.test(id)));
    const tasks: Task[] = [];
    for (const [position, task] of area.tasks.entries()) {
      const lenses = [...new Set(task.lenses.filter((lens) => lensIds.has(lens)))].slice(0, MAX_LENSES);
      const left = task.lenses.filter((lens) => !lenses.includes(lens));
      if (left.length) repairs.push(`task ${task.id || position + 1} of ${name} lost lenses it couldn't take: ${[...new Set(left)].join(", ")}`);
      const slice = { ...task.slice };
      if (slice.kind === "files" || slice.kind === "tests") {
        const kept: string[] = [];
        for (const entry of slice.files ?? []) {
          if ((await entryFits(entry, context)) === "ok") kept.push(entry);
          else repairs.push(`task ${task.id || position + 1} of ${name} lost ${entry}, which isn't a file at head or the change deletes, or a range it holds`);
        }
        if (!kept.length) {
          repairs.push(`task ${task.id || position + 1} of ${name} was dropped: none of its files is at head`);
          continue;
        }
        slice.files = kept;
      }
      if (slice.kind === "state" && !slice.state) {
        repairs.push(`task ${task.id || position + 1} of ${name} was dropped: its state slice names no state`);
        continue;
      }
      if (several && slice.kind === "whole") {
        slice.kind = "files";
        slice.files = area.files;
        if (!slice.files.length) {
          repairs.push(`task ${task.id || position + 1} of ${name} was dropped: a whole slice in an area that names no files`);
          continue;
        }
      }
      const id = ID.test(task.id) && !/^q\d+$/.test(task.id) && !tasks.some((other) => other.id === task.id) ? task.id : unique(`t${position + 1}`, ids);
      if (id !== task.id) repairs.push(`task ${task.id || position + 1} of ${name} was renamed ${id}`);
      tasks.push({ id, slice, lenses });
    }
    if (several && !area.files.length) {
      // Its tasks and questions read its files, and it has none.
      repairs.push(`area ${name} was dropped: it named no file the change changes${area.questions.length ? `, so its ${area.questions.length} question(s) had nothing to read` : ""}`);
      continue;
    }
    if (!tasks.length) tasks.push({ id: "whole-nolens", slice: several ? { kind: "files", files: area.files } : { kind: "whole" }, lenses: [] });
    // Files no slice of it reads get a task of their own, so no changed file goes unread.
    const unread = unsliced({ ...area, tasks }, several, context);
    if (unread.length) {
      tasks.push({ id: unique("unsliced", ids), slice: { kind: "files", files: unread }, lenses: [] });
      repairs.push(`${several ? `area ${name}'s files` : "changed files"} that no task read, whole or by ranges taking every hunk that changes them, got a task of their own, with no lens: ${unread.join(", ")}`);
    }
    areas.push({ ...area, name, tasks });
  }
  if (several && !areas.length && [...context.diffChars.keys()].every((file) => context.generated(file))) {
    // Every area was dropped and every changed file is left to its source, so no "rest" area follows: a plan with no
    // area would review nothing and read as a clean review.
    repairs.push("no area named a file the change changes, so the whole change is read as one area by a task with no lens");
    return { plan: { ...plan, areas: [{ name: "all", files: [], questions: [], tasks: [{ id: "whole-nolens", slice: { kind: "whole" }, lenses: [] }] }] }, repairs };
  }
  if (several) {
    const covered = new Set(areas.flatMap((area) => area.files));
    const left = [...context.diffChars.keys()].filter((file) => !covered.has(file) && !context.generated(file));
    if (left.length) {
      const rest = unique("rest", new Set(areas.map((area) => area.name)));
      areas.push({ name: rest, files: left, questions: [], tasks: [{ id: "rest", slice: { kind: "files", files: left }, lenses: [] }] });
      repairs.push(`changed files in no area were given an area of their own, "${rest}", read with no lens: ${left.join(", ")}`);
    }
  }
  // Not cut: the planner's second ask had the last word on how to slice it, and its readers hand in at their bound.
  // Measured once every task is in, the repair's own included.
  const final = areas.length > 1;
  for (const area of areas) {
    for (const task of area.tasks) {
      const size = sliceChars(task, area, final, context);
      if (size > MAX_SLICE_CHARS) repairs.push(`task ${task.id} of ${area.name} runs with ${size.toLocaleString("en-US")} characters of diff, past the ${MAX_SLICE_CHARS.toLocaleString("en-US")} a reader can take, so its readers may hand in before they have read it all`);
    }
    const reach = reachChars(area, final, context);
    if (area.questions.length && reach > MAX_SLICE_CHARS) repairs.push(`area ${area.name}'s questions are read over ${reach.toLocaleString("en-US")} characters of diff, past the ${MAX_SLICE_CHARS.toLocaleString("en-US")} a reader can take, so their readers may hand in before they have read it all`);
  }
  return { plan: { ...plan, areas }, repairs };
}

/** A name not yet taken, from a base and a number after it when needed; it's added to the taken names. */
function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

export interface PlanOptions {
  chat: Chat;
  model: string;
  effort: string | null;
  workspace: Workspace;
  deadline: number;
  maxTurns: number;
  lenses: Record<string, Lens>;
  context: PlanContext;
  log: (message: string) => void;
}

export interface Planned {
  plan: Plan;
  /** Problems the second ask didn't fix, and what was repaired for them, for the review to say. */
  problems: string[];
}

export async function writePlan(input: PlanInput, options: PlanOptions): Promise<Planned> {
  const tool = planTool(Object.keys(options.lenses));
  const prompt = plannerPrompt(input);
  const ask = async (text: string, caller: string): Promise<Plan> => parsePlan(await runAgent({
    chat: options.chat, model: options.model, system: PLANNER_SYSTEM, prompt: text, workspace: options.workspace, submit: tool,
    deadline: options.deadline, maxTurns: options.maxTurns, handInTurns: HAND_IN_TURNS, log: options.log, caller, ...(options.effort ? { effort: options.effort } : {}),
  }));
  let plan = await ask(prompt, "planner");
  let secondAsk = "";
  let problems = await checkPlan(plan, options.context);
  if (problems.length) {
    options.log(`planner: the plan had ${problems.length} problem(s); asking once more`);
    try {
      const again = await ask(`${prompt}\n\nAn earlier plan for this change had these problems, so make sure yours has none of them:\n${problems.map((problem) => `- ${problem}`).join("\n")}`, "planner again");
      const second = await checkPlan(again, options.context);
      if (second.length <= problems.length) {
        plan = again;
        problems = second;
      }
    } catch (error) {
      // A refusal or a model that can't be reached stops the review, as the first ask's would.
      if (error instanceof ModelRefused || error instanceof ModelUnavailable) throw error;
      const reason = told(error);
      options.log(`planner: the second ask gave no plan, keeping the first: ${reason}`);
      secondAsk = `The planner's second ask, with the first plan's problems named, gave no plan, so the first was repaired.`;
    }
  }
  if (!problems.length) return { plan, problems: [] };
  const repaired = await repairPlan(plan, options.context);
  return { plan: repaired.plan, problems: [...(secondAsk ? [secondAsk] : []), ...problems.map((problem) => `The plan: ${problem}.`), ...repaired.repairs.map((repair) => `Repaired: ${repair}.`)] };
}
