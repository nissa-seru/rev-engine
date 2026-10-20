import assert from "node:assert/strict";
import { test } from "node:test";
import { createChat, emptyUsage, type Usage } from "../src/llm.ts";

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

test("speaks Anthropic Messages: system, tools, tool results, caching, and the reply as a chat message", async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
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

  const { url, headers, body } = requests[0]!;
  assert.equal(url, "http://127.0.0.1:9/anthropic/v1/messages");
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

test("a forced tool call to Anthropic Messages doesn't think, and leaves earlier thinking out", async () => {
  const bodies: Array<Record<string, any>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "toolu_9", name: "submit", input: {} }], usage: {} }));
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "grant", baseUrl: "https://example.test", api: "anthropic", effort: "high", usage: emptyUsage(), fetchImpl });
  await chat({
    model: "claude-test", tools: [], timeoutMs: 5_000, forceTool: "submit",
    messages: [
      { role: "user", content: "Review." },
      { role: "assistant", content: "Done reading.", reasoning_details: [{ type: "thinking", thinking: "", signature: "s1" }] },
      { role: "user", content: "Submit now." },
    ],
  });
  assert.deepEqual(bodies[0]!.tool_choice, { type: "tool", name: "submit" });
  assert.equal(bodies[0]!.thinking, undefined);
  assert.deepEqual(bodies[0]!.output_config, { effort: "high" });
  assert.deepEqual(bodies[0]!.messages[1], { role: "assistant", content: [{ type: "text", text: "Done reading." }] });
});

test("a model that refuses a forced tool choice is asked again, and from then on, with the choice left to it", async () => {
  const choices: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    choices.push(body.tool_choice);
    if (body.tool_choice.type === "tool") {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "tool_choice: type \"tool\" and \"any\" are not supported for this model." } }), { status: 400 });
    }
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "toolu_1", name: "submit", input: {} }], usage: {} }));
  }) as unknown as typeof fetch;
  const chat = createChat({ apiKey: "grant", baseUrl: "https://example.test", api: "anthropic", effort: null, usage: emptyUsage(), fetchImpl });
  const request = { model: "claude-test", tools: [], timeoutMs: 5_000, forceTool: "submit", messages: [{ role: "user" as const, content: "Submit." }] };
  const reply = await chat(request);
  await chat(request);
  assert.equal(reply.tool_calls?.[0]?.function.name, "submit");
  assert.deepEqual(choices, [{ type: "tool", name: "submit" }, { type: "auto" }, { type: "auto" }]);
});
