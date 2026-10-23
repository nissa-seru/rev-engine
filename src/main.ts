// Container entry point: review the mounted pull request and write the findings file.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeSettings, loadConfig, type Config } from "./config.ts";
import { createChat, emptyUsage, type Chat, type ChatMessage, type Usage } from "./llm.ts";
import type { OutputFinding } from "./findings.ts";
import { naiveReview } from "./naive.ts";
import { review } from "./review.ts";
import { shapeReview } from "./shape/run.ts";

const log = (message: string): void => console.error(`agent: ${message}`);

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const started = Date.now();
const usage = emptyUsage();
const usageByCaller = new Map<string, Usage>();
log(`reviewing ${config.nwo}#${config.prNumber} at ${config.head.slice(0, 12)}`);
log(`settings: ${describeSettings(config)}`);

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
  const send = createChat({ apiKey: config.apiKey, baseUrl: config.baseUrl, api: config.api, headers: config.headers, effort: config.effort, usage, usageByCaller });
  const chat: Chat = config.transcriptOutPath
    ? (request) => {
      transcripts.set(request.caller ?? request.model, { model: request.model, messages: request.messages });
      return send(request);
    }
    : send;
  if (config.shape) {
    // The review shape asks Sol through Responses, with the same key and gateway headers as the Claude endpoint.
    const sol = createChat({ apiKey: config.apiKey, baseUrl: config.shape.solBaseUrl, api: "responses", headers: config.headers, effort: null, usage, usageByCaller });
    const outcome = await shapeReview({
      config, claude: chat, sol, usageByCaller, log,
      run: { outDir: config.shape.outDir, keptDir: config.shape.keptDir, label: config.shape.label, round: config.shape.round, roundOf: config.shape.roundOf },
    });
    logUsageByCaller();
    if (outcome.stop) {
      // Stopped with its answers kept in the run directories, to be resumed. A first attempt writes no findings file,
      // which would claim a review that didn't happen; exit 3 tells the Action it stopped rather than failed.
      log(`review stopped (${outcome.stop.reason}): ${outcome.stop.detail}`);
      await mkdir(dirname(config.outPath), { recursive: true });
      await writeFile(join(dirname(config.outPath), "stopped.json"), `${JSON.stringify(outcome.stop, null, 2)}\n`);
      // As for any review: a repeat attempt that also gives no review writes an empty list, since a benchmark run
      // with one pull request that never succeeds fails whole. The Action runs one attempt, which stops.
      if (config.attempt >= 2) {
        log(`attempt ${config.attempt} also stopped; writing an empty findings list`);
        await write([]);
        process.exit(0);
      }
      process.exit(3);
    }
    await write(outcome.findings);
    log(`${outcome.findings.length} finding(s) written by the review shape; ${usage.calls} model call(s), ${Math.round((Date.now() - started) / 1000)}s`);
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
  log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  logUsageByCaller();
  // The first failure exits non-zero so the benchmark retries. A repeat failure
  // writes an empty list, because one pull request that never succeeds fails the whole run.
  if (config.attempt < 2) process.exit(1);
  log(`attempt ${config.attempt} also produced no review; writing an empty findings list`);
  await write([]);
}
