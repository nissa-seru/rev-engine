// The tool loop: a model inspects the pull request with read tools, then
// hands back its result by calling a submit tool.
//
// Using a tool for the final answer works with any model that can call tools,
// and the arguments are checked as JSON before the loop accepts them.
import { ModelError, ModelRefused, ModelUnavailable, told, type Chat, type ChatMessage, type ToolCall } from "./llm.ts";
import { readTools, type ToolDefinition, type Workspace } from "./tools.ts";

/**
 * Time kept back at the end for the model to write its submission. Ordinary
 * turns may not run into it, so one slow call cannot use up the whole deadline.
 */
const WRAP_UP_MS = 100_000;
/** Conversation size, in characters, past which the model is told to submit. Bounds the cost of every later turn. */
const MAX_CONTEXT_CHARS = 800_000;
/** Characters per token, low, for a conversation whose replies don't report their size against a token bound. */
const CHARS_PER_TOKEN = 3;

/**
 * Requests to look again after the first submission, one per round, and how to join
 * the submissions. message(1) answers the first submission; null ends the review.
 */
export interface SecondLook {
  message: (round: number) => string | null;
  combine: (submissions: Array<Record<string, unknown>>) => Record<string, unknown>;
}

export interface AgentOptions {
  chat: Chat;
  model: string;
  system: string;
  prompt: string;
  workspace: Workspace;
  /** The tools offered beside the submit tool: the read tools when left out, [] for a call that only answers. */
  tools?: ToolDefinition[];
  submit: ToolDefinition;
  /** Epoch milliseconds by which the submission must be in. */
  deadline: number;
  maxTurns: number;
  /** When set, each submission is answered with the next request, and the model submits again. */
  secondLook?: SecondLook;
  /** Names this run in the usage totals and the log, such as "s1" or "verifier". */
  caller?: string;
  /** Reasoning effort for every call of this run, in place of the client's. */
  effort?: string;
  /**
   * The context size, in tokens as the client reports each reply's, at which the model is made to hand in what it has.
   * When set, it takes the place of the character bound.
   */
  contextBound?: number;
  /** Set when the run handed in because it reached contextBound. */
  report?: { bounded: boolean };
  /** One id for every call of this run, so a gateway keeps the run's prompt cache together. */
  conversation?: string;
  /** The context, in tokens, that the model is shown counting down on every call (Anthropic Messages' task budget). */
  taskBudget?: number;
  /**
   * What a turn that fails after the client's retries does: ask for the submission (the default), or end the run with
   * the error, for a review that keeps its answers and asks again later rather than take a partial one.
   */
  onFailedTurn?: "submit" | "throw";
  /** Cuts off one model call sooner than the client's default, so a stalled call is retried sooner. */
  attemptTimeoutMs?: number;
  /** Time kept back for the submission, when a short deadline needs less than WRAP_UP_MS. */
  wrapUpMs?: number;
  /**
   * Requests a model may take once it has been asked to hand in, reading nothing more, before the run ends without
   * its submission. A model that thinks can't be forced to the submit tool on every API, so with no other limit it
   * could read on past its bound. Left out, as the reader leaves it (as on main): reads are still answered, and maxTurns ends the run.
   */
  handInTurns?: number;
  log: (message: string) => void;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Some models answer in prose with a JSON block instead of calling the submit tool. */
function objectFromText(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    const value = candidate ? parseObject(candidate) : null;
    if (value) return value;
  }
  return null;
}

/**
 * The complete entries of a submission whose JSON was cut off, usually by the
 * output limit or the deadline: {"findings":[{...},{...},{"file":"a  gives the
 * first two. Null when no entry is complete.
 */
export function completeEntries(text: string): Record<string, unknown> | null {
  const list = /"([A-Za-z_]\w*)"\s*:\s*\[/.exec(text);
  if (!list) return null;
  const entries: unknown[] = [];
  let at = list.index + list[0].length;
  for (;;) {
    while (at < text.length && /[\s,]/.test(text[at]!)) at += 1;
    if (text[at] !== "{") break;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let index = at; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === "\\") index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && (depth -= 1) === 0) { end = index; break; }
    }
    const entry = end < 0 ? null : parseObject(text.slice(at, end + 1));
    if (!entry) break;
    entries.push(entry);
    at = end + 1;
  }
  return entries.length ? { [list[1]!]: entries } : null;
}

