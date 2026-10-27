import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, describeSettings, loadConfig, loadEndpoint, parseEnvFile, readEndpoint } from "../src/config.ts";

const BASE = {
  RB_NWO: "owner/repo",
  RB_PR_NUMBER: "1938",
  RB_BASE: "a".repeat(40),
  RB_HEAD: "b".repeat(40),
  RB_OUT: "/work/out/findings.json",
  OPENROUTER_API_KEY: "test-key",
};

test("applies defaults when only the contract variables are set", () => {
  const config = loadConfig(BASE);
  assert.equal(config.prNumber, 1938);
  assert.equal(config.agent, "rev-engine-prime");
  assert.equal(config.repoDir, "/work/repo");
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.deepEqual(config.models, [DEFAULT_MODEL]);
  assert.equal(config.verifierModel, DEFAULT_MODEL);
  assert.equal(config.verify, "lenient");
  assert.equal(config.budgetMs, 780_000);
  assert.equal(config.minSeverity, "low");
  assert.equal(config.fitModel, null);
  assert.equal(config.detailsOutPath, null);
  assert.equal(loadConfig({ ...BASE, RB_DETAILS_OUT: "/work/out/details.json" }).detailsOutPath, "/work/out/details.json");
});

test("reads the minimum severity and the fit model", () => {
  const config = loadConfig({ ...BASE, RB_CONFIG_MIN_SEVERITY: "high", RB_CONFIG_FIT: "vendor/fit" });
  assert.equal(config.minSeverity, "high");
  assert.equal(config.fitModel, "vendor/fit");
  assert.equal(config.fitOutPath, "/work/out/fit.json");
  assert.ok(describeSettings(config).includes("min_severity=high fit=vendor/fit"));
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_MIN_SEVERITY: "urgent" }), /RB_CONFIG_MIN_SEVERITY/);
});

test("retries an empty review unless told not to", () => {
  assert.equal(loadConfig(BASE).retryEmpty, true);
  const config = loadConfig({ ...BASE, RB_CONFIG_RETRY_EMPTY: "off" });
  assert.equal(config.retryEmpty, false);
  assert.ok(describeSettings(config).includes("retry_empty=off"));
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_RETRY_EMPTY: "twice" }), /RB_CONFIG_RETRY_EMPTY/);
});

test("reads the reviewer settings from RB_CONFIG variables", () => {
  const config = loadConfig({
    ...BASE,
    RB_AGENT: "registered-name",
    RB_MODEL_BASE_URL: "https://example.com/v1/",
    RB_CONFIG_MODEL: "vendor/one, vendor/two",
    RB_CONFIG_VERIFIER: "vendor/three",
    RB_CONFIG_VERIFY: "strict",
    RB_CONFIG_EFFORT: "high",
    RB_CONFIG_MAX_FINDINGS: "10",
    RB_CONFIG_TIME_BUDGET: "600",
  });
  assert.equal(config.agent, "registered-name");
  assert.equal(config.baseUrl, "https://example.com/v1");
  assert.deepEqual(config.models, ["vendor/one", "vendor/two"]);
  assert.equal(config.verifierModel, "vendor/three");
  const settings = describeSettings(config);
  for (const value of ["vendor/one,vendor/two", "vendor/three", "strict", "high", "10", "600"]) assert.ok(settings.includes(value), value);
  assert.ok(!settings.includes("test-key"));
});

test("rejects missing or malformed inputs", () => {
  assert.throws(() => loadConfig({ ...BASE, RB_HEAD: "abc123" }), /RB_HEAD is not a 40-character commit SHA/);
  assert.throws(() => loadConfig({ ...BASE, OPENROUTER_API_KEY: "" }), /missing OPENROUTER_API_KEY/);
  assert.throws(() => loadConfig({ ...BASE, RB_PR_NUMBER: "abc" }), /RB_PR_NUMBER/);
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_VERIFY: "maybe" }), /RB_CONFIG_VERIFY/);
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_MAX_FINDINGS: "0" }), /RB_CONFIG_MAX_FINDINGS/);
});

test("a seat may name one focus after its model", () => {
  const config = loadConfig({ ...BASE, RB_CONFIG_MODEL: "vendor/one, vendor/two@tests ,vendor/two@maintainability" });
  assert.deepEqual(config.models, ["vendor/one", "vendor/two", "vendor/two"]);
  assert.deepEqual(config.focuses, [null, "tests", "maintainability"]);
  assert.equal(config.verifierModel, "vendor/one");
  assert.ok(describeSettings(config).includes("model=vendor/one,vendor/two@tests,vendor/two@maintainability"));
  assert.deepEqual(loadConfig(BASE).focuses, [null]);
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_MODEL: "vendor/one@speling" }), /unknown focus "speling"/);
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_MODEL: "@tests" }), /seat with no model/);
});

test("turns on the swarm prototype, but not together with the naive baseline", () => {
  const config = loadConfig({ ...BASE, RB_CONFIG_SWARM: "on" });
  assert.equal(config.swarm, true);
  assert.ok(describeSettings(config).startsWith("swarm=on model="));
  assert.equal(loadConfig(BASE).swarm, false);
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_SWARM: "yes" }), /RB_CONFIG_SWARM/);
  assert.throws(() => loadConfig({ ...BASE, RB_CONFIG_SWARM: "on", RB_CONFIG_NAIVE: "on" }), /cannot both be on/);
});

