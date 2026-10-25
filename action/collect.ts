// Collects the maintainer's decisions on earlier reviews of a pull request into
// prior.json, so the next review does not report decided findings again. It holds
// the GitHub token and no model key. A failure to collect is logged as a warning and
// leaves no file, so the review runs as it would have without earlier decisions; a
// failure to write the decisions record alone is said apart and costs prior.json nothing.
//
//   PRIOR_PATH=<file> [DECISIONS_PATH=<file>] node action/collect.ts [--before <ISO time>]
//
// DECISIONS_PATH, when set, also gets the standing decision on each of the review shape's marked comments (its
// latest stated one, from a reply or a review evaluation that links the comment, else its thread's resolution), one
// JSON line each (review label, issue, comment id, decision, who, and when, where GitHub gives a time; a resolution
// has none), for a record of what maintainers decided.
//
// KNOWN_PATH, when set, also gets known.json for the review shape's judge: every review, review comment and comment on
// the pull request but this Action's own (this Action's account, with its marker), oldest first, and the repository's
// open issues, newest first, up to KNOWN_ISSUES below, with whether there are older ones. Open issues that can't be
// read (the workflow's token needs issues: read) leave an empty list and the reason, and the thread is still written;
// any other failure leaves no file. Either is said apart and costs prior.json nothing, and the review says it in its
// saved results. known.json is written before the decisions are worked out, so a failure there costs it nothing; one
// of the listings both are made from leaves neither, which the warning says.
//
// Each REST listing is read up to 20 pages of 100, and the review threads up to 20 pages of 50, with each thread's first
// 50 comments; anything past that is left out unsaid.
//
// --before ignores everything posted after that time, to rebuild what an earlier
// review would have been given. An issue closed since was open then, and isn't among the open issues now. Open issues
// are filtered within the newest KNOWN_ISSUES open today, so a rebuild for a time before many newer ones may hold fewer
// than that review was given.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MARKER } from "./comments.ts";
import { collectDecisions, commentDecisions, type IssueComment, type ReviewRecord, type ThreadRecord } from "./decisions.ts";
import { markedIssue } from "./shape.ts";

const BOT = "github-actions[bot]";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const token = required("GITHUB_TOKEN");
const api = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
const graphqlUrl = process.env.GITHUB_GRAPHQL_URL?.trim() || `${api}/graphql`;
const nwo = required("RB_NWO");
const number = Number(required("RB_PR_NUMBER"));
const priorPath = required("PRIOR_PATH");
const before = process.argv.includes("--before") ? process.argv[process.argv.indexOf("--before") + 1] : undefined;
const [owner, name] = nwo.split("/") as [string, string];

const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "rev-engine-prime",
};

async function rest<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(`${api}/repos/${nwo}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GET ${path} failed with status ${response.status}`);
    const batch = await response.json() as T[];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/** The open issues known.json holds at most, newest first: five pages of 100. */
const KNOWN_ISSUES = 500;

/** GraphQL's issues are issues only, so pull requests don't count against the cap. */
const OPEN_ISSUES = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url body createdAt }
    }
  }
}`;

/** The repository's open issues, newest first, up to KNOWN_ISSUES, and `more` when GitHub holds older ones past them. */
async function openIssues(): Promise<{ issues: Array<{ number: number; title: string; url: string; body: string }>; more: boolean }> {
  const issues: Array<{ number: number; title: string; url: string; body: string }> = [];
  let after: string | null = null;
  for (let page = 0; page < KNOWN_ISSUES / 100; page += 1) {
    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ query: OPEN_ISSUES, variables: { owner, name, after } }),
    });
    if (!response.ok) throw new Error(`the open issues query failed with status ${response.status}`);
    const result = await response.json() as { data?: { repository?: { issues?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Array<{ number: number; title: string; url: string; body: string | null; createdAt: string }> } } }; errors?: Array<{ message: string }> };
    if (result.errors?.length) throw new Error(`the open issues query failed: ${result.errors[0]!.message}`);
    const listed = result.data?.repository?.issues;
    if (!listed) throw new Error("the open issues query returned no repository");
    issues.push(...listed.nodes.filter((item) => !before || item.createdAt <= before).map((item) => ({ number: item.number, title: item.title, url: item.url, body: item.body ?? "" })));
    if (!listed.pageInfo.hasNextPage) return { issues, more: false };
    after = listed.pageInfo.endCursor;
  }
  return { issues, more: true };
}

const THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          resolvedBy { login }
          comments(first: 50) {
            nodes {
              databaseId url body createdAt path line startLine originalLine originalStartLine
              author { login }
              originalCommit { oid }
              pullRequestReview { databaseId }
            }
          }
        }
      }
    }
  }
}`;

