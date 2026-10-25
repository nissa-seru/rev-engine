import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const MARKER = "<!-- rev-engine-prime -->";

/** One page of open issues as GitHub's GraphQL answers it, an answer of GitHub's given whole (`raw`), or null for a failed request. */
type IssuePage = { nodes: Array<{ number: number; title: string; url: string; body: string | null; createdAt: string }>; hasNextPage: boolean } | { raw: unknown } | null;

/**
 * A GitHub API for one pull request (o/n #1): its reviews, review threads, comments and the repository's open issues,
 * by page from 1. `asked` holds each open-issues query's cursor, "" for the first, and `queries` each one whole.
 */
async function github(openIssues: (page: number) => IssuePage, broken: { permissions?: boolean | number; reviews?: boolean; failing?: string } = {}, shapeIssue = ""): Promise<{ url: string; asked: string[]; queries: Array<{ query: string; variables: Record<string, unknown> }>; close: () => void }> {
  const asked: string[] = [];
  const queries: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const reviews = [
    { id: 1, user: { login: "github-actions[bot]" }, body: `### Automated review\n${MARKER}`, submitted_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/o/n/pull/1#pullrequestreview-1" },
    { id: 2, user: { login: "github-actions[bot]" }, body: "Another workflow's review, without the marker", submitted_at: "2026-10-03T00:00:00Z", html_url: "https://github.com/o/n/pull/1#pullrequestreview-2" },
    { id: 3, user: { login: "ann" }, body: "", submitted_at: "2026-10-02T00:00:00Z", html_url: "https://github.com/o/n/pull/1#pullrequestreview-3" },
    { id: 4, user: { login: "ann" }, body: "Posted after --before", submitted_at: "2026-10-09T00:00:00Z", html_url: "https://github.com/o/n/pull/1#pullrequestreview-4" },
  ];
  const comments = [
    { user: { login: "bob" }, body: "The cache never empties", created_at: "2026-10-04T00:00:00Z", html_url: "https://github.com/o/n/pull/1#issuecomment-5" },
    { user: { login: "github-actions[bot]" }, body: `This review stopped before it finished. The run: x\n\n${MARKER}`, created_at: "2026-10-04T00:00:01Z", html_url: "https://github.com/o/n/pull/1#issuecomment-10" },
    { user: { login: "eve" }, body: `Quoting the review: ${MARKER}`, created_at: "2026-10-04T00:00:02Z", html_url: "https://github.com/o/n/pull/1#issuecomment-11" },
  ];
  const threads = [{
    isResolved: false, resolvedBy: null,
    comments: { nodes: [
      { databaseId: 6, url: "https://github.com/o/n/pull/1#discussion_r6", body: `**Should fix. X.**\n${shapeIssue}${MARKER}`, createdAt: "2026-10-01T00:00:01Z", path: "src/a.ts", line: 12, startLine: null, originalLine: 12, originalStartLine: null, author: { login: "github-actions" }, originalCommit: { oid: "c" }, pullRequestReview: { databaseId: 1 } },
      { databaseId: 7, url: "https://github.com/o/n/pull/1#discussion_r7", body: "Agreed, and the same in b.ts", createdAt: "2026-10-05T00:00:00Z", path: "src/a.ts", line: 12, startLine: null, originalLine: 12, originalStartLine: null, author: { login: "cat" }, originalCommit: { oid: "c" }, pullRequestReview: { databaseId: 8 } },
      { databaseId: 12, url: "https://github.com/o/n/pull/1#discussion_r12", body: "Won't fix: by design", createdAt: "2026-10-05T00:00:01Z", path: "src/a.ts", line: 12, startLine: null, originalLine: 12, originalStartLine: null, author: { login: "dan" }, originalCommit: { oid: "c" }, pullRequestReview: { databaseId: 13 } },
    ] },
  }];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://x");
    const send = (body: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    const page = Number(url.searchParams.get("page") ?? "1");
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const { query, variables } = JSON.parse(text) as { query: string; variables: { after: string | null } };
      if (query.includes("reviewThreads")) return send({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: threads } } } } });
      asked.push(variables.after ?? "");
      queries.push({ query, variables });
      const listed = openIssues(variables.after ? Number(variables.after) + 1 : 1);
      if (!listed) return response.writeHead(500).end("{}");
      if ("raw" in listed) return send(listed.raw);
      return send({ data: { repository: { issues: { pageInfo: { hasNextPage: listed.hasNextPage, endCursor: String(variables.after ? Number(variables.after) + 1 : 1) }, nodes: listed.nodes } } } });
    }
    if (url.pathname === "/repos/o/n/pulls/1/reviews") return broken.reviews ? response.writeHead(500).end("{}") : send(page === 1 ? reviews : []);
    if (url.pathname === "/repos/o/n/issues/1/comments") return send(page === 1 ? comments : []);
    // A failed lookup: the connection dropped, or, given a status, GitHub answering with it.
    if (url.pathname.startsWith("/repos/o/n/collaborators/") && typeof broken.permissions === "number") return response.writeHead(broken.permissions).end("{}");
    if (broken.failing && url.pathname === `/repos/o/n/collaborators/${broken.failing}/permission`) return response.writeHead(502).end("{}");
    if (url.pathname.startsWith("/repos/o/n/collaborators/") && broken.permissions) return request.socket.destroy();
    if (url.pathname.startsWith("/repos/o/n/collaborators/")) return send({ permission: url.pathname.endsWith("/dan/permission") ? "write" : "read" });
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, asked, queries, close: () => server.close() };
}

