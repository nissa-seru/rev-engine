import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { createChat, emptyUsage, longFetch, MODEL_REFUSAL, ModelError, ModelRefused, ModelUnavailable, toAnthropic, toResponses, type ChatMessage, type Usage } from "../src/llm.ts";

function replying(usage: Record<string, unknown>): typeof fetch {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "ok" } }],
    usage,
  }))) as typeof fetch;
}

test("totals usage for the run and for each caller that names itself", async () => {
  const usage = emptyUsage();
  const usageByCaller = new Map<string, Usage>();
  const chat = createChat({
    apiKey: "key", baseUrl: "https://example.test/v1", effort: null, usage, usageByCaller,
    fetchImpl: replying({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 }, cost: 0.5 }),
  });
  const request = { model: "test/model", messages: [], tools: [], timeoutMs: 5_000 };
  await chat({ ...request, caller: "s1" });
  await chat({ ...request, caller: "s1" });
  await chat({ ...request, caller: "verifier" });
  await chat(request);

  assert.deepEqual(usage, { calls: 4, promptTokens: 400, completionTokens: 40, cachedTokens: 240, reasoningTokens: 0, costUsd: 2 });
  assert.deepEqual(usageByCaller.get("s1"), { calls: 2, promptTokens: 200, completionTokens: 20, cachedTokens: 120, reasoningTokens: 0, costUsd: 1 });
  assert.deepEqual(usageByCaller.get("verifier"), { calls: 1, promptTokens: 100, completionTokens: 10, cachedTokens: 60, reasoningTokens: 0, costUsd: 0.5 });
  assert.deepEqual([...usageByCaller.keys()], ["s1", "verifier"]);
});

test("sends a per-call effort, a reasoning cap in its place, and a provider sort to OpenRouter", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "key", baseUrl: "https://openrouter.ai/api/v1", effort: "high", usage: emptyUsage(), fetchImpl });
  const request = { model: "test/model", messages: [], tools: [], timeoutMs: 5_000 };
  await chat(request);
  await chat({ ...request, effort: "low" });
  await chat({ ...request, effort: "low", reasoningTokens: 1500, providerSort: "latency" });
  assert.deepEqual(bodies.map((body) => body.reasoning), [{ effort: "high" }, { effort: "low" }, { max_tokens: 1500 }]);
  assert.deepEqual(bodies[2]!.provider, { sort: "latency" });
});

test("sends chat completions to <base URL>/chat/completions with the key as a bearer token and the extra headers", async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "key", baseUrl: "https://example.test/v1", headers: { "x-class": "batch" }, effort: null, usage: emptyUsage(), fetchImpl });
  await chat({ model: "test/model", messages: [], tools: [], timeoutMs: 5_000 });
  assert.equal(requests[0]!.url, "https://example.test/v1/chat/completions");
  assert.equal(requests[0]!.headers.authorization, "Bearer key");
  assert.equal(requests[0]!.headers["x-class"], "batch");
});

