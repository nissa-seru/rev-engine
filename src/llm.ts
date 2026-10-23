// A small model client: OpenAI-compatible chat completions (OpenRouter and the like), Anthropic
// Messages, and OpenAI Responses as a gateway serves it, such as at `/openai/responses`.
import http from "node:http";
import https from "node:https";
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
  /**
   * A Responses reply's whole `output`, its reasoning items among them, which goes back as this turn
   * on the next request, each item in the form input takes (asInput). Set only by the Responses API.
   */
  items?: unknown[];
  /**
   * On a reply: the call's whole context, its input (cached and cache-written included) plus its
   * output, in tokens, as the provider counted them. A loop bounds a conversation by it. Left out
   * when the reply reports no usage, so the loop measures the conversation another way.
   */
  contextTokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /**
   * A tool name forces that tool; otherwise the model chooses. On Anthropic Messages, a call
   * that thinks, or a model that refuses a forced choice, is left to choose, so a prompt that
   * forces a tool should also ask for it in words.
   */
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
  /**
   * A countdown of the conversation's context, in tokens, which the model is shown on every call so it
   * can finish before it runs out (Anthropic's task budget). Anthropic Messages only.
   */
  taskBudget?: number;
  /**
   * Names the conversation, sent as `x-orca-conversation`, so a gateway that reads it keeps one upstream socket for it
   * and with it the prompt cache. One per tool loop. Responses only.
   */
  conversation?: string;
}

export type Chat = (request: ChatRequest) => Promise<ChatMessage>;

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Of the completion tokens, those the model reasoned with, where the API reports them. */
  reasoningTokens: number;
  costUsd: number;
}

export function emptyUsage(): Usage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

