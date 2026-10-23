// Turns the review shape's result (src/shape, written as shape-review.json) into one GitHub pull request review:
// comments on the most severe issues, and a summary that lists every issue grouped by severity, as far as GitHub's size
// limit allows, and says what the review couldn't read. This folder is mounted on its own, so the result's shape is
// declared here again.
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
}

export interface ShapeReview {
  label: string;
  head: string;
  /** The commit the review read from, and the label of the earlier review whose head that is, when it read only what changed since. */
  base: string;
  roundOf: string | null;
  models: { planner: string; batteryA: string; batteryB: string; judge: string };
  issues: PostedIssue[];
  notReal: Array<{ area: string; id: string; title: string; notRealKind: string; why: string; places: Place[] }>;
  decided: Array<{ area: string; id: string; title: string; repeatOf: string }>;
  unjudged: Array<{ area: string; id: string; title: string }>;
  unreadSpots: string[];
  unread: Array<{ area: string; finder: string; unread: string[] }>;
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
}

/**
 * The most a summary may hold. GitHub refuses a review body past 65,536 characters, by its documented limit; this
 * keeps room for the links added once the comments exist.
 */
export const BODY_LIMIT = 60_000;
/** One listed issue's text, at most, before the list is made compact. */
const MAX_ENTRY_CHARS = 1_500;