test("speaks Anthropic Messages: system, tools, tool results, caching, and the reply as a chat message", async () => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const fetchImpl = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    requests.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "b.ts" } },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 7 },
    }));
  }) as unknown as typeof fetch;
  const usage = emptyUsage();
  const chat = createChat({ apiKey: "grant", baseUrl: "http://127.0.0.1:9/anthropic", api: "anthropic", headers: { "x-class": "batch" }, effort: "high", usage, fetchImpl });
  const tools = [{ type: "function" as const, function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
  const reply = await chat({
    model: "claude-test", tools, timeoutMs: 5_000,
    messages: [
      { role: "system", content: "Review the change." },
      { role: "user", content: "Here is the diff." },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }], reasoning_details: [{ type: "thinking", thinking: "", signature: "s1" }] },
      { role: "tool", tool_call_id: "toolu_1", content: "1: one" },
      { role: "user", content: "Keep going." },
    ],
  });

  const { url, method, headers, body } = requests[0]!;
  assert.equal(url, "http://127.0.0.1:9/anthropic/v1/messages");
  assert.equal(method, "POST");
  assert.equal(body.model, "claude-test");
  assert.equal(body.max_tokens, 16_000);
  assert.equal(headers["x-api-key"], "grant");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-class"], "batch");
  assert.equal(body.system, "Review the change.");
  assert.deepEqual(body.tools, [{ name: "read_file", description: "Read a file.", input_schema: tools[0]!.function.parameters }]);
  assert.deepEqual(body.tool_choice, { type: "auto" });
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "Here is the diff." }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s1" }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "1: one" }, { type: "text", text: "Keep going.", cache_control: { type: "ephemeral" } }] },
  ]);

  assert.deepEqual(reply, {
    role: "assistant", content: "Reading it.", contextTokens: 102,
    tool_calls: [{ id: "toolu_2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.ts\"}" } }],
    reasoning_details: [{ type: "thinking", thinking: "", signature: "sig" }],
  });
  assert.deepEqual(usage, { calls: 1, promptTokens: 95, completionTokens: 7, cachedTokens: 80, reasoningTokens: 0, costUsd: 0 });
});

const SUBMIT = { type: "function" as const, function: { name: "submit", description: "Hand in the answer.", parameters: { type: "object", properties: {} } } };

test("a call that thinks leaves the tool to the model, one that doesn't is forced, and both keep earlier thinking", async () => {
  const bodies: Array<Record<string, any>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "toolu_9", name: "submit", input: {} }], usage: {} }));
  }) as unknown as typeof fetch;
  const messages = [
    { role: "user" as const, content: "Review." },
    { role: "assistant" as const, content: "Done reading.", reasoning_details: [{ type: "thinking", thinking: "", signature: "s1" }] },
    { role: "user" as const, content: "Submit now." },
  ];
  const thinking = createChat({ apiKey: "grant", baseUrl: "https://example.test", api: "anthropic", effort: "high", usage: emptyUsage(), fetchImpl });
  await thinking({ model: "claude-test", tools: [SUBMIT], timeoutMs: 5_000, forceTool: "submit", messages });
  assert.deepEqual(bodies[0]!.tool_choice, { type: "auto" });
  assert.deepEqual(bodies[0]!.thinking, { type: "adaptive" });
  assert.deepEqual(bodies[0]!.output_config, { effort: "high" });
  assert.deepEqual(bodies[0]!.messages[1].content[0], { type: "thinking", thinking: "", signature: "s1" });

  const plain = createChat({ apiKey: "grant", baseUrl: "https://example.test", api: "anthropic", effort: null, usage: emptyUsage(), fetchImpl });
  await plain({ model: "claude-test", tools: [SUBMIT], timeoutMs: 5_000, forceTool: "submit", messages });
  assert.deepEqual(bodies[1]!.tool_choice, { type: "tool", name: "submit" });
  assert.equal(bodies[1]!.thinking, undefined);
  assert.equal(bodies[1]!.output_config, undefined);
  // Thinking a reply carried goes back whatever this call's effort, since a model may think unasked.
  assert.deepEqual(bodies[1]!.messages[1].content[0], { type: "thinking", thinking: "", signature: "s1" });
});

test("a reply that thought unasked sends its thinking back with the next request", async () => {
  const bodies: Array<Record<string, any>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      content: [{ type: "thinking", thinking: "Unasked.", signature: "u1" }, { type: "text", text: "Done." }],
      usage: {},
    }));
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "grant", baseUrl: "https://example.test", api: "anthropic", effort: null, usage: emptyUsage(), fetchImpl });
  const first = { role: "user" as const, content: "Review." };
  const reply = await chat({ model: "claude-test", tools: [], timeoutMs: 5_000, messages: [first] });
  await chat({ model: "claude-test", tools: [], timeoutMs: 5_000, messages: [first, reply, { role: "user", content: "Go on." }] });
  assert.equal(bodies[1]!.thinking, undefined);
  assert.deepEqual(bodies[1]!.messages[1].content[0], { type: "thinking", thinking: "Unasked.", signature: "u1" });
});

