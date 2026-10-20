// A small chat-completions client for OpenRouter and other OpenAI-compatible endpoints.
import type { ToolDefinition } from "./tools.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Provider reasoning blocks, which some models need returned unchanged on the next turn. */
  reasoning_details?: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** A tool name forces that tool; otherwise the model chooses. */
  forceTool?: string;
  timeoutMs: number;
  /** Names who is asking, such as "s1" or "verifier", so usage can be totalled for each. */
  caller?: string;
  /** The longest one attempt may take, when shorter than ATTEMPT_TIMEOUT_MS. */
  attemptTimeoutMs?: number;
  /** Reasoning effort for this call, in place of the client's. */
  effort?: string;
  /** The most tokens the model may reason for on this call; takes the place of the effort. OpenRouter only. */
  reasoningTokens?: number;
  /** Asks OpenRouter to route to the provider with the lowest latency or highest throughput. */
  providerSort?: "latency" | "throughput";
}

export type Chat = (request: ChatRequest) => Promise<ChatMessage>;

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export function emptyUsage(): Usage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 };
}

export class ModelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const RETRY_DELAYS_MS = [1_000, 4_000, 10_000];
/** The longest one attempt may take. A call that stalls is cut off here and retried while the caller's time allows. */
const ATTEMPT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 16_000;

function retryable(error: unknown): boolean {
  if (error instanceof ModelError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return true; // network failures and timeouts
}

/**
 * The API the endpoint speaks: OpenAI-compatible chat completions at `<baseUrl>/chat/completions`,
 * or Anthropic Messages at `<baseUrl>/v1/messages`, as Anthropic's own SDKs join them.
 */
export type ModelApi = "chat" | "anthropic";

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  /** "chat" when left out. */
  api?: ModelApi;
  /** Sent with every request, such as a gateway's own routing or accounting headers. */
  headers?: Record<string, string>;
  effort: string | null;
  usage: Usage;
  /** Filled with the usage of each caller that names itself in its requests. */
  usageByCaller?: Map<string, Usage>;
  fetchImpl?: typeof fetch;
}

