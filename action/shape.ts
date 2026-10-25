// Turns the review shape's result (src/shape, written as shape-review.json) into one GitHub pull request review:
// comments on the change's most severe issues, and a summary that lists every issue it posts, the change's grouped by
// severity and those in code the change builds on apart, as far as GitHub's size limit allows, with what the review
// read of the change, counting any task only one reader read. How the review went otherwise (the plan's note, what
// went wrong along the way) stays in its saved results, as do the issues it holds. This folder is mounted on its own,
// so the result's shape is declared here again.
import { earlierComment, MARKER, place, type ExistingComment, type Finding, type Hunks, type LineComment, type ReviewParts, type Severity as Level } from "./comments.ts";

export type Severity = "blocker" | "should-fix" | "minor";

interface Place {
  file: string;
  line: number;
  /** A place in a file the change deletes, by its line at the base. */
  base?: true;
}

/** The change's own text, which an issue may cite but no comment can sit on (src/shape/find.ts TEXT_FILES). */
const TEXT_FILES = ["change-text.md", "commit-messages.txt"];

export interface PostedIssue {
  area: string;
  id: string;
  /** Its id in its area's run directory, and that directory's label, which its comment carries. */
  issue: string;
  label: string;
  title: string;
  severity: Severity;
  kind: "code" | "test" | "text";
  verdict: "real" | "unsure";
  readers: string[];
  places: Place[];
  causes: string[];
  consequences: string[];
  failingCase: string;
  why: string;
  origin: "change" | "base";
  security: boolean;
  /** "description", a thread item's or an open issue's URL, or "". */
  knownAt: string;
  /** For one the change's own text names: whether it gives a reason for leaving it that holds. Absent in a review saved before the judge said. */
  reasonHolds?: boolean;
  text: string;
  confirm: string;
  repeats: string[];
}

/** The changed lines no reader's read returned (src/shape/run.ts, UnreadChanges). */
export interface UnreadChanges {
  changed: number;
  unread: number;
  files: Array<{ path: string; basePath?: string; added: Array<[number, number]>; removed: Array<[number, number]> }>;
}

export interface ShapeReview {
  label: string;
  head: string;
  /** The commit the review read from, and the label of the earlier review whose head that is, when it read only what changed since. */
  base: string;
  roundOf: string | null;
  repo: string;
  models: { planner: string; batteryA: string; batteryB: string; judge: string };
  issues: PostedIssue[];
  /** Never posted: security issues in code the base already has. */
  held: PostedIssue[];
  notReal: Array<{ area: string; id: string; title: string; notRealKind: string; why: string; places: Place[] }>;
  decided: Array<{ area: string; id: string; title: string; repeatOf: string }>;
  unjudged: Array<{ area: string; id: string; title: string }>;
  unreadChanges: UnreadChanges;
  empty: string[];
  shortfall: string[];
  bounded: string[];
  dropped: number;
  problems: string[];
  planNote: string;
  leftOut: string[];
  withoutDependencies?: boolean;
  dependenciesFromRanges?: boolean;
}

export interface ShapeInput {
  review: ShapeReview;
  hunks: Hunks;
  existing: ExistingComment[];
  settled?: Set<number>;
  /** Issues at least this severe get a comment, as min-severity says: high is blockers, medium adds should-fix. */
  minSeverity: Level;
  maxComments: number;
  /** The GitHub the review runs on, which its permalinks point into: GITHUB_SERVER_URL, https://github.com by default. */
  server?: string;
}

/**
 * The most a summary may hold. GitHub refuses a review body past 65,536 characters, by its documented limit; this
 * keeps room for the links added once the comments exist.
 */
export const BODY_LIMIT = 60_000;
/** One listed issue's text, at most, in a full entry: past it the text is cut, saying where it's kept whole. A compact entry has no text. */
const MAX_ENTRY_CHARS = 1_500;

/** What an issue the judge couldn't settle says. */
const UNSURE = "The judge couldn't settle it from the code, so it is listed for a maintainer to weigh.";