export class ModelError extends Error {
  override name = "ModelError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The model can't be reached now, after the retries: no account could take the call, or every
 * one is at its limit. Asking again later can succeed, so a review stops and resumes once the
 * model serves. Responses only.
 */
export class ModelUnavailable extends ModelError {
  override name = "ModelUnavailable";
}

/**
 * The call was refused: by the provider's safety classifier, by its category, or by the model itself
 * declining the turn (MODEL_REFUSAL). It isn't retried, since the same content is likely refused again.
 * The message names the category alone: the explanation can quote what was refused, which may stop
 * whoever reads it, so nothing of it is kept. Responses only.
 */
export class ModelRefused extends ModelError {
  override name = "ModelRefused";
  readonly category: string;
  constructor(status: number, category: string) {
    super(status, category === MODEL_REFUSAL ? "The model declined the turn." : `Refused by the provider's safety classifier (category: ${category}).`);
    this.category = category;
  }
}

/** The codes OpenAI's safety classifiers refuse with, which a gateway may relay with any status (often 500). */
const CLASSIFIER_REFUSALS = ["cyber_policy", "bio_policy"];
/** The category of a turn the model itself declined, with a refusal in place of an answer. */
export const MODEL_REFUSAL = "model_refusal";
/** The codes an OpenAI account at its limit answers with. A gateway with several accounts may try the others before passing one on. */
const QUOTA_CODES = ["usage_limit_reached", "usage_not_included", "insufficient_quota"];

const RETRY_DELAYS_MS = [1_000, 4_000, 10_000];
/** The longest one attempt may take. A call that stalls is cut off here and retried while the caller's time allows. */
const ATTEMPT_TIMEOUT_MS = 180_000;
/**
 * The longest one Responses attempt may take. A gateway that doesn't stream answers only once the whole turn is in, and a
 * Sol turn at xhigh took 3 to 5 minutes under load, so ATTEMPT_TIMEOUT_MS would cut most of them
 * off and send them again.
 */
const RESPONSES_ATTEMPT_TIMEOUT_MS = 1_200_000;
const MAX_OUTPUT_TOKENS = 16_000;

function retryable(error: unknown): boolean {
  if (error instanceof ModelRefused) return false;
  if (error instanceof ModelError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return true; // network failures and timeouts
}

/**
 * The API the endpoint speaks: OpenAI-compatible chat completions at `<baseUrl>/chat/completions`,
 * Anthropic Messages at `<baseUrl>/v1/messages`, as Anthropic's own SDKs join them, or OpenAI
 * Responses at `<baseUrl>/responses`, as a gateway may serve it under `/openai`.
 */
export type ModelApi = "chat" | "anthropic" | "responses";

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  /** "chat" when left out. */
  api?: ModelApi;
  /** Sent with every request, such as a gateway's own routing or accounting headers (such as `x-orca-class` and `x-caller-tag`). */
  headers?: Record<string, string>;
  effort: string | null;
  usage: Usage;
  /** Filled with the usage of each caller that names itself in its requests. */
  usageByCaller?: Map<string, Usage>;
  /** In place of fetch; tests pass one. The Responses API's default is longFetch, below. */
  fetchImpl?: typeof fetch;
}

export function createChat(options: ClientOptions): Chat {
  const fetchImpl = options.fetchImpl ?? (options.api === "responses" ? longFetch : fetch);
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
      usage.reasoningTokens += add.reasoningTokens;
      usage.costUsd += add.costUsd;
    }
  }

  async function completions(request: ChatRequest, timeoutMs: number): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: request.model,
      // Only the API's own fields: a reply carries local bookkeeping (contextTokens, items) a strict endpoint refuses.
      messages: request.messages.map(({ role, content, tool_calls, tool_call_id, reasoning_details }) => ({
        role, content, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}), ...(reasoning_details ? { reasoning_details } : {}),
      })),
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

    const promptTokens = Number(payload.usage?.prompt_tokens) || 0;
    const completionTokens = Number(payload.usage?.completion_tokens) || 0;
    count(request, {
      promptTokens,
      completionTokens,
      cachedTokens: Number(payload.usage?.prompt_tokens_details?.cached_tokens) || 0,
      reasoningTokens: Number(payload.usage?.completion_tokens_details?.reasoning_tokens) || 0,
      costUsd: Number(payload.usage?.cost) || 0,
    });

    const result: ChatMessage = { role: "assistant", content: typeof message.content === "string" ? message.content : null, ...(promptTokens + completionTokens > 0 ? { contextTokens: promptTokens + completionTokens } : {}) };
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

  /** The anthropic-beta header a request needs, beside any the client was configured with. */
  function betas(request: ChatRequest): Record<string, string> {
    if (!request.taskBudget) return {};
    const given = options.headers?.["anthropic-beta"];
    return { "anthropic-beta": [given, TASK_BUDGETS_BETA].filter(Boolean).join(",") };
  }

  // Models that refused a forced tool choice. Their forced calls let the model choose instead.
  const unforced = new Set<string>();

  async function messages(request: ChatRequest, timeoutMs: number, refused = false): Promise<ChatMessage> {
    const started = Date.now();
    const effort = request.effort ?? options.effort;
    // The API allows thinking or a forced tool choice, not both. A call with an effort set thinks
    // and leaves the tool to the model, whose prompt asks for it in words.
    const thinking = Boolean(effort);
    const force = request.forceTool && !thinking && !refused && !unforced.has(request.model) ? request.forceTool : null;
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...toAnthropic(request.messages),
      tools: request.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })),
      tool_choice: force ? { type: "tool", name: force } : { type: "auto" },
    };
    if (thinking) body.thinking = { type: "adaptive" };
    if (effort) body.output_config = { effort };
    // The countdown a request with a task budget shows the model: the same total on every request.
    if (request.taskBudget) body.output_config = { ...(body.output_config as object | undefined), task_budget: { type: "tokens", total: request.taskBudget } };
    let payload: any;
    try {
      payload = await post(`${options.baseUrl}/v1/messages`, { "x-api-key": options.apiKey, "anthropic-version": ANTHROPIC_VERSION, ...betas(request) }, body, timeoutMs);
    } catch (error) {
      if (!force || !(error instanceof ModelError) || error.status !== 400 || !/tool_choice.*not supported/s.test(error.message)) throw error;
      unforced.add(request.model);
      return messages(request, Math.max(1_000, timeoutMs - (Date.now() - started)), true);
    }
    if (!Array.isArray(payload?.content)) throw new ModelError(502, "model API returned no content");

    const usage = payload.usage ?? {};
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const promptTokens = (Number(usage.input_tokens) || 0) + cacheRead + (Number(usage.cache_creation_input_tokens) || 0);
    const completionTokens = Number(usage.output_tokens) || 0;
    count(request, {
      promptTokens,
      completionTokens,
      cachedTokens: cacheRead,
      // The Messages API doesn't count thinking apart from the rest of the output.
      reasoningTokens: 0,
      // The Messages API reports tokens, not money.
      costUsd: 0,
    });

    const blocks = payload.content as Array<Record<string, any>>;
    const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
    const result: ChatMessage = { role: "assistant", content: text || null, ...(promptTokens + completionTokens > 0 ? { contextTokens: promptTokens + completionTokens } : {}) };
    const calls = blocks.filter((block) => block.type === "tool_use");
    if (calls.length) {
      result.tool_calls = calls.map((block): ToolCall => ({
        id: String(block.id),
        type: "function",
        function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
      }));
    }
    // Thinking goes back unchanged on later turns, which a tool loop with thinking requires.
    // A model may think when the request doesn't ask it to, so this holds whatever the effort.
    const reasoning = blocks.filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
    if (reasoning.length) result.reasoning_details = reasoning;
    return result;
  }

  async function responses(request: ChatRequest, timeoutMs: number): Promise<ChatMessage> {
    const effort = request.effort ?? options.effort;
    const body: Record<string, unknown> = {
      model: request.model,
      ...toResponses(request.messages),
      tools: request.tools.map((tool) => ({
        type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters,
        // Responses makes a function tool strict unless told otherwise, which a submit schema with
        // optional fields fails; the other two APIs don't enforce schemas either.
        strict: false,
      })),
      tool_choice: request.forceTool ? { type: "function", name: request.forceTool } : "auto",
      // The gateway this serves refuses any other `store` and a `max_output_tokens`, and passes `include`
      // on as given: reasoning comes back encrypted, to go back whole on the next turn.
      store: false,
      include: ["reasoning.encrypted_content"],
    };
    if (effort) body.reasoning = { effort };
    const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}` };
    if (request.conversation) headers["x-orca-conversation"] = request.conversation;
    const response = await fetchImpl(`${options.baseUrl}/responses`, {
      method: "POST",
      headers: { ...options.headers, ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // judged below
    }
    const code = typeof payload?.error?.code === "string" ? payload.error.code : null;
    if (code && CLASSIFIER_REFUSALS.includes(code)) throw new ModelRefused(response.status, code);
    if (!response.ok) {
      // A refusal's text is never kept (above); any other error is the router's or the provider's own words.
      throw new ModelError(response.status, `model API returned ${response.status}${code ? ` (${code})` : ""}: ${text.slice(0, 300)}`);
    }
    // A response can answer 200 and still say it failed, with or without output; it is then no turn to carry on from.
    // Its code says whether asking again can help: a server error or a rate limit can pass, and anything else the
    // request caused.
    if (payload?.status === "failed") {
      const failed = typeof payload.error?.code === "string" ? payload.error.code : "";
      const status = failed === "rate_limit_exceeded" ? 429 : !failed || failed === "server_error" ? 502 : 400;
      throw new ModelError(status, `model API returned a failed response${failed ? ` (${failed})` : ""}`);
    }
    if (!payload || !Array.isArray(payload.output)) throw new ModelError(502, "model API returned no output");

    const usage = payload.usage ?? {};
    const promptTokens = Number(usage.input_tokens) || 0;
    const completionTokens = Number(usage.output_tokens) || 0;
    count(request, {
      promptTokens,
      completionTokens,
      cachedTokens: Number(usage.input_tokens_details?.cached_tokens) || 0,
      reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens) || 0,
      costUsd: 0,
    });

    const items = payload.output as Array<Record<string, any>>;
    const said = items
      .filter((item) => item?.type === "message")
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((part: any) => part?.type === "output_text")
      .map((part: any) => String(part.text ?? ""))
      .join("");
    const result: ChatMessage = { role: "assistant", content: said || null, items, ...(promptTokens + completionTokens > 0 ? { contextTokens: promptTokens + completionTokens } : {}) };
    // A model that declines in words, with no call, has refused the turn: asking it to continue gets the same.
    const refused = items.some((item) => item?.type === "message" && Array.isArray(item.content) && item.content.some((part: any) => part?.type === "refusal"));
    if (refused && !items.some((item) => item?.type === "function_call")) throw new ModelRefused(response.status, MODEL_REFUSAL);
    const calls = items.filter((item) => item?.type === "function_call");
    if (calls.length) {
      result.tool_calls = calls.map((item): ToolCall => ({
        id: String(item.call_id ?? ""),
        type: "function",
        function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "") },
      }));
    }
    return result;
  }

  const once = options.api === "anthropic" ? messages : options.api === "responses" ? responses : completions;
  const longest = options.api === "responses" ? RESPONSES_ATTEMPT_TIMEOUT_MS : ATTEMPT_TIMEOUT_MS;

  return async function chat(request: ChatRequest): Promise<ChatMessage> {
    const deadline = Date.now() + request.timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(request, Math.max(1_000, Math.min(request.attemptTimeoutMs ?? longest, longest, deadline - Date.now())));
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !retryable(error) || Date.now() + delay >= deadline) throw unavailable(error);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  /**
   * What a Responses call that can't go on throws: once the retries are spent, every failure retryable()
   * retries is ModelUnavailable, which a review resumes from: a server error (500 and above, failed
   * replies with a server error among them), a timeout (408), a rate limit or every account at its limit
   * (429, the quota codes), or the router not answering. A refusal, and any other error, such as a 400 for
   * the request itself, stand as thrown. The other two APIs keep their errors.
   */
  function unavailable(error: unknown): unknown {
    if (options.api !== "responses" || error instanceof ModelRefused) return error;
    // A network failure or an attempt that ran out of time is as passing as an account that couldn't be had.
    if (!(error instanceof ModelError)) return new ModelUnavailable(502, `model API could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    // Every server error that outlasts the retries is as passing as one retryable() already treats it as.
    const quota = QUOTA_CODES.some((code) => error.message.includes(`(${code})`));
    if (error.status >= 500 || error.status === 429 || error.status === 408 || quota) return new ModelUnavailable(error.status, error.message);
    return error;
  }
}

