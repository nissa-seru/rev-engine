// Serves the Anthropic Messages API with streaming in front of an endpoint that answers
// each request whole.
//
//   node scripts/stream-shim.ts <url-file>
//
// ReviewBench's judging CLI streams every model request. When RB_MODEL_API is anthropic and
// the judge's provider isn't openrouter, scripts/score.sh starts this and points the judge at it. It listens on loopback, sends
// each request on to RB_MODEL_BASE_URL without `stream`, and plays the whole answer back
// as the events the Messages API streams. Requests that don't stream, and answers that
// aren't a success, pass through unchanged. The judge's own key and headers go on with
// each request, with RB_MODEL_HEADERS added where the judge sent no header of that name. Once it listens, it writes its base URL to
// <url-file>, and it runs until it is stopped.
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEndpoint } from "../src/config.ts";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const urlFile = process.argv[2];
if (!urlFile) throw new Error("usage: node scripts/stream-shim.ts <url-file>");
const endpoint = readEndpoint(here);
if (endpoint.api !== "anthropic") throw new Error("stream-shim serves only RB_MODEL_API=anthropic");

/** Headers that belong to one connection, which each side sets for its own. */
const HOP = new Set(["host", "connection", "keep-alive", "content-length", "transfer-encoding", "accept-encoding"]);
/** An answer's headers that don't survive fetch decoding its body. */
const DECODED = new Set([...HOP, "content-encoding"]);

function forwarded(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP.has(name) && value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The judge's own headers win, as the reviewer's client's own do.
  return { ...endpoint.headers, ...out };
}

type Block = Record<string, any>;

/** The events the Messages API streams for this whole message, in order. */
function* events(message: Record<string, any>): Generator<[string, Record<string, unknown>]> {
  const { content = [], stop_reason = null, stop_sequence = null, usage = {}, ...rest } = message;
  yield ["message_start", { type: "message_start", message: { ...rest, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }];
  for (const [index, block] of (content as Block[]).entries()) {
    const delta = (value: Record<string, unknown>): [string, Record<string, unknown>] => ["content_block_delta", { type: "content_block_delta", index, delta: value }];
    if (block.type === "text") {
      yield ["content_block_start", { type: "content_block_start", index, content_block: { ...block, text: "" } }];
      if (block.text) yield delta({ type: "text_delta", text: block.text });
    } else if (block.type === "thinking") {
      yield ["content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }];
      if (block.thinking) yield delta({ type: "thinking_delta", thinking: block.thinking });
      if (block.signature) yield delta({ type: "signature_delta", signature: block.signature });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      yield ["content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } }];
      yield delta({ type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) });
    } else {
      // Blocks that arrive whole in a stream too, such as redacted thinking.
      yield ["content_block_start", { type: "content_block_start", index, content_block: block }];
    }
    yield ["content_block_stop", { type: "content_block_stop", index }];
  }
  yield ["message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence }, usage }];
  yield ["message_stop", { type: "message_stop" }];
}

const server = createServer(async (request, response) => {
  // A judge that gives up stops the request it was waiting for.
  const abort = new AbortController();
  response.on("close", () => { if (!response.writableEnded) abort.abort(); });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    let body: Record<string, unknown> | null = null;
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : null;
    } catch {
      // Not JSON: it passes through as sent.
    }
    const streamed = request.method === "POST" && body?.stream === true;
    if (streamed) delete body!.stream;
    const upstream = await fetch(`${endpoint.baseUrl}${request.url ?? ""}`, {
      method: request.method,
      headers: forwarded(request.headers),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : streamed ? JSON.stringify(body) : raw,
      signal: abort.signal,
    });
    const text = await upstream.text();
    if (!streamed || !upstream.ok) {
      // As it came, retry-after and the like included; fetch has already decoded the body.
      response.writeHead(upstream.status, [...upstream.headers].filter(([name]) => !DECODED.has(name)).flat());
      response.end(text);
      return;
    }
    // Built whole before the head is sent, so an answer that isn't a message still gets an error status.
    const message: unknown = JSON.parse(text);
    if (!message || typeof message !== "object" || !Array.isArray((message as { content?: unknown }).content)) {
      throw new Error("the endpoint's answer isn't a Messages message");
    }
    const stream = [...events(message as Record<string, any>)].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.end(stream);
  } catch (error) {
    if (abort.signal.aborted) return;
    // fetch says only "fetch failed"; its cause says why, such as a refused connection or a timeout.
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    const message = `${error instanceof Error ? error.message : String(error)}${cause}`;
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `stream-shim: ${message}` } }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stream-shim could not read its own address");
  void writeFile(urlFile, `http://127.0.0.1:${address.port}\n`);
});
