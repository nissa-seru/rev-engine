// Reads the agent contract's inputs and this reviewer's settings from the environment.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Severity } from "./findings.ts";
import type { ModelApi } from "./llm.ts";
import { FOCUS_NAMES } from "./prompts.ts";

export type VerifyMode = "off" | "lenient" | "strict";
export type SecondLookMode = "on" | "off" | "sweep" | "sweep-low" | "small";

export interface Config extends Endpoint {
  nwo: string;
  prNumber: number;
  base: string;
  head: string;
  agent: string;
  repoDir: string;
  diffPath: string;
  prJsonPath: string;
  /** The maintainer's decisions on earlier reviews of this pull request. A missing file is fine. */
  priorJsonPath: string;
  outPath: string;
  /** Which attempt at this pull request this is, starting at 1. */
  attempt: number;
  /** One independent review seat per model. */
  models: string[];
  /** For each seat, the one focus it reviews for, or null for the full review. */
  focuses: Array<string | null>;
  verifierModel: string;
  verify: VerifyMode;
  /**
   * What each reviewer does after its first submission: look again once ("on"), go
   * through the changed hunks in rounds ("sweep"), the same while asking for small
   * problems too ("sweep-low"), look again and then make a pass for small problems
   * ("small"), or nothing ("off").
   */
  secondLook: SecondLookMode;
  /** A model that reviews again after the seats, told what they found. Null for none. */
  followUpModel: string | null;
  /** Review once more in a new conversation when every seat proposed nothing. */
  retryEmpty: boolean;
  /** Replace the whole review with one model call over the diff, as a baseline to compare against. */
  naive: boolean;
  /** Replace the review with the swarm prototype in experiments/prototypes/swarm, which reads its own RB_CONFIG_SWARM_* settings. */
  swarm: boolean;
  /**
   * Replace the review with the review shape in src/shape: a planner, two batteries (terra or Sol, and haiku), a
   * grouper, a judge and a severity check. Null when off.
   */
  shape: ShapeSettings | null;
  /** Findings less severe than this are dropped before verification. */
  minSeverity: Severity;
  /** A model that judges whether the change belongs in the project. Null for none. */
  fitModel: string | null;
  /** Where the fit assessment is written. */
  fitOutPath: string;
  /** When set, the findings are also written here with their severity, title and detail kept apart. */
  detailsOutPath: string | null;
  /** When set, every model conversation of the run is written here, for replaying the review offline. */
  transcriptOutPath: string | null;
  contextOutPath: string | null;
  effort: string | null;
  maxFindings: number;
  /** Wall-clock budget for the whole run. */
  budgetMs: number;
  maxTurns: number;
}

export type BatteryAModel = "terra" | "sol";

