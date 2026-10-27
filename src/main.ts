// Container entry point: review the mounted pull request and write the findings file.
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeSettings, loadConfig, type Config } from "./config.ts";
import { createChat, emptyUsage, told, type Chat, type ChatMessage, type Usage } from "./llm.ts";
import type { OutputFinding } from "./findings.ts";
import { naiveReview } from "./naive.ts";
import { review } from "./review.ts";
import { outcomeLine, shapeReview } from "./shape/run.ts";

/** A line for the job's log, which a public repository's Actions page shows anyone. */
const say = (message: string): void => console.error(`agent: ${message}`);
/**
 * Every line of the run. The reader's go to the job's log. The review shape's go to its trace, trace.log in its run
 * directory, which the Action seals with the run: its stages, their turns and their usage, set beside the posted
 * review, could tell that it kept an issue it didn't post. The job's log gets only what `say` and `both` say: that
 * the review started, where its trace is, and how it ended as the pull request sees it.
 */
let log = say;
const both = (message: string): void => {
  say(message);
  if (log !== say) log(message);
};

/**
 * What escapes every catch: an uncaught exception, or an unhandled rejection, which Node raises as one (its default,
 * --unhandled-rejections=throw). Node would print it whole on the job's log, and a ModelError's message keeps up to 300
 * characters of the provider's body, which can quote the request and so what a review keeps back. Its stack goes to
 * the log, the review shape's trace, and the job's log gets its class alone; the run fails with 1, as Node's own
 * handling would.
 */
function escaped(error: unknown): never {
  const kind = error instanceof Error ? error.name : typeof error;
  log(`failed outside the review's stages: ${error instanceof Error ? error.stack ?? kind : kind}`);
  if (log !== say) say(`failed outside the review's stages: ${kind}; its stack goes to the trace`);
  process.exit(1);
}
process.on("uncaughtException", escaped);

/**
 * Each line appended with its time, a message's further lines indented under it, the directory made at the first. One
 * that can't be written is said once, and the rest of the trace is lost.
 */
function traceTo(path: string): (message: string) => void {
  let state: "new" | "open" | "lost" = "new";
  return (message) => {
    if (state === "lost") return;
    try {
      if (state === "new") mkdirSync(dirname(path), { recursive: true });
      state = "open";
      appendFileSync(path, `${new Date().toISOString()} ${message.replaceAll("\n", "\n  ")}\n`);
    } catch (failure) {
      state = "lost";
      say(`the trace couldn't be written to ${path} (${(failure as NodeJS.ErrnoException).code ?? "unknown error"}), so the rest of it is lost`);
    }
  };
}

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  say(told(error));
  process.exit(2);
}

const started = Date.now();
const usage = emptyUsage();
const usageByCaller = new Map<string, Usage>();
const usageByModel = new Map<string, Usage>();
if (config.shape) log = traceTo(join(config.shape.outDir, "trace.log"));
both(`reviewing ${config.nwo}#${config.prNumber} at ${config.head.slice(0, 12)}`);
both(`settings: ${describeSettings(config)}`);
if (config.shape) say("the review's trace goes to trace.log in its run directory, sealed with the run");

async function write(findings: OutputFinding[]): Promise<void> {
  const output = {
    pr: { repo: `https://github.com/${config.nwo}`, pr_number: config.prNumber, base: config.base, head: config.head },
    agent: config.agent,
    findings,
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
      cached_tokens: usage.cachedTokens,
      time_in_ms: Date.now() - started,
      cost_usd: Number(usage.costUsd.toFixed(6)),
    },
  };
  // Write beside the target and rename, so a crash never leaves half a file at RB_OUT.
  await mkdir(dirname(config.outPath), { recursive: true });
  const temporary = `${config.outPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`);
  await rename(temporary, config.outPath);
}

/** One line for each seat and for the verifier, so a run shows where its tokens and money went. */
function logUsageByCaller(): void {
  for (const [caller, spent] of usageByCaller) {
    log(`usage ${caller}: ${spent.calls} model call(s), ${spent.promptTokens} prompt token(s) (${spent.cachedTokens} cached), ${spent.completionTokens} completion token(s), $${spent.costUsd.toFixed(4)}`);
  }
}

/** Each caller's conversation. The tool loop sends its whole message list on every call, so the last list a caller sent is its conversation. */
const transcripts = new Map<string, { model: string; messages: ChatMessage[] }>();

async function writeTranscripts(): Promise<void> {
  if (!config.transcriptOutPath) return;
  const conversations = [...transcripts].map(([caller, { model, messages }]) => ({ caller, model, messages }));
  await writeFile(config.transcriptOutPath, `${JSON.stringify({ nwo: config.nwo, pr_number: config.prNumber, head: config.head, conversations })}\n`);
}