test("a model that refuses a forced tool choice is asked again, and from then on, with the choice left to it", async () => {
  const calls: Array<{ model: string; choice: unknown }> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ model: body.model, choice: body.tool_choice });
    const refuse = (message: string) => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), { status: 400 });
    if (body.model === "claude-refuses" && body.tool_choice.type === "tool") return refuse("tool_choice: type \"tool\" and \"any\" are not supported for this model.");
    if (body.model === "claude-unknown-tool" && body.tool_choice.type === "tool") return refuse("tool_choice.name: no tool named submit");
    if (body.model === "claude-422" && body.tool_choice.type === "tool") {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "tool_choice: type \"tool\" is not supported here, 422" } }), { status: 422 });
    }
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "toolu_1", name: "submit", input: {} }], usage: {} }));
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "grant", baseUrl: "https://example.test", api: "anthropic", effort: null, usage: emptyUsage(), fetchImpl });
  const request = { tools: [SUBMIT], timeoutMs: 5_000, forceTool: "submit", messages: [{ role: "user" as const, content: "Submit." }] };
  const reply = await chat({ ...request, model: "claude-refuses" });
  await chat({ ...request, model: "claude-refuses" });
  await chat({ ...request, model: "claude-forced" });
  assert.equal(reply.tool_calls?.[0]?.function.name, "submit");
  assert.deepEqual(calls, [
    { model: "claude-refuses", choice: { type: "tool", name: "submit" } },
    { model: "claude-refuses", choice: { type: "auto" } },
    { model: "claude-refuses", choice: { type: "auto" } },
    { model: "claude-forced", choice: { type: "tool", name: "submit" } },
  ]);
  // Another 400 about the tool choice is the caller's to handle, and the model stays forced.
  await assert.rejects(chat({ ...request, model: "claude-unknown-tool" }), /no tool named submit/);
  await assert.rejects(chat({ ...request, model: "claude-unknown-tool" }), /no tool named submit/);
  // A refusal is a 400; the same words with another status are the caller's too.
  await assert.rejects(chat({ ...request, model: "claude-422" }), /422/);
});

test("only Anthropic's own thinking blocks go back to Anthropic Messages", () => {
  const { messages } = toAnthropic([
    { role: "user", content: "Review." },
    { role: "assistant", content: "Done.", reasoning_details: [{ type: "reasoning.text", text: "another provider's" }, { type: "thinking", thinking: "", signature: "s1" }, { type: "redacted_thinking", data: "r1" }] },
    { role: "user", content: "Again." },
  ]);
  assert.deepEqual(messages[1], { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s1" }, { type: "redacted_thinking", data: "r1" }, { type: "text", text: "Done." }] });
});

test("an empty assistant turn is left out, and tool arguments that aren't an object are kept as text", () => {
  const { messages } = toAnthropic([
    { role: "user", content: "Review." },
    { role: "assistant", content: null },
    { role: "user", content: "Continue." },
    { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "submit", arguments: "{\"findings\": [" } }] },
    { role: "user", content: "Once more." },
    { role: "assistant", content: null, tool_calls: [{ id: "toolu_2", type: "function", function: { name: "submit", arguments: "[1]" } }] },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "Review." }, { type: "text", text: "Continue." }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "submit", input: { input: "{\"findings\": [" } }] },
    { role: "user", content: [{ type: "text", text: "Once more." }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "submit", input: { input: "[1]" }, cache_control: { type: "ephemeral" } }] },
  ]);
});

// The Responses API, as a gateway serves it at /openai/responses.

const READ = { type: "function" as const, function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } };

function respondingWith(status: number, payload: unknown, seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = []): typeof fetch {
  return (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
}

test("speaks Responses as the gateway serves it: store false, encrypted reasoning, no stream, the conversation header, and the reply as a chat message", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const output = [
    { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "enc-2" },
    { type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: "Reading it." }] },
    // As the gateway relays a call: with fields the API adds for the caller, which it refuses as input.
    { type: "function_call", id: "fc_2", call_id: "call_2", name: "read_file", arguments: "{\"path\":\"b.ts\"}", parsed_arguments: { path: "b.ts" }, status: "completed", metadata: {}, internal_chat_message_metadata_passthrough: {} },
  ];
  const usage = emptyUsage();
  const chat = createChat({
    apiKey: "grant", baseUrl: "http://127.0.0.1:9/openai", api: "responses", headers: { "x-orca-class": "batch", "x-caller-tag": "rev-engine" }, effort: "xhigh", usage,
    fetchImpl: respondingWith(200, { id: "resp_2", output, usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 90, output_tokens_details: { reasoning_tokens: 60 } } }, seen),
  });
  const earlier = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
  ];
  const reply = await chat({
    model: "gpt-6.1-sol", tools: [READ], timeoutMs: 5_000, conversation: "re-o.n-1-1:A:t1",
    messages: [
      { role: "system", content: "Review the change." },
      { role: "user", content: "Here is the diff." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }], items: earlier },
      { role: "tool", tool_call_id: "call_1", content: "1: one" },
      { role: "user", content: "Keep going." },
    ],
  });

  const { url, headers, body } = seen[0]!;
  assert.equal(url, "http://127.0.0.1:9/openai/responses");
  assert.equal(headers.authorization, "Bearer grant");
  assert.equal(headers["x-orca-conversation"], "re-o.n-1-1:A:t1");
  assert.equal(headers["x-orca-class"], "batch");
  assert.equal(headers["x-caller-tag"], "rev-engine");
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal("stream" in body, false, "the gateway refuses stream: true");
  assert.equal("max_output_tokens" in body, false, "the gateway refuses max_output_tokens");
  assert.deepEqual(body.reasoning, { effort: "xhigh" });
  assert.equal(body.instructions, "Review the change.");
  assert.deepEqual(body.tools, [{ type: "function", name: "read_file", description: "Read a file.", parameters: READ.function.parameters, strict: false }]);
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Here is the diff." }] },
    ...earlier,
    { type: "function_call_output", call_id: "call_1", output: "1: one" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Keep going." }] },
  ]);

  assert.deepEqual(reply, {
    role: "assistant", content: "Reading it.", items: output, contextTokens: 1290,
    tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.ts\"}" } }],
  });
  assert.deepEqual(usage, { calls: 1, promptTokens: 1200, completionTokens: 90, cachedTokens: 1000, reasoningTokens: 60, costUsd: 0 });

  // The reply goes back as its turn on the next request: its encrypted reasoning whole, its text, and its call
  // without the fields the API adds (a probe through the gateway was refused "Unknown parameter: 'input[1].parsed_arguments'").
  const next = toResponses([{ role: "user", content: "Go." }, reply, { role: "tool", tool_call_id: "call_2", content: "1: two" }]);
  assert.deepEqual(next.input.slice(1), [
    output[0],
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading it." }] },
    { type: "function_call", id: "fc_2", call_id: "call_2", name: "read_file", arguments: "{\"path\":\"b.ts\"}" },
    { type: "function_call_output", call_id: "call_2", output: "1: two" },
  ]);
});

test("a forced tool goes as Responses' tool_choice, and an effort left out sends no reasoning", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const chat = createChat({ apiKey: "grant", baseUrl: "http://127.0.0.1:9/openai", api: "responses", effort: null, usage: emptyUsage(), fetchImpl: respondingWith(200, { output: [] }, seen) });
  await chat({ model: "gpt-6.1-sol", messages: [{ role: "user", content: "Submit." }], tools: [READ, SUBMIT], timeoutMs: 5_000, forceTool: "submit" });
  assert.deepEqual(seen[0]!.body.tool_choice, { type: "function", name: "submit" });
  assert.equal("reasoning" in seen[0]!.body, false);
  assert.equal("x-orca-conversation" in seen[0]!.headers, false, "no conversation named, no header");
});