interface ThreadNode {
  isResolved: boolean;
  resolvedBy: { login: string } | null;
  comments: {
    nodes: Array<{
      databaseId: number; url: string; body: string; createdAt: string; path: string;
      line: number | null; startLine: number | null; originalLine: number | null; originalStartLine: number | null;
      author: { login: string } | null; originalCommit: { oid: string } | null; pullRequestReview: { databaseId: number } | null;
    }>;
  };
}

/** GraphQL names the bot "github-actions", REST "github-actions[bot]". */
function login(author: { login: string } | null): string {
  if (!author) return "";
  return author.login === "github-actions" ? BOT : author.login;
}

async function threads(): Promise<ThreadRecord[]> {
  const found: ThreadRecord[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ query: THREADS, variables: { owner, name, number, after } }),
    });
    if (!response.ok) throw new Error(`the review threads query failed with status ${response.status}`);
    const result = await response.json() as { data?: { repository?: { pullRequest?: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ThreadNode[] } } } }; errors?: Array<{ message: string }> };
    if (result.errors?.length) throw new Error(`the review threads query failed: ${result.errors[0]!.message}`);
    const threadPage = result.data?.repository?.pullRequest?.reviewThreads;
    if (!threadPage) throw new Error("the review threads query returned no pull request");
    for (const node of threadPage.nodes) {
      const comments = node.comments.nodes.filter((comment) => !before || comment.createdAt <= before);
      const first = comments[0];
      if (!first) continue;
      found.push({
        reviewId: first.pullRequestReview?.databaseId ?? null,
        path: first.path,
        startLine: first.originalStartLine ?? first.startLine,
        line: first.originalLine ?? first.line,
        commit: first.originalCommit?.oid ?? null,
        // A resolution after --before had not happened yet, but GitHub does not say when a
        // thread was resolved, so a rebuilt earlier state counts only replies.
        isResolved: before ? false : node.isResolved,
        resolvedBy: before ? null : node.resolvedBy?.login ?? null,
        comments: comments.map((comment) => ({ id: comment.databaseId, author: login(comment.author), body: comment.body, createdAt: comment.createdAt, url: comment.url })),
      });
    }
    if (!threadPage.pageInfo.hasNextPage) break;
    after = threadPage.pageInfo.endCursor;
  }
  return found;
}

const permissions = new Map<string, boolean>();

/** Accounts whose permission lookup failed, with why: their decisions aren't counted, and the collector says so. */
const lookupFailures = new Map<string, string>();

/**
 * Whether an account has write or admin access, asked once per account. GitHub documents 200 and 404, an account it
 * can't find, for this lookup; any other answer, or none, is a failed lookup, not an answer of no access, so the
 * account's decisions are left out and said, and every other account's still count.
 */
async function canDecide(account: string): Promise<boolean> {
  if (!account || account.endsWith("[bot]")) return false;
  if (!permissions.has(account)) {
    try {
      const response = await fetch(`${api}/repos/${nwo}/collaborators/${encodeURIComponent(account)}/permission`, { headers });
      if (!response.ok && response.status !== 404) throw new Error(`status ${response.status}`);
      const permission = response.ok ? (await response.json() as { permission?: string }).permission : undefined;
      permissions.set(account, permission === "admin" || permission === "write");
    } catch (error) {
      lookupFailures.set(account, error instanceof Error ? error.message : String(error));
      permissions.set(account, false);
    }
  }
  return permissions.get(account)!;
}