const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic's feature flag for `output_config.task_budget`. */
const TASK_BUDGETS_BETA = "task-budgets-2026-03-13";

type AnthropicBlock = Record<string, unknown>;

/**
 * Turns a chat-completions conversation into an Anthropic Messages `system` and `messages`.
 * System messages become the system prompt. Tool results become `tool_result` blocks in a user
 * turn, and turns of one role in a row are joined, since the API alternates roles. Anthropic
 * thinking blocks a reply carried go back first in its turn, whether or not this call thinks.
 * The last block is marked for caching, so each turn reads the conversation so far from the cache.
 */
export function toAnthropic(messages: ChatMessage[]): { system?: string; messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> } {
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
      // Only Anthropic's own thinking blocks go back: a recorded conversation may carry another provider's reasoning.
      const reasoning = Array.isArray(message.reasoning_details)
        ? (message.reasoning_details as AnthropicBlock[]).filter((block) => block?.type === "thinking" || block?.type === "redacted_thinking")
        : [];
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

type ResponsesItem = Record<string, unknown>;

/**
 * An output item as the next request's input takes it. A function call comes back with fields the API adds
 * for the caller, such as `parsed_arguments`, which it refuses as input ("Unknown parameter"), so a call goes
 * back as its call alone, and a message as its role and text. A reasoning item goes back whole, its encrypted
 * content included, and any other item as it came.
 */
function asInput(item: ResponsesItem): ResponsesItem {
  if (item?.type === "function_call") {
    const { type, id, call_id, name, arguments: args } = item;
    return { type, ...(id === undefined ? {} : { id }), call_id, name, arguments: args };
  }
  // A message goes back as its role and its text, the form input documents for an earlier assistant turn.
  if (item?.type === "message") {
    const parts = Array.isArray(item.content) ? item.content as ResponsesItem[] : [];
    return {
      type: "message", role: item.role,
      content: parts.flatMap((part): ResponsesItem[] => part?.type === "output_text" ? [{ type: "output_text", text: String(part.text ?? "") }]
        : part?.type === "refusal" ? [{ type: "refusal", refusal: String(part.refusal ?? "") }] : []),
    };
  }
  return item;
}

/**
 * Turns a chat-completions conversation into a Responses `instructions` and `input`. System
 * messages become the instructions. An assistant turn that came from Responses goes back as its
 * output items in the form input takes (asInput), its reasoning items whole with their encrypted
 * content, which a tool loop with reasoning needs; any other assistant turn becomes its text and its calls. A tool result
 * becomes a `function_call_output` for its call.
 */
export function toResponses(messages: ChatMessage[]): { instructions: string; input: ResponsesItem[] } {
  const instructions = messages.filter((message) => message.role === "system").map((message) => message.content ?? "").filter(Boolean).join("\n\n");
  const input: ResponsesItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (message.content) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: message.content }] });
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id ?? "", output: message.content ?? "" });
    } else if (message.role === "assistant") {
      if (Array.isArray(message.items) && message.items.length) {
        input.push(...(message.items as ResponsesItem[]).map(asInput));
        continue;
      }
      if (message.content) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content }] });
      for (const call of message.tool_calls ?? []) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return { instructions, input };
}

/**
 * fetch's shape over node:http, for calls that answer after more than five minutes: Node's own
 * fetch gives up on a response whose headers take longer than that (undici's headersTimeout), and a
 * Sol turn through a gateway that doesn't stream sends nothing until it is whole. It sets no timeout of its own; the caller's
 * signal ends it.
 */
export const longFetch = (async (url: string | URL, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) => {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  const body = init.body ?? "";
  return await new Promise<Response>((resolve, reject) => {
    const request = client.request(target, {
      method: init.method ?? "GET",
      headers: { ...init.headers, "content-length": String(Buffer.byteLength(body)) },
      signal: init.signal,
    }, (reply) => {
      const chunks: Buffer[] = [];
      reply.on("data", (chunk: Buffer) => chunks.push(chunk));
      reply.on("error", reject);
      reply.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: reply.statusCode ?? 502, statusText: reply.statusMessage ?? "" })));
    });
    request.on("error", reject);
    request.end(body);
  });
}) as unknown as typeof fetch;