/** An entry's text, cut at MAX_ENTRY_CHARS with "..." to say so. */
function short(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${cut(text, MAX_ENTRY_CHARS)}...` : text;
}

const LEVEL: Record<Severity, Level> = { blocker: "high", "should-fix": "medium", minor: "low" };
const HEADING: Record<Severity, string> = { blocker: "Blockers", "should-fix": "Should fix", minor: "Minor" };
const LABEL: Record<Severity, string> = { blocker: "Blocker", "should-fix": "Should fix", minor: "Minor" };
const KIND: Record<PostedIssue["kind"], string> = { code: "", test: "test", text: "text" };

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function title(text: string): string {
  return text.trim().replace(/[.:]+$/, "");
}

/**
 * An issue's places in the repository's own files, those at head first: not the change's text, nor a checkout of a
 * dependency or a consumer, as the findings file takes them (src/shape/run.ts atHeadInRepository).
 */
function repositoryPlaces(issue: { places: Place[] }): Place[] {
  const files = issue.places.filter((place) => !TEXT_FILES.includes(place.file) && !/^(node_modules|\.consumers)\//.test(place.file));
  return [...files.filter((place) => !place.base), ...files.filter((place) => place.base)];
}

function where(issue: { places: Place[] }): string {
  const spot = repositoryPlaces(issue)[0] ?? issue.places[0];
  return spot ? `\`${spot.file}:${spot.line}\`${spot.base ? " (at the base)" : ""}` : "";
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

/** Who found it, in the words a maintainer has: the two readers are named by model. */
function foundBy(issue: PostedIssue, review: ShapeReview): string {
  const names = issue.readers.map((reader) => (reader === "A" ? review.models.batteryA : reader === "B" ? review.models.batteryB : reader));
  return names.length > 1 ? `Found by both readers (${names.join(" and ")}).` : `Found by ${names[0] ?? "one reader"} alone.`;
}

function rating(issue: PostedIssue): string {
  return `${LABEL[issue.severity]}${KIND[issue.kind] ? `, ${KIND[issue.kind]}` : ""}`;
}

/** An issue's whole text: its causes, consequences and case, who found it, and whether the judge settled it. */
function detail(issue: PostedIssue, review: ShapeReview): string {
  const parts: string[] = [];
  if (issue.causes.length) parts.push(`Cause: ${issue.causes.join("; ")}.`);
  if (issue.consequences.length) parts.push(`Consequence: ${issue.consequences.join("; ")}.`);
  if (issue.failingCase) parts.push(`Case: ${issue.failingCase}`);
  parts.push(foundBy(issue, review));
  if (issue.verdict === "unsure") parts.push("The judge couldn't settle it from the code, so it is listed for a maintainer to weigh.");
  return parts.join("\n\n");
}

/**
 * Ties a comment to its issue in its run directory, so a maintainer's decision on it is recorded against that issue
 * without the earlier run's files: `<!-- rev-engine-shape-issue <label> <issue> -->`.
 */
export function issueMarker(issue: { label: string; issue: string }): string {
  return `<!-- rev-engine-shape-issue ${issue.label} ${issue.issue} -->`;
}

/** The issue a comment's marker names, or null for a comment without one. The comment's own marker is its last. */
export function markedIssue(body: string): { label: string; issue: string } | null {
  const found = [...body.matchAll(/<!-- rev-engine-shape-issue ([A-Za-z0-9][A-Za-z0-9._-]*) (I\d+) -->/g)].at(-1);
  return found ? { label: found[1]!, issue: found[2]! } : null;
}

/** Names the review a summary belongs to and the head it read, so a later round can read from that head. */
export function reviewMarker(review: { label: string; head: string }): string {
  return `<!-- rev-engine-shape-review ${review.label} ${review.head} -->`;
}

/** The most a comment's text may hold: GitHub refuses a comment past 65,536 characters, and one refusal loses them all. */
const MAX_COMMENT_CHARS = 20_000;

/** Where a cut text is kept whole: the review's run directories, saved as an artifact of its Actions run. */
const KEPT_WHOLE = "the `rev-engine-shape-NUMBER-ROUND` artifact of this review's Actions run, named by the pull request and round, holds it whole";

/** The first `length` UTF-16 units of a text, one fewer when that would split a surrogate pair, which GitHub refuses. */
export function cut(text: string, length: number): string {
  const end = Math.max(0, length);
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

export function shapeCommentBody(issue: PostedIssue, review: ShapeReview): string {
  const text = `**${rating(issue)}. ${title(issue.title)}.**\n\n${detail(issue, review)}`;
  return `${text.length > MAX_COMMENT_CHARS ? `${cut(text, MAX_COMMENT_CHARS)}... (cut; ${KEPT_WHOLE})` : text}\n\n${issueMarker(issue)}\n${MARKER}`;
}

/**
 * One line of merge advice, by the same rule as the other review's (blockers first, then issues worth fixing soon),
 * in this review's own severity names, and what it doesn't rest on: issues the judge couldn't settle or gave no verdict
 * on, tasks a reader didn't answer, and, in a later round, what the earlier review raised.
 */
export function shapeRecommendation(review: Pick<ShapeReview, "issues" | "unjudged" | "shortfall" | "roundOf" | "base">): string {
  // The advice rests on what the judge held real; issues it couldn't settle are named beside it, for a maintainer to weigh.
  const real = review.issues.filter((issue) => issue.verdict === "real");
  const blockers = real.filter((issue) => issue.severity === "blocker").length;
  const shouldFix = real.filter((issue) => issue.severity === "should-fix").length;
  const unsettled = review.issues.filter((issue) => issue.verdict === "unsure" && issue.severity !== "minor").length;
  const also: string[] = [];
  if (unsettled) also.push(`${count(unsettled, "more blocker or should-fix issue")} the judge couldn't settle ${unsettled === 1 ? "is" : "are"} listed for a maintainer to weigh.`);
  if (review.unjudged.length) also.push(`${count(review.unjudged.length, "issue")} the judge gave no verdict on ${review.unjudged.length === 1 ? "isn't" : "aren't"} weighed here.`);
  if (review.shortfall.length) also.push(`${count(review.shortfall.length, "task")} one of the two readers didn't answer ${review.shortfall.length === 1 ? "was" : "were"} read once, not twice.`);
  if (review.roundOf) also.push(`It covers only what changed since ${review.base.slice(0, 7)}, the commit an earlier review read; that review's issues stand as it gave them.`);
  const tail = also.length ? ` ${also.join(" ")}` : "";
  if (blockers) return `**Recommendation: fix, then merge.** ${count(blockers, "blocker")} should be fixed first.${tail}`;
  if (shouldFix) return `**Recommendation: merge and fast-follow.** ${count(shouldFix, "should-fix issue")} can be fixed after the merge.${tail}`;
  return `**Recommendation: merge.** The review found no blocker or should-fix issue its judge held real.${tail}`;
}

/** A Finding for the comment helpers shared with the other review: one of its places, its level and words. */
function asFinding(issue: PostedIssue, review: ShapeReview, spot: Place): Finding {
  return { file: spot.file, start_line: spot.line, end_line: spot.line, severity: LEVEL[issue.severity], kind: issue.kind, title: issue.title, detail: detail(issue, review) };
}

type Mode = "full" | "compact";

function entry(issue: PostedIssue, review: ShapeReview, mode: Mode, link?: string): string {
  const name = link ? `[${title(issue.title)}](${link})` : title(issue.title);
  const head = `- ${rating(issue)}. ${name}. ${where(issue)}`;
  if (mode === "compact" || link) return head;
  const text = detail(issue, review).replace(/\s*\n+\s*/g, " ");
  return `${head} ${short(text)}`;
}

interface Built {
  comments: LineComment[];
  commented: PostedIssue[];
  repeats: Array<{ issue: PostedIssue; earlier: ExistingComment }>;
}

function chooseComments(input: ShapeInput): Built {
  const levels: Record<Level, number> = { high: 0, medium: 1, low: 2 };
  const serious = input.review.issues.filter((issue) => levels[LEVEL[issue.severity]] <= levels[input.minSeverity]);
  const comments: LineComment[] = [];
  const commented: PostedIssue[] = [];
  const repeats: Built["repeats"] = [];
  for (const issue of serious) {
    // The comment sits at the first of its places at head that a hunk shows, and repeats an earlier comment there.
    // Repeats are found past the cap too, so an issue listed without a comment still says it was raised before.
    const findings = repositoryPlaces(issue).filter((spot) => !spot.base).map((spot) => asFinding(issue, input.review, spot));
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
      body: shapeCommentBody(issue, input.review),
    });
  }
  return { comments, commented, repeats };
}

