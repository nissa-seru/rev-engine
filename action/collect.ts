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
// --before ignores everything posted after that time, to rebuild what an earlier
// review would have been given.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

/** Whether an account has write or admin access, asked once per account. */
async function canDecide(account: string): Promise<boolean> {
  if (!account || account.endsWith("[bot]")) return false;
  if (!permissions.has(account)) {
    const response = await fetch(`${api}/repos/${nwo}/collaborators/${encodeURIComponent(account)}/permission`, { headers });
    const permission = response.ok ? (await response.json() as { permission?: string }).permission : undefined;
    permissions.set(account, permission === "admin" || permission === "write");
  }
  return permissions.get(account)!;
}

try {
  const [reviewList, threadList, commentList] = await Promise.all([
    rest<{ id: number; user: { login: string } | null; body: string | null; submitted_at: string | null }>(`/pulls/${number}/reviews`),
    threads(),
    rest<{ user: { login: string } | null; body: string | null; created_at: string; html_url: string }>(`/issues/${number}/comments`),
  ]);
  const reviews: ReviewRecord[] = reviewList
    .filter((review) => review.submitted_at && (!before || review.submitted_at <= before))
    .map((review) => ({ id: review.id, author: review.user?.login ?? "", body: review.body ?? "", submittedAt: review.submitted_at! }));
  const comments: IssueComment[] = commentList
    .filter((comment) => !before || comment.created_at <= before)
    .map((comment) => ({ author: comment.user?.login ?? "", body: comment.body ?? "", createdAt: comment.created_at, url: comment.html_url }));

  // Ask about every account that wrote a decision, before the pure step, which cannot wait on the network.
  const accounts = new Set<string>([
    ...comments.map((comment) => comment.author),
    ...threadList.flatMap((thread) => [...thread.comments.slice(1).map((comment) => comment.author), thread.resolvedBy ?? ""]),
  ]);
  await Promise.all([...accounts].map(canDecide));

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
      console.log(`::warning::Decisions on the review shape's comments not recorded: ${error instanceof Error ? error.message : String(error)}`);
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
  console.log(`::warning::Earlier decisions not collected: ${error instanceof Error ? error.message : String(error)}`);
}