async function collect(api: string, extra: string[] = [], env: Record<string, string | undefined> = {}): Promise<{ known: Record<string, unknown> | null; prior: Record<string, unknown> | null; decisions: string | null; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), "collect-"));
  const { stdout } = await run(process.execPath, [new URL("../action/collect.ts", import.meta.url).pathname, ...extra], {
    env: { ...process.env, GITHUB_TOKEN: "t", GITHUB_API_URL: api, GITHUB_GRAPHQL_URL: `${api}/graphql`, RB_NWO: "o/n", RB_PR_NUMBER: "1", PRIOR_PATH: join(dir, "prior.json"), KNOWN_PATH: join(dir, "known.json"), ...env },
  });
  const read = (name: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  let decisions: string | null = null;
  try {
    decisions = readFileSync(join(dir, "decisions.jsonl"), "utf8");
  } catch {
    // none written
  }
  return { known: read("known.json"), prior: read("prior.json"), decisions, stdout };
}

test("known.json holds what others said on the thread, oldest first, and the open issues", async () => {
  const issues = [
    { number: 9, title: "Newest", url: "https://github.com/o/n/issues/9", body: null, createdAt: "2026-10-08T00:00:00Z" },
    { number: 3, title: "Older", url: "https://github.com/o/n/issues/3", body: "steps", createdAt: "2026-09-01T00:00:00Z" },
  ];
  const api = await github((page) => (page === 1 ? { nodes: issues, hasNextPage: false } : null));
  try {
    const { known, prior } = await collect(api.url);
    assert.deepEqual(known, {
      thread: [
        { kind: "review", author: "github-actions[bot]", url: "https://github.com/o/n/pull/1#pullrequestreview-2", body: "Another workflow's review, without the marker" },
        { kind: "comment", author: "bob", url: "https://github.com/o/n/pull/1#issuecomment-5", body: "The cache never empties" },
        { kind: "comment", author: "eve", url: "https://github.com/o/n/pull/1#issuecomment-11", body: `Quoting the review: ${MARKER}` },
        { kind: "review comment on src/a.ts:12", author: "cat", url: "https://github.com/o/n/pull/1#discussion_r7", body: "Agreed, and the same in b.ts" },
        { kind: "review comment on src/a.ts:12", author: "dan", url: "https://github.com/o/n/pull/1#discussion_r12", body: "Won't fix: by design" },
        { kind: "review", author: "ann", url: "https://github.com/o/n/pull/1#pullrequestreview-4", body: "Posted after --before" },
      ],
      issues: [
        { number: 9, title: "Newest", url: "https://github.com/o/n/issues/9", body: "" },
        { number: 3, title: "Older", url: "https://github.com/o/n/issues/3", body: "steps" },
      ],
      more: false,
      issuesError: "",
    }, "this Action's own posts (its review, its line comment, its stop notice) and empty reviews are left out; another account's quote of the marker isn't one");
    assert.deepEqual(api.asked, [""], "one page, from the start");
    // The newest open issues of this repository: what the query asks of GitHub, which this stand-in doesn't enforce.
    const [asked] = api.queries;
    assert.deepEqual(asked!.variables, { owner: "o", name: "n", after: null });
    assert.match(asked!.query, /repository\(owner: \$owner, name: \$name\)/);
    assert.match(asked!.query, /issues\(states: OPEN, first: 100, after: \$after, orderBy: \{ field: CREATED_AT, direction: DESC \}\)/);
    assert.match(asked!.query, /pageInfo \{ hasNextPage endCursor \}\s+nodes \{ number title url body createdAt \}/);
    assert.equal((prior!.entries as unknown[]).length, 1, "the decisions are written beside it");
    const earlier = await collect(api.url, ["--before", "2026-10-06T00:00:00Z"]);
    assert.deepEqual((earlier.known!.thread as Array<{ url: string }>).map((item) => item.url).at(-1), "https://github.com/o/n/pull/1#discussion_r12", "--before leaves out what came after");
    assert.deepEqual((earlier.known!.issues as Array<{ number: number }>).map((item) => item.number), [3]);
  } finally {
    api.close();
  }
});