/**
 * The summary, at a level of detail: full lists every issue's text; compact gives each listed issue its title and
 * place only, for minor issues first and then all; `keep` cuts each list to that many entries.
 */
function summary(input: ShapeInput, built: Built, links: Array<string | undefined>, compact: Set<Severity>, keep: number): string {
  const { review } = input;
  const recommend = shapeRecommendation(review);
  const since = review.roundOf ? `, reading only what changed since ${review.base.slice(0, 7)}, the commit the earlier review ${review.roundOf} read,` : "";
  const sections = [
    `### Automated review\n\n${recommend}\n\nReviewed commit ${review.head.slice(0, 7)}${since} by reading the code, in four stages: a plan by ${review.models.planner}; two readers on every task of it, ${review.models.batteryA} (two tasks per call) and ${review.models.batteryB}; their findings grouped into issues; and a judge, ${review.models.judge}, that tried to refute each issue. It did not run the code or look at the checks.`,
  ];
  const linkOf = new Map(built.commented.map((issue, index) => [issue, links[index]]));
  const repeatOf = new Map(built.repeats.map(({ issue, earlier }) => [issue, earlier]));
  if (!review.issues.length) sections.push("#### Issues\n\nThe review found no issue that its judge held to be real.");
  for (const severity of ["blocker", "should-fix", "minor"] as const) {
    const issues = review.issues.filter((issue) => issue.severity === severity);
    if (!issues.length) continue;
    const mode: Mode = compact.has(severity) ? "compact" : "full";
    const lines = issues.slice(0, keep).map((issue) => {
      const earlier = repeatOf.get(issue);
      if (earlier) return `${entry(issue, review, "compact")} Already raised in ${earlier.html_url ? `[this comment](${earlier.html_url})` : "an earlier comment"}.`;
      return entry(issue, review, mode, linkOf.get(issue));
    });
    if (issues.length > keep) lines.push(`- and ${count(issues.length - keep, "more issue")}, in the review's saved results.`);
    const inView = built.commented.some((issue) => issue.severity === severity) && severity !== "minor";
    const list = lines.join("\n");
    const heading = `#### ${HEADING[severity]} (${issues.length})`;
    sections.push(inView || severity === "blocker" ? `${heading}\n\n${list}` : `${heading}\n\n<details>\n<summary>${count(issues.length, severity === "minor" ? "minor issue" : "issue")}</summary>\n\n${list}\n\n</details>`);
  }

  const unread: string[] = [];
  if (review.unreadSpots.length) unread.push(`Two or more readers said they couldn't cover these changed files, and no issue cites them: ${review.unreadSpots.slice(0, keep).map((file) => `\`${file}\``).join(", ")}${review.unreadSpots.length > keep ? `, and ${review.unreadSpots.length - keep} more` : ""}.`);
  if (review.shortfall.length) unread.push(`**${review.models.batteryB} gave no answer for ${count(review.shortfall.length, "task")}: ${review.shortfall.join(", ")}.** Those tasks were read by ${review.models.batteryA} alone.`);
  if (review.bounded.length) unread.push(`${count(review.bounded.length, "reader")} reached the size of conversation it can hold and handed in what it had: ${review.bounded.join(", ")}.`);
  if (review.leftOut.length) unread.push(`No reader read these changed files, which the plan left out as generated, vendored or lockfiles: ${review.leftOut.slice(0, keep).map((file) => `\`${file}\``).join(", ")}${review.leftOut.length > keep ? `, and ${review.leftOut.length - keep} more` : ""}.`);
  if (review.dropped) unread.push(`${count(review.dropped, "finding")} ${review.dropped === 1 ? "was" : "were"} left out because ${review.dropped === 1 ? "it was" : "they were"} malformed or cited no file at the reviewed commit or its base.`);
  if (review.withoutDependencies) unread.push("The readers had no installed dependencies (none to install, or none installed), so a dependency's behaviour was known only from the repository's own text.");
  if (review.dependenciesFromRanges) unread.push("The head has no lockfile at its root, so its dependencies were installed from package.json's version ranges, and a dependency the readers read may be a later version than the author ran.");
  if (review.planNote) unread.push(`The plan's note: ${short(review.planNote.replace(/\s*\n+\s*/g, " "))}`);
  const parts = review.unread.map((item) => `- ${item.finder}: ${short(item.unread.join("; ").replace(/\s*\n+\s*/g, " "))}`);
  if (parts.length) unread.push(`<details>\n<summary>What each reader said it couldn't cover (${parts.length})</summary>\n\n${parts.slice(0, keep).join("\n")}${parts.length > keep ? `\n- and ${parts.length - keep} more` : ""}\n\n</details>`);
  sections.push(`#### What the review couldn't read\n\n${unread.length ? unread.join("\n\n") : "Every reader covered its part."}`);

  const more: string[] = [];
  // The issues the judge held not real aren't shown: they stay in the run's record (shape-review.json, judged.jsonl).
  if (review.decided.length) more.push(`${count(review.decided.length, "issue")} ${review.decided.length === 1 ? "repeats a finding" : "repeat findings"} the maintainers decided in an earlier round (${[...new Set(review.decided.map((issue) => issue.repeatOf))].join(", ")}), so ${review.decided.length === 1 ? "it is" : "they are"} left out.`);
  if (review.unjudged.length) more.push(`<details>\n<summary>${count(review.unjudged.length, "issue")} the judge gave no verdict on, so ${review.unjudged.length === 1 ? "it is" : "they are"} not posted</summary>\n\n${review.unjudged.slice(0, keep).map((issue) => `- ${title(issue.title)}`).join("\n")}\n\n</details>`);
  if (review.problems.length) more.push(`<details>\n<summary>What went wrong along the way (${review.problems.length})</summary>\n\n${review.problems.slice(0, keep).map((problem) => `- ${short(problem.replace(/\s*\n+\s*/g, " "))}`).join("\n")}${review.problems.length > keep ? `\n- and ${review.problems.length - keep} more` : ""}\n\n</details>`);
  if (more.length) sections.push(more.join("\n\n"));
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
  const total = Math.max(
    input.review.issues.length, input.review.unread.length, input.review.unreadSpots.length, input.review.problems.length,
    input.review.leftOut.length, input.review.unjudged.length, 1,
  );
  const limit = BODY_LIMIT - tail(input.review).length;
  const tries: Array<{ compact: Set<Severity>; keep: number }> = [
    { compact: new Set(), keep: total },
    { compact: new Set(["minor"]), keep: total },
    { compact: new Set(["minor", "should-fix", "blocker"]), keep: total },
  ];
  for (const attempt of tries) {
    const body = summary(input, built, links, attempt.compact, attempt.keep);
    if (body.length <= limit) return { body: body + tail(input.review), comments: built.comments };
  }
  // Still too long: halve each list until it fits. The markers go after any cut, so a later round and the decisions
  // still find the review.
  let keep = Math.max(1, Math.floor(total / 2));
  for (;;) {
    const body = summary(input, built, links, new Set(["minor", "should-fix", "blocker"]), keep);
    if (body.length <= limit) return { body: body + tail(input.review), comments: built.comments };
    if (keep === 1) {
      const note = `\n\n_The rest of this summary is cut to fit GitHub's size limit; ${KEPT_WHOLE}._`;
      return { body: cut(body, limit - note.length) + note + tail(input.review), comments: built.comments };
    }
    keep = Math.max(1, Math.floor(keep / 2));
  }
}