const LEVEL: Record<Severity, Level> = { blocker: "high", "should-fix": "medium", minor: "low" };
const HEADING: Record<Severity, string> = { blocker: "Blockers", "should-fix": "Should fix", minor: "Minor" };
const LABEL: Record<Severity, string> = { blocker: "Blocker", "should-fix": "Should fix", minor: "Minor" };
const KIND: Record<PostedIssue["kind"], string> = { code: "", test: "test", text: "text" };

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * What the review read of the change, from what the reads of its readers that answered returned: every changed line, or
 * those none returned, by file, with a file the plan of several areas left out of every area said as such. `keep` cuts
 * the list of files. A reader that gave no answer is said apart (the shortfall), and its reads aren't counted.
 */
function unreadText(review: ShapeReview, keep: number): string {
  const { changed, unread, files } = review.unreadChanges;
  const rule = "A line counts when a read by a reader that answered returned it whole: an added line from the diff or from its file, a removed line from the diff. A search that matched it doesn't count.";
  if (!changed) return "The change adds or removes no line of text.";
  if (!unread) return `Between them, the reads of the readers that answered returned every changed line of the change (${changed} in all). ${rule}`;
  const ranges = (runs: Array<[number, number]>): string => runs.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(", ");
  const size = (runs: Array<[number, number]>): number => runs.reduce((sum, [from, to]) => sum + to - from + 1, 0);
  const lines = (runs: Array<[number, number]>): string => `${size(runs) === 1 ? "line" : "lines"} ${ranges(runs)}`;
  const listed = files.slice(0, keep).map((file) => {
    const parts = [
      ...(file.added.length ? [lines(file.added)] : []),
      ...(file.removed.length ? [`removed ${lines(file.removed)} ${file.basePath ? `of \`${file.basePath}\` ` : ""}at the base`] : []),
    ];
    const leftOut = review.leftOut.includes(file.path) ? ", which the plan left out of every area" : "";
    return `\`${file.path}\`${leftOut}: ${parts.join("; ")}`;
  });
  const more = files.length > keep ? `; and ${count(files.length - keep, "more file")}` : "";
  return `${unread} of the change's ${count(changed, "changed line")} ${unread === 1 ? "wasn't" : "weren't"} returned by any read of a reader that answered: ${listed.join("; ")}${more}. ${rule}`;
}

/** An issue's title on one line, as a list entry and a comment's bold head need it, without its closing stop. */
function title(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.:]+$/, "");
}

/**
 * An issue's places in the repository's own files, those at head first: not the change's text, nor a checkout of a
 * dependency or a consumer, as the findings file takes them (src/shape/run.ts atHeadInRepository).
 */