/** The review shape's settings (docs/SETTINGS.md). */
export interface ShapeSettings {
  /** Where battery A's model is asked, an OpenAI Responses endpoint, with the same key as the main endpoint. */
  responsesBaseUrl: string;
  /** Battery A's model: terra or Sol. */
  batteryA: BatteryAModel;
  /** The directory each area's run directory is written under. */
  outDir: string;
  /** An earlier run's output directory of the same review, whose plan and answers are taken instead of asked again. */
  keptDir: string | null;
  /** Which review of this pull request this is, from 1. */
  round: number;
  /** The label of the review whose head this one reads from, when it reads from one. */
  roundOf: string | null;
  /**
   * The commit project rules are read from: the pull request's base, which in a later round isn't the base the review
   * reads from (an earlier head of the pull request itself).
   */
  rulesBase: string;
  /** The review's label, re-<owner>.<name>-<pr>-<round>. */
  label: string;
}

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-6-luna";

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sha(env: Env, name: string): string {
  const value = required(env, name);
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} is not a 40-character commit SHA`);
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** The model endpoint: where requests go, the API it speaks, its key and any extra headers. */
export interface Endpoint {
  apiKey: string;
  baseUrl: string;
  api: ModelApi;
  headers: Record<string, string>;
}

/** Reads the endpoint settings (docs/SETTINGS.md). The scripts and evals that run on the host use it too. */
export function loadEndpoint(env: Env): Endpoint {
  const api = (env.RB_MODEL_API?.trim() || "chat") as ModelApi;
  if (!["chat", "anthropic"].includes(api)) throw new Error("RB_MODEL_API must be chat or anthropic");
  const apiKey = env.RB_MODEL_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("missing OPENROUTER_API_KEY, or RB_MODEL_API_KEY");
  const baseUrl = env.RB_MODEL_BASE_URL?.trim();
  // OpenRouter's URL is the default only for chat, so a Messages endpoint's key isn't sent there unasked.
  if (!baseUrl && api !== "chat") throw new Error(`RB_MODEL_API=${api} needs RB_MODEL_BASE_URL`);
  return {
    apiKey,
    baseUrl: (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    api,
    headers: modelHeaders(env.RB_MODEL_HEADERS),
  };
}

/**
 * NAME=VALUE lines of a .env file, each optionally after `export`, with one pair of surrounding
 * quotes taken off each value. Unlike a shell, it keeps a trailing comment as part of the value.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const match of text.matchAll(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) {
    settings[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return settings;
}

/**
 * The endpoint as the evals and the scripts on the host read it: each setting from the
 * environment when it is set and not empty, or else from the .env file in `dir`.
 */
export function readEndpoint(dir: string, env: Env = process.env): Endpoint {
  let text = "";
  try {
    text = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    // No .env: the environment alone.
  }
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value?.trim()));
  return loadEndpoint({ ...parseEnvFile(text), ...set });
}

/** RB_MODEL_HEADERS: a JSON object of header names and string values. Names come back in lower case, as HTTP compares them. */
function modelHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RB_MODEL_HEADERS must be a JSON object of header names and string values");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error("RB_MODEL_HEADERS must be a JSON object of header names and string values");
  }
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name.toLowerCase(), item as string]));
}

export function loadConfig(env: Env): Config {
  const prNumber = Number(required(env, "RB_PR_NUMBER"));
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("RB_PR_NUMBER is not a positive integer");

  // Each seat is a model, optionally followed by "@" and the one focus it reviews for.
  const seats = (env.RB_CONFIG_MODEL ?? DEFAULT_MODEL).split(",").map((seat) => seat.trim()).filter(Boolean);
  if (!seats.length) throw new Error("RB_CONFIG_MODEL names no model");
  const models = seats.map((seat) => (seat.includes("@") ? seat.slice(0, seat.lastIndexOf("@")) : seat));
  const focuses = seats.map((seat) => (seat.includes("@") ? seat.slice(seat.lastIndexOf("@") + 1) : null));
  for (const focus of focuses) {
    if (focus !== null && !FOCUS_NAMES.includes(focus)) throw new Error(`RB_CONFIG_MODEL names an unknown focus "${focus}"; the choices are ${FOCUS_NAMES.join(", ")}`);
  }
  if (models.some((model) => !model)) throw new Error("RB_CONFIG_MODEL has a seat with no model");

  const verify = (env.RB_CONFIG_VERIFY?.trim() || "lenient") as VerifyMode;
  if (!["off", "lenient", "strict"].includes(verify)) throw new Error("RB_CONFIG_VERIFY must be off, lenient or strict");

  const secondLook = (env.RB_CONFIG_SECOND_LOOK?.trim() || "on") as SecondLookMode;
  if (!["on", "off", "sweep", "sweep-low", "small"].includes(secondLook)) throw new Error("RB_CONFIG_SECOND_LOOK must be on, off, sweep, sweep-low or small");

  const retryEmpty = env.RB_CONFIG_RETRY_EMPTY?.trim() || "on";
  if (!["on", "off"].includes(retryEmpty)) throw new Error("RB_CONFIG_RETRY_EMPTY must be on or off");

  const naive = env.RB_CONFIG_NAIVE?.trim() || "off";
  if (!["on", "off"].includes(naive)) throw new Error("RB_CONFIG_NAIVE must be on or off");

  const swarm = env.RB_CONFIG_SWARM?.trim() || "off";
  if (!["on", "off"].includes(swarm)) throw new Error("RB_CONFIG_SWARM must be on or off");
  if (naive === "on" && swarm === "on") throw new Error("RB_CONFIG_NAIVE and RB_CONFIG_SWARM cannot both be on");

  const shapeOn = env.RB_CONFIG_SHAPE?.trim() || "off";
  if (!["on", "off"].includes(shapeOn)) throw new Error("RB_CONFIG_SHAPE must be on or off");
  if (shapeOn === "on" && (naive === "on" || swarm === "on")) throw new Error("RB_CONFIG_SHAPE cannot be on with RB_CONFIG_NAIVE or RB_CONFIG_SWARM");

  const minSeverity = (env.RB_CONFIG_MIN_SEVERITY?.trim() || "low") as Severity;
  if (!["high", "medium", "low"].includes(minSeverity)) throw new Error("RB_CONFIG_MIN_SEVERITY must be high, medium or low");

  const outPath = required(env, "RB_OUT");

  const endpoint = loadEndpoint(env);
  const nwo = required(env, "RB_NWO");
  let shape: ShapeSettings | null = null;
  if (shapeOn === "on") {
    if (endpoint.api !== "anthropic") throw new Error("RB_CONFIG_SHAPE=on asks its Claude models through Anthropic Messages, so RB_MODEL_API must be anthropic");
    const round = integer(env, "RB_SHAPE_ROUND", 1, 1, 10_000);
    const batteryA = env.RB_SHAPE_BATTERY_A || "terra";
    if (batteryA !== "terra" && batteryA !== "sol") throw new Error("RB_SHAPE_BATTERY_A must be terra or sol");
    shape = {
      responsesBaseUrl: required(env, "RB_RESPONSES_BASE_URL").replace(/\/+$/, ""),
      batteryA,
      outDir: env.RB_SHAPE_OUT?.trim() || join(dirname(outPath), "shape"),
      keptDir: env.RB_SHAPE_KEPT?.trim() || null,
      round,
      roundOf: env.RB_SHAPE_ROUND_OF?.trim() || null,
      // In a later round RB_BASE is an earlier head of the pull request, whose rule files the pull request wrote.
      rulesBase: env.RB_SHAPE_RULES_BASE?.trim() || env.RB_SHAPE_ROUND_OF?.trim() ? sha(env, "RB_SHAPE_RULES_BASE") : sha(env, "RB_BASE"),
      label: `re-${nwo.replace("/", ".")}-${prNumber}-${round}`,
    };
  }

  return {
    nwo,
    prNumber,
    base: sha(env, "RB_BASE"),
    head: sha(env, "RB_HEAD"),
    agent: env.RB_AGENT?.trim() || "rev-engine-prime",
    repoDir: env.RB_REPO?.trim() || "/work/repo",
    diffPath: env.RB_DIFF?.trim() || "/work/pr/diff.patch",
    prJsonPath: env.RB_PR_JSON?.trim() || "/work/pr/pr.json",
    priorJsonPath: env.RB_PRIOR_JSON?.trim() || "/work/pr/prior.json",
    outPath,
    attempt: integer(env, "RB_ATTEMPT", 1, 1, 1000),
    ...endpoint,
    models,
    focuses,
    verifierModel: env.RB_CONFIG_VERIFIER?.trim() || models[0]!,
    verify,
    secondLook,
    followUpModel: env.RB_CONFIG_FOLLOW_UP?.trim() || null,
    retryEmpty: retryEmpty === "on",
    naive: naive === "on",
    swarm: swarm === "on",
    shape,
    minSeverity,
    fitModel: env.RB_CONFIG_FIT?.trim() || null,
    fitOutPath: join(dirname(outPath), "fit.json"),
    detailsOutPath: env.RB_DETAILS_OUT?.trim() || null,
    transcriptOutPath: env.RB_TRANSCRIPT_OUT?.trim() || null,
    contextOutPath: env.RB_CONTEXT_OUT?.trim() || null,
    effort: env.RB_CONFIG_EFFORT?.trim() || null,
    maxFindings: integer(env, "RB_CONFIG_MAX_FINDINGS", 25, 1, 100),
    budgetMs: integer(env, "RB_CONFIG_TIME_BUDGET", 780, 60, 7200) * 1000,
    maxTurns: integer(env, "RB_CONFIG_MAX_TURNS", 40, 2, 200),
  };
}

/** The settings line the benchmark looks for: every configured label value must appear in the output. */
export function describeSettings(config: Config): string {
  if (config.naive) return `naive=on model=${config.models[0]} max_findings=${config.maxFindings} time_budget=${config.budgetMs / 1000}`;
  if (config.shape) return `shape=on model=${config.models[0]} battery_a=${config.shape.batteryA} label=${config.shape.label} rules_base=${config.shape.rulesBase.slice(0, 12)}${config.shape.keptDir ? " kept=on" : ""}`;
  if (config.swarm) return `swarm=on model=${config.models[0]} verifier=${config.verifierModel} verify=${config.verify} effort=${config.effort ?? "default"} max_findings=${config.maxFindings} time_budget=${config.budgetMs / 1000} max_turns=${config.maxTurns}`;
  return [
    `model=${config.models.map((model, index) => (config.focuses[index] ? `${model}@${config.focuses[index]}` : model)).join(",")}`,
    `verifier=${config.verifierModel}`,
    `verify=${config.verify}`,
    `second_look=${config.secondLook}`,
    `follow_up=${config.followUpModel ?? "off"}`,
    `retry_empty=${config.retryEmpty ? "on" : "off"}`,
    `min_severity=${config.minSeverity}`,
    `fit=${config.fitModel ?? "off"}`,
    `effort=${config.effort ?? "default"}`,
    `max_findings=${config.maxFindings}`,
    `time_budget=${config.budgetMs / 1000}`,
    `max_turns=${config.maxTurns}`,
  ].join(" ");
}