test("an assistant turn that didn't come from Responses goes as its text and its calls", () => {
  const turn: ChatMessage = { role: "assistant", content: "Looking.", tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: "{}" } }], reasoning_details: [{ type: "thinking", thinking: "", signature: "s" }] };
  assert.deepEqual(toResponses([turn]).input, [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] },
    { type: "function_call", call_id: "call_9", name: "read_file", arguments: "{}" },
  ]);
});

test("a classifier refusal is ModelRefused, keeps its category alone, and isn't asked again", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: "cyber_policy", type: "invalid_request", message: "QUOTED REFUSED TEXT" } }), { status: 500 });
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "grant", baseUrl: "http://127.0.0.1:9/openai", api: "responses", effort: null, usage: emptyUsage(), fetchImpl });
  const refused = await chat({ model: "gpt-6.1-sol", messages: [], tools: [], timeoutMs: 30_000 }).then(() => null, (error) => error);
  assert.ok(refused instanceof ModelRefused);
  assert.equal(refused.category, "cyber_policy");
  assert.equal(refused.status, 500);
  assert.equal(refused.message, "Refused by the provider's safety classifier (category: cyber_policy).");
  assert.equal(String(refused.stack).includes("QUOTED"), false, "nothing of the provider's text is kept");
  assert.equal(calls, 1, "a refusal isn't retried");
});

test("no account to be had, every account at its limit, a server error, or no router: ModelUnavailable once the retries are spent", async () => {
  const cases: Array<[string, () => Response | never]> = [
    ["502", () => new Response(JSON.stringify({ error: { message: "Could not get a credential for the OpenAI request (No usable Codex pool credential), so nothing ran upstream, and sending it again is safe." } }), { status: 502 })],
    ["503", () => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 })],
    // Any server error that outlasts the retries is as passing as a 502, so the review resumes from it.
    ["500", () => new Response(JSON.stringify({ error: { message: "upstream error" } }), { status: 500 })],
    ["504", () => new Response("gateway timeout", { status: 504 })],
    ["429", () => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 })],
    ["quota", () => new Response(JSON.stringify({ error: { code: "usage_limit_reached", message: "The usage limit has been reached" } }), { status: 429 })],
    ["unreachable", () => { throw new TypeError("fetch failed"); }],
  ];
  for (const [name, answer] of cases) {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return answer(); }) as unknown as typeof fetch;
    const chat = createChat({ apiKey: "grant", baseUrl: "http://127.0.0.1:9/openai", api: "responses", effort: null, usage: emptyUsage(), fetchImpl });
    // A deadline 3 s off allows the first retry, after 1 s, and not the second, 4 s after that: 2 s of headroom for a
    // first call slowed by a loaded host.
    const error = await chat({ model: "gpt-6.1-sol", messages: [], tools: [], timeoutMs: 3_000 }).then(() => null, (thrown) => thrown);
    assert.ok(error instanceof ModelUnavailable, `${name}: ${error}`);
    assert.equal(calls, 2, `${name}: asked again once before giving up`);
  }
});

test("a request the API refuses for itself stays a ModelError, and isn't asked again", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "Unsupported parameter: temperature" } }), { status: 400 }); }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "grant", baseUrl: "http://127.0.0.1:9/openai", api: "responses", effort: null, usage: emptyUsage(), fetchImpl });
  const error = await chat({ model: "gpt-6.1-sol", messages: [], tools: [], timeoutMs: 30_000 }).then(() => null, (thrown) => thrown);
  assert.ok(error instanceof ModelError);
  assert.equal(error instanceof ModelUnavailable || error instanceof ModelRefused, false);
  assert.equal(error.status, 400);
  assert.equal(calls, 1);
});

