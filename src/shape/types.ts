// The shapes the review pipeline in src/shape passes between its stages, and keeps in each area's run directory.
// They follow the review workflow this pipeline ports, so a run directory reads the same as one of its own.

export type Severity = "blocker" | "should-fix" | "minor";
export const SEVERITIES: readonly Severity[] = ["blocker", "should-fix", "minor"];
export const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, "should-fix": 1, minor: 2 };

/** Requests a stage's model may take once it is asked to hand in, reading nothing more (runAgent's handInTurns). */
export const HAND_IN_TURNS = 3;

/**
 * Causes or consequences as one sentence, as every place that shows an issue writes them: each part without its own
 * closing punctuation, joined with "; ", ending in one full stop, or in the last part's own question or exclamation
 * mark. The posting side (action/shape.ts, which runs in the same image) and the findings file share it.
 */
export function clause(parts: string[]): string {
  const joined = parts.map((part) => part.trim().replace(/[\s.,;:]+$/, "")).filter(Boolean).join("; ");
  return /[?!]$/.test(joined) ? joined : `${joined}.`;
}

/** One hunk of a changed file's diff: the lines read_diff numbers it by, its size, and the head lines it spans, git's context around its changes included. */
export interface Hunk {
  lines: [number, number];
  chars: number;
  /** The file's lines at head the hunk spans, from its header; a hunk that only removes lines spans the two around them. */
  head: [number, number];
}

/** A files or tests entry of a plan's slice: a path, or path:from-to for part of a file too big for one slice. */
export function entryOf(entry: string): { path: string; range: [number, number] | null } {
  const range = entry.match(/^(.*):([0-9]+)-([0-9]+)$/);
  return range ? { path: range[1]!, range: [Number(range[2]), Number(range[3])] } : { path: entry, range: null };
}

/** The hunks of its file an entry reads: every one, or for a range, those whose lines at head, git's context around each change included, reach into it. */
export function entryHunks(hunks: Map<string, Hunk[]>, entry: string): Hunk[] {
  const { path, range } = entryOf(entry);
  const all = hunks.get(path) ?? [];
  return range ? all.filter((hunk) => hunk.head[0] <= range[1] && hunk.head[1] >= range[0]) : all;
}

export type Kind = "code" | "test" | "text";
export const KINDS: readonly Kind[] = ["code", "test", "text"];

/** A file and line at head. The change's own text is cited as `change-text.md` or `commit-messages.txt`. */
export interface Place {
  file: string;
  line: number;
  /** Set when the place is in the base's file, as for a file the change deletes. */
  base?: true;
}

/** One finder's finding, keyed `<battery>:<task id>[<index>]`. */
export interface Finding {
  key: string;
  task: string;
  kind: Kind;
  severity: Severity;
  claim: string;
  failingCase: string;
  places: Place[];
}

/** Findings that share a cause and a fix, judged once. Ids run I1, I2… by their members' highest severity. */
export interface Issue {
  id: string;
  title: string;
  causes: string[];
  consequences: string[];
  findings: string[];
  kind: Kind;
  severity: Severity;
}