export function createChat(options: ClientOptions): Chat {
  const fetchImpl = options.fetchImpl ?? fetch;
  const openRouter = new URL(options.baseUrl).hostname.endsWith("openrouter.ai");

  async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { ...options.headers, ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new ModelError(response.status, `model API returned ${response.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new ModelError(502, "model API returned a body that is not JSON");
    }
  }

  function count(request: ChatRequest, add: Omit<Usage, "calls">): void {
    const totals = [options.usage];
    if (request.caller && options.usageByCaller) {
      if (!options.usageByCaller.has(request.caller)) options.usageByCaller.set(request.caller, emptyUsage());
      totals.push(options.usageByCaller.get(request.caller)!);
    }
    for (const usage of totals) {
      usage.calls += 1;
      usage.promptTokens += add.promptTokens;
      usage.completionTokens += add.completionTokens;
      usage.cachedTokens += add.cachedTokens;
      usage.costUsd += add.costUsd;
    }
  }

  async function completions(request: ChatRequest, timeoutMs: number): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.forceTool ? { type: "function", function: { name: request.forceTool } } : "auto",
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (openRouter) body.usage = { include: true };
    if (openRouter && request.providerSort) body.provider = { sort: request.providerSort };
    // Anthropic models cache a prompt prefix only when asked to. A review resends a
    // growing conversation every turn, so caching decides most of its cost.
    if (openRouter && request.model.startsWith("anthropic/")) body.cache_control = { type: "ephemeral" };
    const effort = request.effort ?? options.effort;
    if (openRouter && request.reasoningTokens) body.reasoning = { max_tokens: request.reasoningTokens };
    else if (effort) {
      if (openRouter) body.reasoning = { effort };
      else body.reasoning_effort = effort;
    }
    const payload = await post(`${options.baseUrl}/chat/completions`, { authorization: `Bearer ${options.apiKey}`, "x-title": "rev-engine-prime" }, body, timeoutMs);
    // OpenRouter reports some upstream failures inside a 200 response.
    if (payload?.error) {
      const status = Number(payload.error.code) || 502;
      throw new ModelError(status, `model API error ${status}: ${String(payload.error.message).slice(0, 300)}`);
    }
    const message = payload?.choices?.[0]?.message;
    if (!message) throw new ModelError(502, "model API returned no message");

    count(request, {
      promptTokens: Number(payload.usage?.prompt_tokens) || 0,
      completionTokens: Number(payload.usage?.completion_tokens) || 0,
      cachedTokens: Number(payload.usage?.prompt_tokens_details?.cached_tokens) || 0,
      costUsd: Number(payload.usage?.cost) || 0,
    });

    const result: ChatMessage = { role: "assistant", content: typeof message.content === "string" ? message.content : null };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      result.tool_calls = message.tool_calls.map((call: any, index: number): ToolCall => ({
        id: String(call.id ?? `call_${index}`),
        type: "function",
        function: { name: String(call.function?.name ?? ""), arguments: String(call.function?.arguments ?? "") },
      }));
    }
    if (message.reasoning_details) result.reasoning_details = message.reasoning_details;
    return result;
  }

  // Models that refused a forced tool choice. Their forced calls let the model choose instead.
  const unforced = new Set<string>();

  async function messages(request: ChatRequest, timeoutMs: number): Promise<ChatMessage> {
    const effort = request.effort ?? options.effort;
    const force = request.forceTool && !unforced.has(request.model) ? request.forceTool : null;
    // A forced tool choice can't be combined with thinking, so a forced call doesn't think.
    const thinking = Boolean(effort) && !force;
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...toAnthropic(request.messages, thinking),
      tools: request.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })),
      tool_choice: force ? { type: "tool", name: force } : { type: "auto" },
    };
    if (thinking) body.thinking = { type: "adaptive" };
    if (effort) body.output_config = { effort };
    let payload: any;
    try {
      payload = await post(`${options.baseUrl}/v1/messages`, { "x-api-key": options.apiKey, "anthropic-version": ANTHROPIC_VERSION }, body, timeoutMs);
    } catch (error) {
      if (!force || !(error instanceof ModelError) || error.status !== 400 || !error.message.includes("tool_choice")) throw error;
      unforced.add(request.model);
      return messages(request, timeoutMs);
    }
    if (!Array.isArray(payload?.content)) throw new ModelError(502, "model API returned no content");

    const usage = payload.usage ?? {};
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    count(request, {
      promptTokens: (Number(usage.input_tokens) || 0) + cacheRead + (Number(usage.cache_creation_input_tokens) || 0),
      completionTokens: Number(usage.output_tokens) || 0,
      cachedTokens: cacheRead,
      // The Messages API reports tokens, not money.
      costUsd: 0,
    });

    const blocks = payload.content as Array<Record<string, any>>;
    const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
    const result: ChatMessage = { role: "assistant", content: text || null };
    const calls = blocks.filter((block) => block.type === "tool_use");
    if (calls.length) {
      result.tool_calls = calls.map((block): ToolCall => ({
        id: String(block.id),
        type: "function",
        function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
      }));
    }
    // Thinking goes back unchanged on the next turn, which a tool loop with thinking requires.
    const reasoning = blocks.filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
    if (reasoning.length) result.reasoning_details = reasoning;
    return result;
  }

  const once = options.api === "anthropic" ? messages : completions;

  return async function chat(request: ChatRequest): Promise<ChatMessage> {
    const deadline = Date.now() + request.timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(request, Math.max(1_000, Math.min(request.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS, deadline - Date.now())));
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !retryable(error) || Date.now() + delay >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
}

const ANTHROPIC_VERSION = "2023-06-01";

type AnthropicBlock = Record<string, unknown>;

/**
 * Turns a chat-completions conversation into an Anthropic Messages `system` and `messages`.
 * System messages become the system prompt. Tool results become `tool_result` blocks in a user
 * turn, and turns of one role in a row are joined, since the API alternates roles. Thinking
 * blocks a reply carried go back first in its turn, and are left out of a call that doesn't think.
 * The last block is marked for caching, so each turn reads the conversation so far from the cache.
 */
export function toAnthropic(messages: ChatMessage[], thinking: boolean): { system?: string; messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> } {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content ?? "").filter(Boolean).join("\n\n");
  const turns: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  const add = (role: "user" | "assistant", blocks: AnthropicBlock[]): void => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "user") add("user", message.content ? [{ type: "text", text: message.content }] : []);
    else if (message.role === "tool") add("user", [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content ?? "" }]);
    else if (message.role === "assistant") {
      const reasoning = thinking && Array.isArray(message.reasoning_details) ? (message.reasoning_details as AnthropicBlock[]) : [];
      add("assistant", [
        ...reasoning,
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.function.name, input: parseInput(call.function.arguments) })),
      ]);
    }
  }
  const last = turns.at(-1)?.content.at(-1);
  if (last && last.type !== "thinking" && last.type !== "redacted_thinking") last.cache_control = { type: "ephemeral" };
  return { ...(system ? { system } : {}), messages: turns };
}

/** A tool call's arguments as the object the Messages API wants; text that isn't an object is kept under `input`. */
function parseInput(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return { input: text };
}