test("the other two APIs keep their errors as they were: a chat 502 stays a ModelError", async () => {
  const fetchImpl = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "key", baseUrl: "https://example.test/v1", effort: null, usage: emptyUsage(), fetchImpl });
  const error = await chat({ model: "test/model", messages: [], tools: [], timeoutMs: 500 }).then(() => null, (thrown) => thrown);
  assert.ok(error instanceof ModelError);
  assert.equal(error instanceof ModelUnavailable, false);
});

test("chat completions replies carry their context size too", async () => {
  const chat = createChat({ apiKey: "key", baseUrl: "https://example.test/v1", effort: null, usage: emptyUsage(), fetchImpl: replying({ prompt_tokens: 100, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 4 } }) });
  const usage = emptyUsage();
  const counted = createChat({ apiKey: "key", baseUrl: "https://example.test/v1", effort: null, usage, fetchImpl: replying({ prompt_tokens: 100, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 4 } }) });
  assert.equal((await chat({ model: "test/model", messages: [], tools: [], timeoutMs: 5_000 })).contextTokens, 110);
  await counted({ model: "test/model", messages: [], tools: [], timeoutMs: 5_000 });
  assert.equal(usage.reasoningTokens, 4);
});

test("the Responses API's default transport is node:http, which waits for a slow answer and ends on the caller's signal", async () => {
  let slowArrived = false;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const slow = JSON.parse(body).model === "slow";
      slowArrived ||= slow;
      const delay = slow ? 60_000 : 300;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: `got ${request.url} with ${request.headers.authorization}` }] }] }));
      }, delay).unref();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  // Node's own fetch gives up on headers after five minutes, so the default mustn't be it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("the Responses API's default transport used fetch"); }) as typeof fetch;
  try {
    const chat = createChat({ apiKey: "grant", baseUrl: `http://127.0.0.1:${port}/openai`, api: "responses", effort: null, usage: emptyUsage() });
    const reply = await chat({ model: "gpt-6.1-sol", messages: [{ role: "user", content: "hi" }], tools: [], timeoutMs: 10_000 });
    assert.equal(reply.content, "got /openai/responses with Bearer grant");
    // A call past its time is cut off by its signal, and comes back as ModelUnavailable.
    const started = Date.now();
    const error = await chat({ model: "slow", messages: [], tools: [], timeoutMs: 1_200 }).then(() => null, (thrown) => thrown);
    assert.ok(error instanceof ModelUnavailable, String(error));
    assert.ok(slowArrived, "the slow request reached the server, so what ended it was the signal, not a failed connection");
    assert.ok(Date.now() - started < 30_000, "ended on the signal, not the server's minute");
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    server.close();
  }
  // longFetch keeps fetch's shape.
  assert.equal(typeof longFetch, "function");
});

test("a chat-completions request sends only the API's own message fields, not a reply's bookkeeping", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const chat = createChat({ apiKey: "key", baseUrl: "https://example.test/v1", effort: null, usage: emptyUsage(), fetchImpl: respondingWith(200, { choices: [{ message: { content: "ok" } }] }, seen) });
  await chat({ model: "m", tools: [], timeoutMs: 5_000, messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, contextTokens: 120, items: [{ type: "message" }], tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "1: one" },
  ] });
  assert.deepEqual(seen[0]!.body.messages, [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", content: "1: one", tool_call_id: "c1" },
  ]);
});

test("a task budget goes as output_config.task_budget with its beta, beside any configured beta", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const payload = { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 2 } };
  const chat = createChat({ apiKey: "grant", baseUrl: "http://127.0.0.1:9/anthropic", api: "anthropic", headers: { "anthropic-beta": "other-beta" }, effort: "max", usage: emptyUsage(), fetchImpl: respondingWith(200, payload, seen) });
  await chat({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }], tools: [], timeoutMs: 5_000, taskBudget: 90_000 });
  assert.deepEqual(seen[0]!.body.output_config, { effort: "max", task_budget: { type: "tokens", total: 90_000 } });
  assert.equal(seen[0]!.headers["anthropic-beta"], "other-beta,task-budgets-2026-03-13");
  await chat({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }], tools: [], timeoutMs: 5_000 });
  assert.equal("task_budget" in seen[1]!.body.output_config, false, "no budget asked, none sent");
  assert.equal(seen[1]!.headers["anthropic-beta"], "other-beta");
});