/** What the model has handed in so far: whole submissions, and the complete entries of one that was cut off. */
interface Held {
  submissions: Array<Record<string, unknown>>;
  partial: Record<string, unknown> | null;
}

export async function runAgent(options: AgentOptions): Promise<Record<string, unknown>> {
  // What was handed in is kept, so a failure later on still returns that work.
  const held: Held = { submissions: [], partial: null };
  try {
    return await loop(options, held);
  } catch (error) {
    // A run that ends with its error keeps nothing partial: the review asks it again later, whole. A refusal or a
    // model that can't be reached stops the review whatever was held, as the loop rethrows them.
    if (options.onFailedTurn === "throw" || error instanceof ModelRefused || error instanceof ModelUnavailable) throw error;
    if (held.submissions.length && options.secondLook) {
      options.log(`${options.caller ?? options.model}: second look failed, keeping the submissions so far: ${told(error)}`);
      return options.secondLook.combine(held.partial ? [...held.submissions, held.partial] : held.submissions);
    }
    if (!held.partial) throw error;
    options.log(`${options.caller ?? options.model}: failed after a cut-off submission, keeping its complete entries: ${told(error)}`);
    return held.partial;
  }
}

async function loop(options: AgentOptions, held: Held): Promise<Record<string, unknown>> {
  const { chat, model, workspace, submit, deadline, maxTurns, secondLook, log } = options;
  // Several runs can share one model, so the log names the caller when there is one.
  const who = options.caller ?? model;
  const wrapUpMs = options.wrapUpMs ?? WRAP_UP_MS;
  const started = Date.now();
  const submitName = submit.function.name;
  const tools = [...(options.tools ?? readTools), submit];
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.prompt },
  ];
  let wrappingUp = false;
  let forcedChoiceWorks = true;
  /** The context size of the reply that passed contextBound, or 0 while none has. */
  let pastBound = 0;
  let wrapUpTurns = 0;
  let contextChars = options.system.length + options.prompt.length;
  const push = (message: ChatMessage): void => {
    messages.push(message);
    contextChars += (message.content?.length ?? 0) + (message.tool_calls ?? []).reduce((sum, call) => sum + call.function.arguments.length, 0);
  };
  const wrapUp = (): void => {
    wrappingUp = true;
    push({ role: "user", content: `Stop investigating. Call ${submitName} now with what you have established so far.` });
  };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${model} ran out of time before submitting`);
    if (!wrappingUp && pastBound) {
      if (options.report) options.report.bounded = true;
      log(`${who}: its context reached ${pastBound} tokens, past its bound of ${options.contextBound}; asking for the submission`);
    }
    if (!wrappingUp && (turn === maxTurns || remaining <= wrapUpMs || pastBound || (!options.contextBound && contextChars > MAX_CONTEXT_CHARS))) wrapUp();
    // Every request made once the ask is in counts, the one that carries it included, whichever way the ask came.
    if (wrappingUp && options.handInTurns && ++wrapUpTurns > options.handInTurns) throw new Error(`${model} did not submit in the ${options.handInTurns} turns after it was asked to`);

    // An ordinary turn must leave the wrap-up window untouched; the wrap-up turn gets all that is left.
    const request = {
      model, messages, tools, timeoutMs: wrappingUp ? remaining : remaining - wrapUpMs,
      ...(options.caller ? { caller: options.caller } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.conversation ? { conversation: options.conversation } : {}),
      ...(options.taskBudget ? { taskBudget: options.taskBudget } : {}),
      ...(options.attemptTimeoutMs ? { attemptTimeoutMs: options.attemptTimeoutMs } : {}),
    };
    let reply: ChatMessage;
    try {
      reply = await chat(wrappingUp && forcedChoiceWorks ? { ...request, forceTool: submitName } : request);
    } catch (error) {
      // A refusal would be refused again, and a model that can't be reached won't answer a request for the
      // submission either, so both end the run at once.
      if (error instanceof ModelRefused || error instanceof ModelUnavailable) throw error;
      const rejected = error instanceof ModelError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (wrappingUp && forcedChoiceWorks && rejected) {
        // Not every provider accepts a forced tool choice. Ask again and let the model choose, in the time left now.
        forcedChoiceWorks = false;
        reply = await chat({ ...request, timeoutMs: Math.max(1, deadline - Date.now()) });
      } else if (!wrappingUp && !rejected && options.onFailedTurn !== "throw" && deadline - Date.now() > 10_000) {
        // A slow or failing call used up the investigation time. Ask for the submission instead of giving up.
        log(`${who}: turn ${turn} failed (${told(error)}); asking for the submission`);
        wrapUp();
        continue;
      } else {
        throw error;
      }
    }
    push(reply);
    // A run past its bound is made to hand in what it has at the next turn, once this turn's tool calls have their
    // results (the workflow this ports would fold its worker and carry on).
    // A reply that reports no usage is measured by its conversation's characters, low per token, so the bound holds anyway.
    const size = reply.contextTokens ?? Math.ceil(contextChars / CHARS_PER_TOKEN);
    if (options.contextBound && size >= options.contextBound) pastBound = size;

    const calls = reply.tool_calls ?? [];
    const elapsed = Math.round((Date.now() - started) / 1000);
    // Only the names of tools it was offered, and a count of any others: the reader's log goes to a public repository's
    // Actions log, and a call's path or search query, or a name the model made up, is the model's own text.
    const offeredName = (call: ToolCall): boolean => tools.some((tool) => tool.function.name === call.function.name);
    const unoffered = calls.filter((call) => !offeredName(call)).length;
    const named = calls.filter(offeredName).map((call) => call.function.name);
    log(`${who}: turn ${turn} at ${elapsed}s: ${[...named, ...(unoffered ? [`${unoffered} unoffered`] : [])].join(", ") || "text"}`);

    const submission = calls.find((call) => call.function.name === submitName);
    if (submission) {
      const value = parseObject(submission.function.arguments);
      held.partial = value ? null : completeEntries(submission.function.arguments) ?? held.partial;
      if (!value && held.partial && wrappingUp) {
        // There is no time to ask again, and another cut-off answer would lose these too.
        log(`${who}: the submission was cut off; keeping its complete entries`);
        return held.submissions.length && secondLook ? secondLook.combine([...held.submissions, held.partial]) : held.partial;
      }
      if (value) held.submissions.push(value);
      const next = value && secondLook && !wrappingUp && deadline - Date.now() > 2 * wrapUpMs ? secondLook.message(held.submissions.length) : null;
      if (value && !next) return secondLook && held.submissions.length > 1 ? secondLook.combine(held.submissions) : value;
      // Every call needs a result before the next turn. An unparsable submission is usually output cut off mid-JSON.
      const content = value
        ? JSON.stringify({ ok: true, status: "received, not final yet", next })
        : JSON.stringify({ ok: false, error: `the ${submitName} arguments were not valid JSON; call it again with fewer or shorter entries` });
      for (const call of calls) push({ role: "tool", tool_call_id: call.id, content });
      continue;
    }

    if (!calls.length) {
      const value = reply.content ? objectFromText(reply.content) : null;
      if (value) return value;
      push({ role: "user", content: `Continue. When you are done, call ${submitName}; do not answer in plain text.` });
      continue;
    }

    for (const call of calls) {
      const offered = offeredName(call);
      // Once asked to hand in, a run with handInTurns reads nothing more (see handInTurns).
      if (wrappingUp && options.handInTurns) {
        push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: `reading has stopped; call ${submitName} now with what you have` }) });
        continue;
      }
      push({ role: "tool", tool_call_id: call.id, content: offered ? await workspace.call(call.function.name, call.function.arguments) : JSON.stringify({ ok: false, error: "unknown tool" }) });
    }
  }
  throw new Error(`${model} did not submit within ${maxTurns} turns`);
}
