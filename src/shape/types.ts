// The shapes the review pipeline in src/shape passes between its stages, and keeps in each area's run directory.
// They follow the review workflow this pipeline ports, so a run directory reads the same as one of its own.

export type Severity = "blocker" | "should-fix" | "minor";
export const SEVERITIES: readonly Severity[] = ["blocker", "should-fix", "minor"];
export const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, "should-fix": 1, minor: 2 };

/** Requests a stage's model may take once it is asked to hand in, reading nothing more (runAgent's handInTurns). */
export const HAND_IN_TURNS = 3;

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