test("a Responses reply whose status is failed isn't taken as a turn", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response(JSON.stringify({ status: "failed", error: { code: "server_error" }, output: [] }), { status: 200 }); }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "grant", baseUrl: "http://127.0.0.1:9/openai", api: "responses", effort: null, usage: emptyUsage(), fetchImpl });
  const error = await chat({ model: "gpt-6.1-sol", messages: [], tools: [], timeoutMs: 1_500 }).then(() => null, (thrown) => thrown);
  assert.ok(error instanceof ModelUnavailable, String(error));
  assert.match(String(error), /failed response \(server_error\)/);
  assert.equal(calls, 2);
});

test("a message's refusal part goes back with it, and the errors name their classes", () => {
  const next = toResponses([{ role: "assistant", content: null, items: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }, { type: "output_text", text: "Here." }] }] }]);
  assert.deepEqual(next.input, [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }, { type: "output_text", text: "Here." }] }]);
  assert.deepEqual([new ModelError(400, "x").name, new ModelUnavailable(502, "x").name, new ModelRefused(500, "cyber_policy").name], ["ModelError", "ModelUnavailable", "ModelRefused"]);
});

test("a Responses reply that declines with no call is a refusal, a failed reply's code says whether to ask again, and a reply without usage carries no size", async () => {
  const ask = (fetchImpl: typeof fetch) => createChat({ apiKey: "k", baseUrl: "http://127.0.0.1:9/openai", api: "responses", effort: null, usage: emptyUsage(), fetchImpl })(
    { model: "sol", messages: [{ role: "user", content: "Go." }], tools: [READ], timeoutMs: 5_000 },
  );
  const declined = { id: "r", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "THE-MODELS-OWN-REFUSAL-WORDS" }] }] };
  await assert.rejects(ask(respondingWith(200, declined)), (error: unknown) => error instanceof ModelRefused && error.category === MODEL_REFUSAL && !error.message.includes("THE-MODELS-OWN-REFUSAL-WORDS"));
  const failed = (code: string) => ({ id: "r", status: "failed", error: { code }, output: [] });
  await assert.rejects(ask(respondingWith(200, failed("invalid_prompt"))), (error: unknown) => error instanceof ModelError && !(error instanceof ModelUnavailable) && error.status === 400, "a failure the request causes isn't asked again");
  await assert.rejects(ask(respondingWith(200, { id: "r", status: "failed", error: { code: "invalid_prompt" } })), (error: unknown) => error instanceof ModelError && !(error instanceof ModelUnavailable) && error.status === 400, "a failed reply with no output is classed by its code too");
  const reply = await ask(respondingWith(200, { id: "r", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] }] }));
  assert.equal(reply.contextTokens, undefined, "no usage, no size, so the loop measures the conversation itself");
  const empty = await ask(respondingWith(200, { id: "r", usage: {}, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] }] }));
  assert.equal(empty.contextTokens, undefined, "a usage with no counts is no size either");
});

test("a reply with an empty usage carries no size on every API, so the loop measures the conversation itself", async () => {
  const chatReply = await createChat({ apiKey: "key", baseUrl: "https://example.test/v1", effort: null, usage: emptyUsage(), fetchImpl: replying({}) })({ model: "test/model", messages: [], tools: [], timeoutMs: 5_000 });
  assert.equal(chatReply.contextTokens, undefined, "chat completions");
  const anthropicFetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }))) as unknown as typeof fetch;
  const anthropicReply = await createChat({ apiKey: "key", baseUrl: "https://example.test", api: "anthropic", effort: null, usage: emptyUsage(), fetchImpl: anthropicFetch })({ model: "claude", messages: [{ role: "user", content: "hi" }], tools: [], timeoutMs: 5_000 });
  assert.equal(anthropicReply.contextTokens, undefined, "Anthropic Messages");
});
