import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MESSAGE = {
  id: "msg_1", type: "message", role: "assistant", model: "claude-test",
  content: [
    { type: "thinking", thinking: "Compare the two.", signature: "sig" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "text", text: "Matched." },
    { type: "tool_use", id: "toolu_1", name: "submit", input: { matches: [1, 2] } },
  ],
  stop_reason: "tool_use", stop_sequence: null,
  usage: { input_tokens: 12, cache_read_input_tokens: 30, output_tokens: 9 },
};

interface Seen { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown>; closed: Promise<void> }

/** A stub endpoint answering whole, and the shim in front of it. */
async function start(answer: (body: Record<string, any>, response: ServerResponse) => void) {
  const seen: Seen[] = [];
  const upstream: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ url: request.url ?? "", headers: request.headers, body, closed: new Promise((done) => response.on("close", () => done())) });
    answer(body, response);
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const port = (upstream.address() as { port: number }).port;
  const urlFile = join(mkdtempSync(join(tmpdir(), "rep-shim-")), "url");
  let stderr = "";
  const shim: ChildProcess = spawn(process.execPath, ["scripts/stream-shim.ts", urlFile], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, RB_MODEL_API: "anthropic", RB_MODEL_BASE_URL: `http://127.0.0.1:${port}/anthropic`, RB_MODEL_API_KEY: "unused", RB_MODEL_HEADERS: '{"x-class":"batch"}' },
  });
  shim.stderr!.on("data", (chunk) => { stderr += chunk; });
  const stop = () => { shim.kill(); upstream.close(); upstream.closeAllConnections(); };
  for (let wait = 0; wait < 200 && !(existsSync(urlFile) && readFileSync(urlFile, "utf8").trim()); wait += 1) {
    if (shim.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!existsSync(urlFile)) {
    stop();
    assert.fail(`the shim did not start: ${stderr}`);
  }
  const base = readFileSync(urlFile, "utf8").trim();
  const send = (body: Record<string, unknown>, signal?: AbortSignal, headers: Record<string, string> = {}) => fetch(`${base}/v1/messages`, {
    method: "POST", signal,
    headers: { "x-api-key": "grant", "anthropic-version": "2023-06-01", "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "claude-test", max_tokens: 100, messages: [{ role: "user", content: "Match." }], ...body }),
  });
  return { seen, send, stop, upstream };
}

function whole(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
}

/** Puts a message back together from its stream, the way a streaming client does. */
function reassemble(text: string): Record<string, any> {
  let message: Record<string, any> = {};
  const json: string[] = [];
  const stopped = new Set<number>();
  const names: string[] = [];
  for (const chunk of text.split("\n\n").filter(Boolean)) {
    const [eventLine, dataLine] = chunk.split("\n");
    const event = eventLine!.slice("event: ".length);
    const data = JSON.parse(dataLine!.slice("data: ".length));
    assert.equal(data.type, event);
    names.push(event);
    if (event === "message_start") message = data.message;
    else if (event === "content_block_start") {
      assert.equal(data.index, message.content.length);
      message.content.push(data.content_block);
    } else if (event === "content_block_delta") {
      const block = message.content[data.index];
      if (data.delta.type === "text_delta") block.text += data.delta.text;
      else if (data.delta.type === "thinking_delta") block.thinking += data.delta.thinking;
      else if (data.delta.type === "signature_delta") block.signature += data.delta.signature;
      else if (data.delta.type === "input_json_delta") json[data.index] = (json[data.index] ?? "") + data.delta.partial_json;
    } else if (event === "content_block_stop") {
      stopped.add(data.index);
      if (json[data.index] !== undefined) message.content[data.index].input = JSON.parse(json[data.index]!);
    } else if (event === "message_delta") Object.assign(message, data.delta, { usage: data.usage });
  }
  assert.equal(names.at(-1), "message_stop");
  assert.equal(stopped.size, message.content.length);
  return message;
}

test("the stream shim sends a streamed request on whole, with the endpoint's headers, and streams the answer back", async () => {
  const { seen, send, stop } = await start((_body, response) => whole(response, 200, JSON.stringify(MESSAGE)));
  try {
    const response = await send({ stream: true });
    assert.equal(response.status, 200);
    await (await send({ stream: true }, undefined, { "x-class": "the judge's" })).text();
    assert.equal(seen[1]!.headers["x-class"], "the judge's");
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.deepEqual(reassemble(await response.text()), MESSAGE);
    assert.equal(seen[0]!.url, "/anthropic/v1/messages");
    assert.deepEqual(seen[0]!.body, { model: "claude-test", max_tokens: 100, messages: [{ role: "user", content: "Match." }] });
    assert.equal(seen[0]!.headers["x-api-key"], "grant");
    assert.equal(seen[0]!.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen[0]!.headers["x-class"], "batch");
  } finally {
    stop();
  }
});

test("the stream shim passes through a request that doesn't stream, and an error answer with its headers", async () => {
  const { send, stop } = await start((body, response) => {
    if (body.model === "busy") whole(response, 429, '{"type":"error","error":{"type":"rate_limit_error","message":"busy"}}', { "retry-after": "7" });
    else whole(response, 200, JSON.stringify(MESSAGE), { "request-id": "req_1" });
  });
  try {
    const plain = await send({});
    assert.equal(plain.headers.get("content-type"), "application/json");
    assert.equal(plain.headers.get("request-id"), "req_1");
    assert.deepEqual(await plain.json(), MESSAGE);
    const refused = await send({ stream: true, model: "busy" });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "7");
    assert.deepEqual(await refused.json(), { type: "error", error: { type: "rate_limit_error", message: "busy" } });
  } finally {
    stop();
  }
});

test("the stream shim passes a compressed answer on decoded, without its encoding header", async () => {
  const { send, stop } = await start((_body, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end(gzipSync(JSON.stringify(MESSAGE)));
  });
  try {
    const plain = await send({});
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.deepEqual(await plain.json(), MESSAGE);
  } finally {
    stop();
  }
});

test("the stream shim answers 502 with a Messages error when the endpoint's answer isn't a message or it can't be reached", async () => {
  const { send, stop, upstream } = await start((body, response) => {
    if (body.model === "json") whole(response, 200, '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}');
    else whole(response, 200, "<html>gateway page</html>", { "content-type": "text/html" });
  });
  try {
    const notMessage = await send({ stream: true, model: "json" });
    assert.equal(notMessage.status, 502);
    assert.match(((await notMessage.json()) as { error: { message: string } }).error.message, /isn't a Messages message/);
    const garbled = await send({ stream: true });
    assert.equal(garbled.status, 502);
    assert.equal(((await garbled.json()) as { error: { type: string } }).error.type, "api_error");
    upstream.close();
    upstream.closeAllConnections();
    const unreachable = await send({ stream: true });
    assert.equal(unreachable.status, 502);
    assert.match(((await unreachable.json()) as { error: { message: string } }).error.message, /^stream-shim: fetch failed: .+/);
  } finally {
    stop();
  }
});

test("the stream shim stops the endpoint's request when its caller gives up", async () => {
  const { seen, send, stop } = await start(() => { /* never answers */ });
  try {
    const caller = new AbortController();
    const pending = send({ stream: true }, caller.signal).catch(() => null);
    for (let wait = 0; wait < 250 && !seen.length; wait += 1) await new Promise((done) => setTimeout(done, 20));
    assert.ok(seen.length, "the request never reached the endpoint");
    caller.abort();
    await pending;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the endpoint's request stayed open")), 5_000); });
    await Promise.race([seen[0]!.closed, late]).finally(() => clearTimeout(timer));
  } finally {
    stop();
  }
});