test("the open issues stop at five pages, saying there are more only when GitHub has more, and each page follows the last", async () => {
  const full = (page: number, last: number): IssuePage => ({
    nodes: Array.from({ length: 100 }, (_, index) => ({ number: page * 1000 + index, title: "t", url: `https://github.com/o/n/issues/${page * 1000 + index}`, body: "", createdAt: "2026-09-01T00:00:00Z" })),
    hasNextPage: page < last,
  });
  for (const [last, more] of [[6, true], [5, false]] as const) {
    const api = await github((page) => full(page, last));
    try {
      const { known } = await collect(api.url);
      const numbers = (known!.issues as Array<{ number: number }>).map((item) => item.number);
      assert.equal(numbers.length, 500);
      assert.equal(new Set(numbers).size, 500, "five different pages");
      assert.deepEqual(numbers.slice(0, 1).concat(numbers.slice(-1)), [1000, 5099]);
      assert.deepEqual(api.asked, ["", "1", "2", "3", "4"], "each page asked from the one before it");
      assert.equal(known!.more, more, last === 5 ? "five full pages and nothing past them aren't more" : "GitHub has a sixth page");
    } finally {
      api.close();
    }
  }
});

test("known.json is written before the decisions are worked out, so their failure costs it nothing, and a failed listing says both are lost", async () => {
  const issues = [{ number: 9, title: "Newest", url: "https://github.com/o/n/issues/9", body: null, createdAt: "2026-10-08T00:00:00Z" }];
  // A permission lookup that fails, dropped or answered with an error, leaves that account's decisions out and says
  // so; it's no answer of no access, and the other accounts' decisions still count.
  const refusing = await github(() => ({ nodes: issues, hasNextPage: false }), { permissions: true });
  try {
    const { known, prior, stdout } = await collect(refusing.url);
    assert.equal((known!.thread as unknown[]).length, 6, "the thread is kept though the permission lookups failed");
    assert.equal(prior, null, "every lookup failed, so no decision stands");
    assert.match(stdout, /::warning::Earlier decisions of [\w, ]*dan[\w, ]* aren't counted, since their permission lookups failed \(/);
    assert.doesNotMatch(stdout, /Earlier decisions not collected/);
  } finally {
    refusing.close();
  }
  const erring = await github(() => ({ nodes: issues, hasNextPage: false }), { permissions: 502 });
  try {
    const { prior, stdout } = await collect(erring.url);
    assert.equal(prior, null);
    assert.match(stdout, /::warning::Earlier decisions of [\w, ]+ aren't counted, since their permission lookups failed \([^)]*dan: status 502/);
  } finally {
    erring.close();
  }
  const one = await github(() => ({ nodes: issues, hasNextPage: false }), { failing: "bob" });
  try {
    const { prior, stdout } = await collect(one.url);
    assert.equal((prior!.entries as unknown[]).length, 1, "dan's decision still counts when only bob's lookup failed");
    assert.match(stdout, /::warning::Earlier decisions of bob aren't counted, since their permission lookups failed \(bob: status 502\); the others' are/);
  } finally {
    one.close();
  }
  // A failure after known.json, here prior.json's write, costs it nothing, and the warning doesn't say it's lost.
  const writing = await github(() => ({ nodes: issues, hasNextPage: false }));
  try {
    const { known, stdout } = await collect(writing.url, [], { PRIOR_PATH: "/dev/null/prior.json" });
    assert.equal((known!.thread as unknown[]).length, 6);
    assert.match(stdout, /::warning::Earlier decisions not collected: /);
    assert.doesNotMatch(stdout, /nor the pull request's thread/);
  } finally {
    writing.close();
  }
  const unknown = await github(() => ({ nodes: issues, hasNextPage: false }), { permissions: 404 });
  try {
    const { prior, stdout } = await collect(unknown.url);
    // Every account is then without write access, so no decision stands and no prior.json is written, with no warning.
    assert.equal(prior, null, "an account GitHub can't find (404) has no write access");
    assert.doesNotMatch(stdout, /::warning::Earlier decisions/, "a 404 is an answer, not a failed lookup");
  } finally {
    unknown.close();
  }
  const unlisted = await github(() => ({ nodes: issues, hasNextPage: false }), { reviews: true });
  try {
    const { known, stdout } = await collect(unlisted.url);
    assert.equal(known, null);
    assert.match(stdout, /::warning::Earlier decisions not collected, nor the pull request's thread and open issues for the review: GET \/pulls\/1\/reviews failed with status 500/);
    const unasked = await collect(unlisted.url, [], { KNOWN_PATH: undefined });
    assert.match(unasked.stdout, /::warning::Earlier decisions not collected: GET \/pulls\/1\/reviews failed with status 500/, "without KNOWN_PATH, nothing was asked of the thread to lose");
  } finally {
    unlisted.close();
  }
});

test("decisions on the review shape's comments are recorded by their issue's marker, and a failure to record them costs neither prior.json nor known.json", async () => {
  const api = await github(() => ({ nodes: [], hasNextPage: false }), {}, "<!-- rev-engine-shape-issue re-o.n-1-1 I3 -->\n");
  try {
    const recorded = await collect(api.url, [], { DECISIONS_PATH: "" });
    assert.equal(recorded.decisions, null, "no path, no record");
    const dir = mkdtempSync(join(tmpdir(), "decisions-"));
    await collect(api.url, [], { DECISIONS_PATH: join(dir, "decisions.jsonl") });
    const lines = readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => [line.review, line.issue, line.comment, line.by]), [["re-o.n-1-1", "I3", 6, "dan"]]);
    const unwritable = await collect(api.url, [], { DECISIONS_PATH: "/dev/null/decisions.jsonl" });
    assert.match(unwritable.stdout, /::warning::Decisions on the review shape's comments weren't recorded, and the review goes on without that record:/);
    assert.ok(unwritable.known && unwritable.prior, "known.json and prior.json are written all the same");
  } finally {
    api.close();
  }
  const plain = await github(() => ({ nodes: [], hasNextPage: false }));
  try {
    const dir = mkdtempSync(join(tmpdir(), "decisions-"));
    await collect(plain.url, [], { DECISIONS_PATH: join(dir, "decisions.jsonl") });
    assert.throws(() => readFileSync(join(dir, "decisions.jsonl")), "a comment without the shape's marker is the other review's, and records nothing");
  } finally {
    plain.close();
  }
});

test("open issues that can't be read keep the thread and the decisions, and say why; no KNOWN_PATH asks for neither", async () => {
  const broken = await github(() => null);
  try {
    const { known, prior, stdout } = await collect(broken.url);
    assert.deepEqual([(known!.thread as unknown[]).length, known!.issues, known!.more, known!.issuesError], [6, [], false, "the open issues query failed with status 500"]);
    assert.match(stdout, /::warning::The repository's open issues weren't read for the review, which goes on without them, so it can't tell a problem already filed as an issue \(where GitHub refused them, the workflow's token needs issues: read\): the open issues query failed with status 500/);
    assert.equal((prior!.entries as unknown[]).length, 1, "the earlier decisions are written all the same");
    // GitHub refuses a token without issues: read with an answer of 200 and an errors list, and the reason is kept.
    const refusing = await github(() => ({ raw: { data: { repository: { issues: null } }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] } }));
    try {
      const refused = await collect(refusing.url);
      assert.deepEqual([(refused.known!.thread as unknown[]).length, refused.known!.issues, refused.known!.issuesError], [6, [], "the open issues query failed: Resource not accessible by integration"]);
    } finally {
      refusing.close();
    }
    const nowhere = await github(() => ({ raw: { data: { repository: null } } }));
    try {
      assert.equal((await collect(nowhere.url)).known!.issuesError, "the open issues query returned no repository", "an answer with no repository and no errors isn't read as no issues");
    } finally {
      nowhere.close();
    }
    const unwritable = await collect(broken.url, [], { KNOWN_PATH: "/dev/null/known.json" });
    assert.match(unwritable.stdout, /::warning::The pull request's thread and the repository's open issues weren't kept for the review, which goes on without them, so it can't tell a problem raised there already:/);
    assert.equal((unwritable.prior!.entries as unknown[]).length, 1, "and when known.json can't be written at all");
    broken.asked.length = 0;
    const without = await collect(broken.url, [], { KNOWN_PATH: undefined });
    assert.deepEqual([without.known, broken.asked], [null, []], "without KNOWN_PATH, nothing is collected for the judge");
    assert.equal((without.prior!.entries as unknown[]).length, 1);
  } finally {
    broken.close();
  }
});