let knownWritten = false;
try {
  const [reviewList, threadList, commentList] = await Promise.all([
    rest<{ id: number; user: { login: string } | null; body: string | null; submitted_at: string | null; html_url: string }>(`/pulls/${number}/reviews`),
    threads(),
    rest<{ user: { login: string } | null; body: string | null; created_at: string; html_url: string }>(`/issues/${number}/comments`),
  ]);
  const reviews: ReviewRecord[] = reviewList
    .filter((review) => review.submitted_at && (!before || review.submitted_at <= before))
    .map((review) => ({ id: review.id, author: review.user?.login ?? "", body: review.body ?? "", submittedAt: review.submitted_at! }));
  const comments: IssueComment[] = commentList
    .filter((comment) => !before || comment.created_at <= before)
    .map((comment) => ({ author: comment.user?.login ?? "", body: comment.body ?? "", createdAt: comment.created_at, url: comment.html_url }));

  // For the review shape's judge: what others said on the thread, and the open issues, so an issue raised already is
  // linked rather than raised again. Written before the decisions are worked out, from the same listings, so a failure
  // of either is said apart and costs the other nothing.
  const knownPath = process.env.KNOWN_PATH?.trim();
  if (knownPath) {
    try {
      // This Action's own posts (its reviews, comments and stop notices) are its account's with its marker; a person
      // quoting the marker, or another workflow posting as the same account, is someone else.
      const own = (author: string, body: string) => author === BOT && body.includes(MARKER);
      const thread = [
        ...reviewList.filter((review) => review.submitted_at && (!before || review.submitted_at <= before) && review.body?.trim() && !own(review.user?.login ?? "", review.body))
          .map((review) => ({ at: review.submitted_at!, kind: "review", author: review.user?.login ?? "", url: review.html_url, body: review.body! })),
        ...threadList.flatMap((one) => one.comments.filter((comment) => comment.body.trim() && !own(comment.author, comment.body))
          .map((comment) => ({ at: comment.createdAt, kind: `review comment on ${one.path}${one.line ? `:${one.line}` : ""}`, author: comment.author, url: comment.url, body: comment.body }))),
        ...comments.filter((comment) => comment.body.trim() && !own(comment.author, comment.body))
          .map((comment) => ({ at: comment.createdAt, kind: "comment", author: comment.author, url: comment.url, body: comment.body })),
      ].sort((a, b) => a.at.localeCompare(b.at)).map(({ at: _at, ...item }) => item);
      let open: Awaited<ReturnType<typeof openIssues>> = { issues: [], more: false };
      let issuesError = "";
      try {
        open = await openIssues();
      } catch (error) {
        issuesError = error instanceof Error ? error.message : String(error);
        console.log(`::warning::The repository's open issues weren't read for the review, which goes on without them, so it can't tell a problem already filed as an issue (where GitHub refused them, the workflow's token needs issues: read): ${issuesError}`);
      }
      await mkdir(dirname(knownPath), { recursive: true });
      await writeFile(knownPath, `${JSON.stringify({ thread, issues: open.issues, more: open.more, issuesError })}\n`);
      knownWritten = true;
      console.error(`collect: ${thread.length} thread item(s) and ${issuesError ? "no" : open.issues.length} open issue(s)${open.more ? ", the newest of more" : ""} for the review`);
    } catch (error) {
      console.log(`::warning::The pull request's thread and the repository's open issues weren't kept for the review, which goes on without them, so it can't tell a problem raised there already: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Ask about every account that wrote a decision, before the pure step, which cannot wait on the network.
  const accounts = new Set<string>([
    ...comments.map((comment) => comment.author),
    ...threadList.flatMap((thread) => [...thread.comments.slice(1).map((comment) => comment.author), thread.resolvedBy ?? ""]),
  ]);
  await Promise.all([...accounts].map(canDecide));
  if (lookupFailures.size) {
    console.log(`::warning::Earlier decisions of ${[...lookupFailures.keys()].join(", ")} aren't counted, since their permission lookups failed (${[...lookupFailures].map(([account, why]) => `${account}: ${why}`).join("; ")}); the others' are`);
  }

  const sources = { reviews, threads: threadList, comments, bot: BOT, canDecide: (account: string) => permissions.get(account) === true };
  const prior = collectDecisions(sources);
  // For the review shape: the standing decision on each comment whose marker names its issue, one line each, for the
  // record of what maintainers decided (DECISIONS_PATH). Comments without a marker are the other review's.
  // A failure here is said apart, so it costs the shape's record and never the review's prior.json below.
  const decisionsPath = process.env.DECISIONS_PATH?.trim();
  if (decisionsPath) {
    try {
      const bodies = new Map(threadList.flatMap((thread) => thread.comments.slice(0, 1).map((comment) => [comment.id, comment.body] as const)));
      const lines = commentDecisions(sources).flatMap((decided) => {
        const marked = markedIssue(bodies.get(decided.comment) ?? "");
        return marked ? [JSON.stringify({ review: marked.label, issue: marked.issue, comment: decided.comment, decision: decided.decision, by: decided.by, at: decided.at || null })] : [];
      });
      if (lines.length) {
        await mkdir(dirname(decisionsPath), { recursive: true });
        await writeFile(decisionsPath, `${lines.join("\n")}\n`);
        console.error(`collect: ${lines.length} decision(s) on the review shape's comments`);
      }
    } catch (error) {
      console.log(`::warning::Decisions on the review shape's comments weren't recorded, and the review goes on without that record: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!prior.entries.length && !prior.fit?.length) {
    console.error("collect: no earlier decisions on this pull request");
  } else {
    await mkdir(dirname(priorPath), { recursive: true });
    await writeFile(priorPath, `${JSON.stringify(prior, null, 2)}\n`);
    console.error(`collect: ${prior.entries.length} earlier decision(s) and ${prior.fit?.length ?? 0} fit answer(s) written${prior.omitted ? `, ${prior.omitted} decision(s) left out by the cap` : ""}`);
  }
} catch (error) {
  // A broken collector must not stop the review, but it must not look like a reviewer that repeats itself either.
  console.log(`::warning::Earlier decisions not collected${process.env.KNOWN_PATH?.trim() && !knownWritten ? ", nor the pull request's thread and open issues for the review" : ""}: ${error instanceof Error ? error.message : String(error)}`);
}