test("reads the model API and a key that is not OpenRouter's", () => {
  assert.equal(loadConfig(BASE).api, "chat");
  const { OPENROUTER_API_KEY: _, ...withoutOpenRouter } = BASE;
  const config = loadConfig({ ...withoutOpenRouter, RB_MODEL_API: "anthropic", RB_MODEL_API_KEY: "other-key", RB_MODEL_BASE_URL: "http://127.0.0.1:9/anthropic" });
  assert.equal(config.api, "anthropic");
  assert.equal(config.apiKey, "other-key");
  assert.equal(loadConfig({ ...BASE, RB_MODEL_API_KEY: "other-key" }).apiKey, "other-key");
  assert.throws(() => loadConfig({ ...BASE, RB_MODEL_API: "responses" }), /RB_MODEL_API must be chat or anthropic/);
  assert.throws(() => loadConfig(withoutOpenRouter), /missing OPENROUTER_API_KEY, or RB_MODEL_API_KEY/);
  // OpenRouter's URL isn't a default for another API, so a Messages endpoint's key isn't sent there unasked.
  assert.throws(() => loadConfig({ ...BASE, RB_MODEL_API: "anthropic" }), /RB_MODEL_API=anthropic needs RB_MODEL_BASE_URL/);
});

test("reads extra model request headers as a JSON object", () => {
  assert.deepEqual(loadConfig(BASE).headers, {});
  assert.deepEqual(loadConfig({ ...BASE, RB_MODEL_HEADERS: '{"X-Class":"batch"}' }).headers, { "x-class": "batch" });
  for (const bad of ["x-class: batch", '["x"]', '{"x-count":1}', "1", "null", '"x"']) {
    assert.throws(() => loadConfig({ ...BASE, RB_MODEL_HEADERS: bad }), /RB_MODEL_HEADERS must be a JSON object/, bad);
  }
});

test("reads a .env file's settings, taking one pair of quotes off a value", () => {
  const text = "# a comment\nRB_MODEL_API=anthropic\nexport RB_MODEL_BASE_URL=http://127.0.0.1:9/anthropic\nRB_MODEL_HEADERS='{\"x-class\":\"batch\"}'\nOPENROUTER_API_KEY=\"quoted\"\nnot a setting\n";
  const settings = parseEnvFile(text);
  assert.deepEqual(settings, { RB_MODEL_API: "anthropic", RB_MODEL_BASE_URL: "http://127.0.0.1:9/anthropic", RB_MODEL_HEADERS: '{"x-class":"batch"}', OPENROUTER_API_KEY: "quoted" });
  assert.deepEqual(loadEndpoint(settings), { apiKey: "quoted", baseUrl: "http://127.0.0.1:9/anthropic", api: "anthropic", headers: { "x-class": "batch" } });
});

test("reads the endpoint from the environment where it is set and not empty, and from .env otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "rep-env-"));
  writeFileSync(join(dir, ".env"), "RB_MODEL_API_KEY=from-file\nRB_MODEL_BASE_URL=https://file.example/v1\n");
  assert.deepEqual(readEndpoint(dir, { RB_MODEL_API_KEY: "", RB_MODEL_BASE_URL: "https://shell.example/v1" }), { apiKey: "from-file", baseUrl: "https://shell.example/v1", api: "chat", headers: {} });
  assert.equal(readEndpoint(dir, { RB_MODEL_API_KEY: "  " }).apiKey, "from-file");
  assert.equal(readEndpoint(join(dir, "missing"), { OPENROUTER_API_KEY: "shell" }).apiKey, "shell");
});

test("the review shape reads project rules from the pull request's base, which a later round must name", () => {
  const shape = { ...BASE, RB_MODEL_API: "anthropic", RB_MODEL_BASE_URL: "http://127.0.0.1:9/anthropic", RB_CONFIG_SHAPE: "on", RB_RESPONSES_BASE_URL: "http://127.0.0.1:6175/openai/" };
  const first = loadConfig(shape).shape!;
  assert.equal(first.rulesBase, BASE.RB_BASE, "a first round reads them from its own base");
  assert.equal(first.responsesBaseUrl, "http://127.0.0.1:6175/openai");
  assert.equal(first.batteryA, "terra", "battery A reads on terra unless told otherwise");
  assert.equal(loadConfig({ ...shape, RB_SHAPE_BATTERY_A: "" }).shape!.batteryA, "terra", "and an empty setting, as the Action passes an input it wasn't given");
  assert.equal(loadConfig({ ...shape, RB_SHAPE_BATTERY_A: "sol" }).shape!.batteryA, "sol");
  assert.throws(() => loadConfig({ ...shape, RB_SHAPE_BATTERY_A: "gpt-6.1-sol" }), /RB_SHAPE_BATTERY_A must be terra or sol/);
  assert.throws(() => loadConfig({ ...shape, RB_SHAPE_BATTERY_A: " sol " }), /RB_SHAPE_BATTERY_A must be terra or sol/, "a padded value too, which the Action's other steps read as given");
  assert.throws(() => loadConfig({ ...shape, RB_RESPONSES_BASE_URL: "" }), /RB_RESPONSES_BASE_URL/);
  assert.match(describeSettings(loadConfig({ ...shape, RB_SHAPE_BATTERY_A: "sol" })), / battery_a=sol /);
  assert.equal(loadConfig({ ...shape, RB_SHAPE_RULES_BASE: "c".repeat(40) }).shape!.rulesBase, "c".repeat(40));
  assert.throws(() => loadConfig({ ...shape, RB_SHAPE_ROUND: "2", RB_SHAPE_ROUND_OF: "re-owner.repo-1938-1" }), /RB_SHAPE_RULES_BASE/, "a later round's base is an earlier head of the pull request");
});
