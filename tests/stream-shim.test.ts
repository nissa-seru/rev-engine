import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MESSAGE = {
  id: "msg_1", type: "message", role: "assistant", model: "claude-test",
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "Matched." },
    { type: "tool_use", id: "toolu_1", name: "submit", input: { matches: [1, 2] } },
  ],
  stop_reason: "tool_use", stop_sequence: null,
  usage: { input_tokens: 12, cache_read_input_tokens: 30, output_tokens: 9 },
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

test("the stream shim sends a streamed request on whole and plays the answer back as Messages events", async () => {
  const seen: Array<{ url: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ url: request.url ?? "", headers: request.headers, body });
    if (body.model === "busy") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "busy" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(MESSAGE));
  });
  const port = await listen(upstream);
  const urlFile = join(mkdtempSync(join(tmpdir(), "rep-shim-")), "url");
  const shim = spawn(process.execPath, ["scripts/stream-shim.ts", urlFile], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, RB_MODEL_API: "anthropic", RB_MODEL_BASE_URL: `http://127.0.0.1:${port}/anthropic`, RB_MODEL_API_KEY: "unused", RB_MODEL_HEADERS: '{"x-class":"batch"}' },
  });
  try {
    for (let wait = 0; wait < 100 && !(existsSync(urlFile) && readFileSync(urlFile, "utf8").trim()); wait += 1) await new Promise((done) => setTimeout(done, 50));
    const base = readFileSync(urlFile, "utf8").trim();
    const send = (model: string) => fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "grant", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, max_tokens: 100, messages: [{ role: "user", content: "Match." }] }),
    });

    const response = await send("claude-test");
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const events = (await response.text()).split("\n\n").filter(Boolean).map((chunk) => {
      const [eventLine, dataLine] = chunk.split("\n");
      return { event: eventLine!.slice("event: ".length), data: JSON.parse(dataLine!.slice("data: ".length)) };
    });
    assert.deepEqual(events.map((item) => item.event), [
      "message_start",
      "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    assert.deepEqual(events[0]!.data.message.content, []);
    assert.equal(events[0]!.data.message.usage.input_tokens, 12);
    assert.deepEqual(events[2]!.data.delta, { type: "signature_delta", signature: "sig" });
    assert.deepEqual(events[5]!.data.delta, { type: "text_delta", text: "Matched." });
    assert.deepEqual(events[7]!.data.content_block, { type: "tool_use", id: "toolu_1", name: "submit", input: {} });
    assert.deepEqual(JSON.parse(events[8]!.data.delta.partial_json), { matches: [1, 2] });
    assert.deepEqual(events[10]!.data, { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: MESSAGE.usage });

    assert.equal(seen[0]!.url, "/anthropic/v1/messages");
    assert.equal(seen[0]!.body.stream, undefined);
    assert.equal(seen[0]!.headers["x-api-key"], "grant");
    assert.equal(seen[0]!.headers["x-class"], "batch");

    const refused = await send("busy");
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { type: "error", error: { type: "rate_limit_error", message: "busy" } });
  } finally {
    shim.kill();
    upstream.close();
  }
});