function repositoryPlaces(issue: { places: Place[] }): Place[] {
  const files = issue.places.filter((place) => !TEXT_FILES.includes(place.file) && !/^(node_modules|\.consumers)\//.test(place.file));
  return [...files.filter((place) => !place.base), ...files.filter((place) => place.base)];
}

/** The most places an entry links; the rest are counted. */
const MAX_PLACES = 3;

/** A place's name, as path:line, and a link to it at the commit the review read: the head, or the base it read from for a file the change deletes. */
function placeLink(review: ShapeReview, spot: Place, server: string): string {
  const name = `\`${spot.file}:${spot.line}\`${spot.base ? " (at the base)" : ""}`;
  if (!review.repo) return name;
  const path = spot.file.split("/").map(encodeURIComponent).join("/");
  return `[${name}](${server}/${review.repo}/blob/${spot.base ? review.base : review.head}/${path}#L${spot.line})`;
}

/** An issue's places in the repository, the first few linked; an issue with none there names its first place, unlinked. */
function places(issue: PostedIssue, review: ShapeReview, server: string): string {
  const spots = repositoryPlaces(issue);
  if (!spots.length) {
    const spot = issue.places[0];
    if (!spot) return "";
    return TEXT_FILES.includes(spot.file) ? `${spot.file === "change-text.md" ? "the description" : "the commit messages"}, line ${spot.line}` : `\`${spot.file}:${spot.line}\``;
  }
  const more = spots.length > MAX_PLACES ? ` and ${count(spots.length - MAX_PLACES, "more place")}` : "";
  return `${spots.slice(0, MAX_PLACES).map((spot) => placeLink(review, spot, server)).join(", ")}${more}`;
}

/** A text as a sentence: trimmed, with a full stop when it ends without one. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return !trimmed || /[.?!:)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Where the issue is already named, as a sentence, or "" for nowhere. */
function knownNote(issue: PostedIssue): string {
  if (!issue.knownAt) return "";
  if (issue.knownAt === "description") {
    // Only the change's own blockers and should-fix issues weigh, so only they can be said to weigh still.
    if (namedLimit(issue)) return "Named in this pull request's description or commit messages, with a reason for leaving it that holds by reading, so it doesn't weigh in the recommendation.";
    // Said only where the judge answered: a review saved before it did says only where the issue is named.
    if (issue.origin === "change" && issue.severity !== "minor" && issue.reasonHolds === false) return "Named in this pull request's description or commit messages, and it still weighs in the recommendation: by reading, nothing there gives a reason for leaving it that holds.";
    return "Named in this pull request's description or commit messages.";
  }
  const number = /\/issues\/(\d+)$/.exec(issue.knownAt)?.[1];
  return `Already raised ${number ? `in [#${number}](${issue.knownAt})` : `[on this pull request](${issue.knownAt})`}.`;
}

/**
 * Model-written text with every HTML comment opener shown as text, so nothing the readers or the judge quote, such as
 * a pull request's own words, can pass for one of this review's markers.
 */
function inert(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

/** The review with every model-written string made inert; its label, head and base are the run's own. */
function inertReview(review: ShapeReview): ShapeReview {
  const deep = (value: unknown): unknown => typeof value === "string" ? inert(value) : Array.isArray(value) ? value.map(deep)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)])) : value;
  return { ...(deep(review) as ShapeReview), label: review.label, head: review.head, base: review.base, roundOf: review.roundOf, issues: review.issues.map((issue) => ({ ...(deep(issue) as PostedIssue), label: issue.label, issue: issue.issue })) };
}

function rating(issue: PostedIssue): string {
  return `${LABEL[issue.severity]}${KIND[issue.kind] ? `, ${KIND[issue.kind]}` : ""}`;
}

/**
 * An issue's text as the judge wrote it, by reading, cut at `limit` when it's given and longer, ending in its note; for
 * a blocker or should-fix, the run that would confirm it, when the judge gave one; whether the judge settled it; and
 * where it was already named. Only the text is cut here, so what follows it is there in full; a comment's outer cut
 * (shapeCommentBody) can still take a title or run past its limit.
 */
function detail(issue: PostedIssue, limit?: { chars: number; note: string }): string {
  const text = sentence(issue.text);
  const parts = [limit && text.length > limit.chars ? `${cut(text, limit.chars)}${limit.note}` : text];
  if (issue.confirm && issue.severity !== "minor") parts.push(`To confirm: ${sentence(issue.confirm)}`);
  if (issue.verdict === "unsure") parts.push(UNSURE);
  const note = knownNote(issue);
  if (note) parts.push(note);
  return parts.join("\n\n");
}

/**
 * Ties a comment to its issue in its run directory, so a maintainer's decision on it is recorded against that issue
 * without the earlier run's files: `<!-- rev-engine-shape-issue <label> <issue> -->`.
 */
export function issueMarker(issue: { label: string; issue: string }): string {
  return `<!-- rev-engine-shape-issue ${issue.label} ${issue.issue} -->`;
}

/**
 * The issue a comment's marker names, or null for a comment without one. A comment's own marker is the whole of its
 * last line but one, before MARKER, where shapeCommentBody writes it, so one quoted anywhere else isn't its identity.
 */