try {
  const send = createChat({ apiKey: config.apiKey, baseUrl: config.baseUrl, api: config.api, headers: config.headers, effort: config.effort, usage, usageByCaller, usageByModel });
  const chat: Chat = config.transcriptOutPath
    ? (request) => {
      transcripts.set(request.caller ?? request.model, { model: request.model, messages: request.messages });
      return send(request);
    }
    : send;
  if (config.shape) {
    // The review shape asks battery A's model through Responses, with the same key and gateway headers as the Claude endpoint.
    const responses = createChat({ apiKey: config.apiKey, baseUrl: config.shape.responsesBaseUrl, api: "responses", headers: config.headers, effort: null, usage, usageByCaller, usageByModel });
    const outcome = await shapeReview({
      config, claude: chat, responses, usageByCaller, usageByModel, log,
      run: { outDir: config.shape.outDir, keptDir: config.shape.keptDir, label: config.shape.label, round: config.shape.round, roundOf: config.shape.roundOf },
    });
    logUsageByCaller();
    if (outcome.stop) {
      // Stopped with its answers kept in the run directories, to be resumed. A first attempt writes no findings file,
      // which would claim a review that didn't happen; exit 3 tells the Action it stopped rather than failed. The
      // reason is what the stop notice says on the pull request; the detail names a stage, so only the trace has it.
      log(`review stopped (${outcome.stop.reason}): ${outcome.stop.detail}`);
      say(`review stopped (${outcome.stop.reason})`);
      await mkdir(dirname(config.outPath), { recursive: true });
      await writeFile(join(dirname(config.outPath), "stopped.json"), `${JSON.stringify(outcome.stop, null, 2)}\n`);
      // As for any review: a repeat attempt that also gives no review writes an empty list, since a benchmark run
      // with one pull request that never succeeds fails whole. The Action runs one attempt, which stops.
      if (config.attempt >= 2) {
        both(`attempt ${config.attempt} also stopped; writing an empty findings list`);
        await write([]);
        process.exit(0);
      }
      process.exit(3);
    }
    await write(outcome.findings);
    log(`${outcome.findings.length} finding(s) written by the review shape; ${usage.calls} model call(s), ${Math.round((Date.now() - started) / 1000)}s`);
    if (outcome.review) say(`the review shape finished: ${outcomeLine(outcome.review)}`);
    process.exit(0);
  }
  // The swarm is a prototype kept outside src, so it is loaded only when it is turned on.
  const swarmReview = config.swarm ? (await import("../experiments/prototypes/swarm/review.ts")).swarmReview : null;
  const outcome = await (swarmReview ?? (config.naive ? naiveReview : review))(config, chat, log);
  await write(outcome.findings);
  if (config.detailsOutPath) {
    const details = outcome.ranked.map((candidate) => ({
      file: candidate.file, start_line: candidate.startLine, end_line: candidate.endLine,
      severity: candidate.severity, kind: candidate.kind, title: candidate.title, detail: candidate.detail,
    }));
    const decided = (outcome.decided ?? []).map((repeat) => ({ file: repeat.file, title: repeat.title, repeat_of: repeat.repeatOf }));
    await writeFile(config.detailsOutPath, `${JSON.stringify({ findings: details, ...(decided.length ? { decided } : {}) }, null, 2)}\n`);
  }
  if (outcome.fit) await writeFile(config.fitOutPath, `${JSON.stringify(outcome.fit, null, 2)}\n`);
  if (config.contextOutPath) {
    const context = { nwo: config.nwo, pr_number: config.prNumber, head: config.head, diff_in_prompt: outcome.context.diffInPrompt, readers: outcome.context.readers };
    await writeFile(config.contextOutPath, `${JSON.stringify(context)}\n`);
  }
  await writeTranscripts();
  logUsageByCaller();
  log(`${outcome.findings.length} finding(s) written (${outcome.proposed} proposed, ${outcome.verified ? "verified" : "not verified"}); ${usage.calls} model call(s), $${usage.costUsd.toFixed(4)}, ${Math.round((Date.now() - started) / 1000)}s`);
} catch (error) {
  both(`failed: ${told(error)}`);
  logUsageByCaller();
  // The first failure exits non-zero so the benchmark retries. A repeat failure
  // writes an empty list, because one pull request that never succeeds fails the whole run.
  if (config.attempt < 2) process.exit(1);
  both(`attempt ${config.attempt} also produced no review; writing an empty findings list`);
  await write([]);
}
