import assert from "node:assert/strict";
import { test } from "node:test";
import { createChat, emptyUsage, toAnthropic, type Usage } from "../src/llm.ts";

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

  assert.deepEqual(usage, { calls: 4, promptTokens: 400, completionTokens: 40, cachedTokens: 240, costUsd: 2 });
  assert.deepEqual(usageByCaller.get("s1"), { calls: 2, promptTokens: 200, completionTokens: 20, cachedTokens: 120, costUsd: 1 });
  assert.deepEqual(usageByCaller.get("verifier"), { calls: 1, promptTokens: 100, completionTokens: 10, cachedTokens: 60, costUsd: 0.5 });
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
    role: "assistant", content: "Reading it.",
    tool_calls: [{ id: "toolu_2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.ts\"}" } }],
    reasoning_details: [{ type: "thinking", thinking: "", signature: "sig" }],
  });
  assert.deepEqual(usage, { calls: 1, promptTokens: 95, completionTokens: 7, cachedTokens: 80, costUsd: 0 });
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

test("a reply that thought unasked keeps its thinking for the next request", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    content: [{ type: "thinking", thinking: "Unasked.", signature: "u1" }, { type: "text", text: "Done." }],
    usage: {},
  }))) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "grant", baseUrl: "https://example.test", api: "anthropic", effort: null, usage: emptyUsage(), fetchImpl });
  const reply = await chat({ model: "claude-test", tools: [], timeoutMs: 5_000, messages: [{ role: "user", content: "Review." }] });
  assert.deepEqual(reply.reasoning_details, [{ type: "thinking", thinking: "Unasked.", signature: "u1" }]);
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