export function markedIssue(body: string): { label: string; issue: string } | null {
  const line = body.split("\n").filter((each) => each.trim().length > 0).at(-2) ?? "";
  const found = /^<!-- rev-engine-shape-issue ([A-Za-z0-9][A-Za-z0-9._-]*) (I\d+) -->$/.exec(line.trim());
  return found ? { label: found[1]!, issue: found[2]! } : null;
}

/** Names the review a summary belongs to and the head it read, so a later round can read from that head. */
export function reviewMarker(review: { label: string; head: string }): string {
  return `<!-- rev-engine-shape-review ${review.label} ${review.head} -->`;
}

/** The most a comment's text may hold: GitHub refuses a comment past 65,536 characters, and one refusal loses them all. */
const MAX_COMMENT_CHARS = 20_000;

/** Where a cut text is kept whole: the review's run directories, saved as an artifact of its Actions run, sealed with the model key the review ran with, which opens it. */
const KEPT_WHOLE = "the run this review saved holds it whole, sealed with this review's model key";

/** The first `length` UTF-16 units of a text, one fewer when that would split a surrogate pair, which GitHub refuses. */
export function cut(text: string, length: number): string {
  const end = Math.max(0, length);
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

export function shapeCommentBody(issue: PostedIssue): string {
  const cutNote = `... (cut; ${KEPT_WHOLE})`;
  const text = `**${rating(issue)}. ${title(issue.title)}.**\n\n${detail(issue, { chars: MAX_COMMENT_CHARS / 2, note: cutNote })}`;
  // Past the cut of its text, only a title or a run of that length is left to cut, and GitHub refuses a comment past
  // its limit, which would lose every comment of the review.
  return `${text.length > MAX_COMMENT_CHARS ? `${cut(text, MAX_COMMENT_CHARS)}${cutNote}` : text}\n\n${issueMarker(issue)}\n${MARKER}`;
}

/**
 * One line of merge advice, from the change's own issues the judge held real, in the practice of fixing in the pull
 * request or filing an issue before merging; and what it doesn't rest on: the change's issues the judge couldn't
 * settle, every issue it gave no verdict on (whose origin no judge said), and, in a later round, what the earlier review
 * raised. Issues in code the change builds on don't weigh in it, and nor does one the change's own text names with a
 * reason for leaving it that holds by the judge's reading.
 */
/** A limit the change's own text names, with a reason for leaving it that holds: the author's call, not the advice's. */
function namedLimit(issue: PostedIssue): boolean {
  return issue.origin === "change" && issue.knownAt === "description" && issue.reasonHolds === true;
}

export function shapeRecommendation(review: Pick<ShapeReview, "issues" | "unjudged" | "roundOf" | "base">): string {
  const own = review.issues.filter((issue) => issue.origin === "change" && !namedLimit(issue));
  const real = own.filter((issue) => issue.verdict === "real");
  const blockers = real.filter((issue) => issue.severity === "blocker").length;
  const shouldFix = real.filter((issue) => issue.severity === "should-fix").length;
  const unsettled = own.filter((issue) => issue.verdict === "unsure" && issue.severity !== "minor").length;
  const named = review.issues.filter((issue) => namedLimit(issue) && issue.severity !== "minor").length;
  const also: string[] = [];
  if (named) also.push(`${count(named, "more blocker or should-fix issue")} the description or commit messages name, with a reason for leaving ${named === 1 ? "it" : "them"} that holds, ${named === 1 ? "is" : "are"} listed apart and ${named === 1 ? "doesn't" : "don't"} weigh here.`);
  if (unsettled) also.push(`${count(unsettled, "more blocker or should-fix issue")} the judge couldn't settle ${unsettled === 1 ? "is" : "are"} listed for a maintainer to weigh.`);
  if (review.unjudged.length) also.push(`${count(review.unjudged.length, "issue")} the judge gave no verdict on ${review.unjudged.length === 1 ? "isn't" : "aren't"} weighed here.`);
  if (review.roundOf) also.push(`It covers only what changed since ${review.base.slice(0, 7)}, the commit an earlier review read; that review's issues stand as it gave them.`);
  const tail = also.length ? ` ${also.join(" ")}` : "";
  const filed = `fixed in this pull request or filed as an issue before merging`;
  if (blockers) return `**Recommendation: fix, then merge.** ${count(blockers, "blocker")} should be fixed first${shouldFix ? `, and ${count(shouldFix, "should-fix issue")} ${filed}` : ""}.${tail}`;
  if (shouldFix) return `**Recommendation: fix here or file an issue for each, then merge.** ${count(shouldFix, "should-fix issue")} should be ${filed}.${tail}`;
  return `**Recommendation: merge.** The review found no ${named ? "other " : ""}blocker or should-fix issue in the change that its judge held real.${tail}`;
}

/** A Finding for the comment helpers shared with the other review: one of its places, its level and words. */
function asFinding(issue: PostedIssue, spot: Place): Finding {
  return { file: spot.file, start_line: spot.line, end_line: spot.line, severity: LEVEL[issue.severity], kind: issue.kind, title: issue.title, detail: detail(issue) };
}

type Mode = "full" | "compact";

/**
 * One listed issue: its grade, its title (linked to its comment when it has one), its places, in full its text (cut
 * at MAX_ENTRY_CHARS), and where it was already named and whether the judge settled it, which a compact entry keeps
 * too when its issue has no comment to say them. An issue with a comment, or one an earlier comment raises, is listed
 * without its text: its grade, title and places, and for the latter that comment. The change's minor issues are listed
 * under their own heading, so their grade isn't said again.
 */
function entry(issue: PostedIssue, review: ShapeReview, mode: Mode, server: string, link?: string, earlier?: ExistingComment): string {
  const name = link ? `[${title(issue.title)}](${link})` : title(issue.title);
  const where = places(issue, review, server);
  const head = issue.severity === "minor" && issue.origin === "change" ? `- ${name}. ${where}` : `- **${rating(issue)}. ${name}.** ${where}`;
  if (earlier) return `${head} Already raised in ${earlier.html_url ? `[this comment](${earlier.html_url})` : "an earlier comment"}.${issue.verdict === "unsure" ? ` ${UNSURE}` : ""}`;
  // An entry made compact keeps where its issue was named, and without a comment to say it, that the judge couldn't
  // settle it.
  if (mode === "compact" || link) return `${head}${knownNote(issue) ? ` ${knownNote(issue)}` : ""}${!link && issue.verdict === "unsure" ? ` ${UNSURE}` : ""}`;
  return `${head} ${detail(issue, { chars: MAX_ENTRY_CHARS, note: `... (cut; ${KEPT_WHOLE})` }).replace(/\s*\n+\s*/g, " ")}`;
}

interface Built {
  comments: LineComment[];
  commented: PostedIssue[];
  repeats: Array<{ issue: PostedIssue; earlier: ExistingComment }>;
}

function chooseComments(input: ShapeInput): Built {
  const levels: Record<Level, number> = { high: 0, medium: 1, low: 2 };
  // Only the change's own issues get a comment, and not one named already: the summary links where it was.
  const serious = input.review.issues.filter((issue) => issue.origin === "change" && !issue.knownAt && levels[LEVEL[issue.severity]] <= levels[input.minSeverity]);
  const comments: LineComment[] = [];
  const commented: PostedIssue[] = [];
  const repeats: Built["repeats"] = [];
  for (const issue of serious) {
    // The comment sits at the first of its places at head that a hunk shows, and repeats an earlier comment there.
    // Repeats are found past the cap too, so an issue listed without a comment still says it was raised before.
    const findings = repositoryPlaces(issue).filter((spot) => !spot.base).map((spot) => asFinding(issue, spot));
    const earlier = findings.map((finding) => earlierComment(finding, input.existing, input.settled)).find(Boolean);
    if (earlier) {
      repeats.push({ issue, earlier });
      continue;
    }
    if (commented.length >= input.maxComments) continue;
    const placed = findings.map((finding) => ({ finding, spot: place(finding, input.hunks) })).find((candidate) => candidate.spot);
    if (!placed) continue;
    const { finding, spot } = placed as { finding: Finding; spot: NonNullable<ReturnType<typeof place>> };
    commented.push(issue);
    comments.push({
      path: finding.file, line: spot.line, side: "RIGHT",
      ...(spot.startLine === null ? {} : { start_line: spot.startLine, start_side: "RIGHT" as const }),
      body: shapeCommentBody(issue),
    });
  }
  return { comments, commented, repeats };
}

/**
 * Which lists are compact: an issue's title and places, with no text. "base" is the list of issues in code the change
 * builds on, and "named" the change's own issues its text names with a reason that holds.
 */
type Part = Severity | "base" | "named";

function partOf(issue: PostedIssue): Part {
  return issue.origin === "base" ? "base" : namedLimit(issue) ? "named" : issue.severity;
}

/**
 * The summary, at a level of detail: full lists every issue's text, each cut at MAX_ENTRY_CHARS; compact gives each
 * issue of a list its title and places, with no text, for minor issues and those in code the change builds on first,
 * then all; `keep` cuts each list to that many entries. The change's blockers and should-fix issues are shown; its
 * minor issues, and those in code it builds on, are folded away.
 */
function summary(input: ShapeInput, built: Built, links: Array<string | undefined>, compact: Set<Part>, keep: number): string {
  const { review } = input;
  const recommend = shapeRecommendation(review);
  const since = review.roundOf ? `, reading only what changed since ${review.base.slice(0, 7)}, the commit the earlier review ${review.roundOf} read,` : "";
  const read: string[] = [unreadText(review, keep)];
  if (review.withoutDependencies) read.push("The readers had no installed dependencies (none to install, or none installed or placed), so a dependency's behaviour was known only from the repository's own text.");
  if (review.dependenciesFromRanges) read.push("The head has no lockfile at its root, so its dependencies were installed from package.json's version ranges, and a dependency the readers read may be a later version than the author ran.");
  const linkOf = new Map(built.commented.map((issue, index) => [issue, links[index]]));
  const repeatOf = new Map(built.repeats.map(({ issue, earlier }) => [issue, earlier]));
  const own = review.issues.filter((issue) => issue.origin === "change" && !namedLimit(issue));
  const named = review.issues.filter(namedLimit);
  // Each blocker and should-fix listed, the change's own and existing code's, is promised its run only when one is
  // listed and each says it: in its comment, or in its entry listed whole. An entry made compact (as every list is
  // before any is cut), one that points at an earlier comment, or one whose judge gave no run doesn't.
  const serious = review.issues.filter((issue) => issue.severity !== "minor");
  const runs = serious.length > 0 && serious.every((issue) => issue.confirm && !repeatOf.has(issue) && (linkOf.has(issue) || !compact.has(partOf(issue))));
  const sections = [
    `### Automated review\n\n${recommend}\n\nReviewed commit ${review.head.slice(0, 7)}${since} by reading the code, in four stages: a plan by ${review.models.planner}; two readers on every task of it, ${review.models.batteryA} and ${review.models.batteryB}${review.shortfall.length ? ` (${review.models.batteryB} gave no answer on ${count(review.shortfall.length, "task")}, which ${review.models.batteryA} alone read)` : ""}; their findings grouped into issues; and a judge, ${review.models.judge}, that tried to refute each issue. Nothing was run, so each issue is a lead from reading${runs ? ", and each blocker or should-fix says the run that would confirm it" : ""}.\n\n${read.join(" ")}`,
  ];
  const list = (issues: PostedIssue[], part: Part): string => {
    const lines = issues.slice(0, keep).map((issue) => entry(issue, review, compact.has(part) ? "compact" : "full", (input.server ?? "https://github.com").replace(/\/+$/, ""), linkOf.get(issue), repeatOf.get(issue)));
    if (issues.length > keep) lines.push(`- and ${count(issues.length - keep, "more issue")}, in the run this review saved, sealed with this review's model key.`);
    return lines.join("\n");
  };
  if (!own.length) sections.push(`#### Issues\n\n${named.length ? "Besides those this pull request names itself, below, the" : "The"} review found no issue in the change that its judge held to be real.`);
  for (const severity of ["blocker", "should-fix"] as const) {
    const issues = own.filter((issue) => issue.severity === severity);
    if (issues.length) sections.push(`#### ${HEADING[severity]} (${issues.length})\n\n${list(issues, severity)}`);
  }
  // Minor issues by file, so a maintainer reads each file's together.
  const minor = own.filter((issue) => issue.severity === "minor").sort((a, b) => (repositoryPlaces(a)[0]?.file ?? "").localeCompare(repositoryPlaces(b)[0]?.file ?? ""));
  if (minor.length) sections.push(`#### ${HEADING.minor} (${minor.length})\n\n<details>\n<summary>${count(minor.length, "minor issue")}, by file</summary>\n\n${list(minor, "minor")}\n\n</details>`);
  if (named.length) sections.push(`#### Named in this pull request (${named.length})\n\n<details>\n<summary>${count(named.length, "issue")} the description or commit messages name, with a reason for leaving ${named.length === 1 ? "it" : "them"} that holds by reading, which ${named.length === 1 ? "doesn't" : "don't"} weigh in the recommendation</summary>\n\n${list(named, "named")}\n\n</details>`);
  const base = review.issues.filter((issue) => issue.origin === "base");
  if (base.length) sections.push(`#### In existing code (${base.length})\n\n<details>\n<summary>${count(base.length, "issue")} in code that was there before this change, which ${base.length === 1 ? "doesn't" : "don't"} weigh in the recommendation</summary>\n\n${list(base, "base")}\n\n</details>`);
  return sections.join("\n\n");
}

/** What ends every summary: the marker a later round reads its base from, and the action's own. */
function tail(review: ShapeReview): string {
  return `\n\n${reviewMarker(review)}\n${MARKER}`;
}

/**
 * One review: comments on the most severe issues (at or above min-severity, at most max-findings, on lines a hunk
 * shows), and a summary of every issue grouped by severity. A summary past BODY_LIMIT is made compact, minor issues
 * first, then each list halved, saying how many were left out of it; as a last resort its tail is cut, saying so.
 */
export function buildShapeReview(given: ShapeInput, links: Array<string | undefined> = []): ReviewParts {
  const input = { ...given, review: inertReview(given.review) };
  const built = chooseComments(input);
  const total = Math.max(input.review.issues.length, input.review.unreadChanges.files.length, 1);
  const limit = BODY_LIMIT - tail(input.review).length;
  const all = new Set<Part>(["minor", "named", "base", "should-fix", "blocker"]);
  const tries: Array<{ compact: Set<Part>; keep: number }> = [
    { compact: new Set(), keep: total },
    { compact: new Set(["minor", "named", "base"]), keep: total },
    { compact: all, keep: total },
  ];
  for (const attempt of tries) {
    const body = summary(input, built, links, attempt.compact, attempt.keep);
    if (body.length <= limit) return { body: body + tail(input.review), comments: built.comments };
  }
  // Still too long: halve each list until it fits. The markers go after any cut, so a later round and the decisions
  // still find the review.
  let keep = Math.max(1, Math.floor(total / 2));
  for (;;) {
    const body = summary(input, built, links, all, keep);
    if (body.length <= limit) return { body: body + tail(input.review), comments: built.comments };
    if (keep === 1) {
      const note = `\n\n_The rest of this summary is cut to fit GitHub's size limit; ${KEPT_WHOLE}._`;
      return { body: cut(body, limit - note.length) + note + tail(input.review), comments: built.comments };
    }
    keep = Math.max(1, Math.floor(keep / 2));
  }
}
