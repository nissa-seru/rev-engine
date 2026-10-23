import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Action's shell steps, run as bash runs them, with GitHub's environment and the gh CLI stood in.
const ACTION = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
const WORKFLOW = readFileSync(new URL("../.github/workflows/org-review.yml", import.meta.url), "utf8");

/** The `run: |` script of the step with this name in the Action (or the given file), dedented. */
function stepScript(name: string, source = ACTION): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `no step named ${name}`);
  const run = lines.findIndex((line, index) => index > start && /^\s+run: \|\s*$/.test(line));
  const indent = lines[run]!.search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  const strip = Math.min(...body.filter((line) => line.trim()).map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(strip)).join("\n");
}

function runStep(name: string, env: Record<string, string>, setup?: (temp: string) => void, options: { source?: string; cwd?: string } = {}): { outputs: Record<string, string>; stdout: string; temp: string } {
  const temp = mkdtempSync(join(tmpdir(), "action-step-"));
  const output = join(temp, "github-output");
  writeFileSync(output, "");
  setup?.(temp);
  const stdout = execFileSync("bash", ["-c", stepScript(name, options.source)], {
    env: { PATH: `${join(temp, "bin")}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_WORKSPACE: temp, GITHUB_OUTPUT: output, ...env },
    encoding: "utf8",
    ...(options.cwd ? { cwd: join(temp, options.cwd) } : {}),
  });
  const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]));
  return { outputs, stdout, temp };
}

/** A stand-in for a program on the step's PATH: a bash script run with the step's arguments. */
function stub(temp: string, name: string, script: string): void {
  mkdirSync(join(temp, "bin"), { recursive: true });
  writeFileSync(join(temp, "bin", name), `#!/bin/bash\n${script}\n`);
  chmodSync(join(temp, "bin", name), 0o755);
}

test("a stopped review's answers are gathered only where GitHub lets the run write its cache", () => {
  const wrotePlan = (temp: string) => {
    mkdirSync(join(temp, "rev-engine-prime/out/shape"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/out/shape/shape-plan.json"), "{}");
  };
  const cases: Array<[string, string, Record<string, string>]> = [
    ["", "workflow_dispatch", { kept: "true" }],
    ["", "pull_request_target", { readonly: "true" }],
    ["", "issue_comment", { readonly: "true" }],
    ["write", "issue_comment", { kept: "true" }],
    ["write-only", "pull_request_target", { kept: "true" }],
    ["read", "workflow_dispatch", { readonly: "true" }],
    ["none", "workflow_dispatch", { readonly: "true" }],
  ];
  for (const [mode, event, expected] of cases) {
    assert.deepEqual(runStep("Gather a stopped review's answers", { ACTIONS_CACHE_MODE: mode, GITHUB_EVENT_NAME: event }, wrotePlan).outputs, expected, `${mode || "unset"} on ${event}`);
  }
  assert.deepEqual(runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: "workflow_dispatch" }).outputs, {}, "a run that wrote no plan keeps nothing new");
  const restoredOnly = (temp: string) => {
    mkdirSync(join(temp, "rev-engine-prime/kept"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/kept/shape-plan.json"), "{}");
  };
  assert.deepEqual(runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: "pull_request_target" }, restoredOnly).outputs, {}, "a restored plan with no new one is neither kept again nor blamed on the cache");
  // What an earlier run kept was restored to the same place: the new answers replace it whole.
  const { temp } = runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: "workflow_dispatch" }, (temp) => {
    wrotePlan(temp);
    restoredOnly(temp);
    writeFileSync(join(temp, "rev-engine-prime/kept/shape-plan.json"), "stale");
    writeFileSync(join(temp, "rev-engine-prime/kept/stale-answer.json"), "stale");
  });
  assert.deepEqual(readdirSync(join(temp, "rev-engine-prime/kept")), ["shape-plan.json"], "nothing restored is left beside the new answers");
  assert.equal(readFileSync(join(temp, "rev-engine-prime/kept/shape-plan.json"), "utf8"), "{}", "the new plan is what's kept");
});

test("the round is read from a bot summary's own marker line only, in base 10", () => {
  const head = "c".repeat(40);
  const reviews = (lines: string[]) => (temp: string) => {
    mkdirSync(join(temp, "bin"), { recursive: true });
    mkdirSync(join(temp, "rev-engine-prime/pr"), { recursive: true });
    // gh as GitHub answers the reviews listing: the page as JSON, with the step's own --jq applied to it.
    writeFileSync(join(temp, "reviews.json"), JSON.stringify(lines.map((body) => ({ user: { login: body.startsWith("human:") ? "someone" : "github-actions[bot]" }, body: body.replace(/^human:/, "") }))));
    writeFileSync(join(temp, "bin/gh"), `#!/bin/bash\nwhile [ "$1" != --jq ]; do shift; done\njq -r "$2" "${join(temp, "reviews.json")}"\n`);
    chmodSync(join(temp, "bin/gh"), 0o755);
  };
  const env = { REPO: "o/r", NUMBER: "7", BASE: "b".repeat(40), HEAD: head, GH_TOKEN: "t" };
  const marker = `<!-- rev-engine-shape-review re-o.r-7-08 ${head} -->`;
  const summary = (line: string) => `review text\n${line}\n<!-- rev-engine-prime -->`;
  assert.deepEqual(runStep("Find the review's round", env, reviews([summary(marker)])).outputs, { round: "9", "round-of": "", base: "b".repeat(40) }, "after a label ending in 08 comes round 9");
  assert.equal(runStep("Find the review's round", env, reviews([summary(`quoted ${marker} in a line`)])).outputs.round, "1", "a marker inside a longer line isn't one");
  assert.equal(runStep("Find the review's round", env, reviews([`review text\n${marker}\nmore\n<!-- rev-engine-prime -->`])).outputs.round, "1", "only a summary's last line but one is its marker");
  assert.equal(runStep("Find the review's round", env, reviews([`human:${summary(marker)}`])).outputs.round, "1", "a person's review isn't a summary");
});

test("the shape's container gets the run's id and attempt for its record", () => {
  const shapeArgs = ACTION.split("\n").find((line) => line.includes("shape=(-e RB_CONFIG_SHAPE=on"));
  assert.ok(shapeArgs?.includes("-e GITHUB_RUN_ID") && shapeArgs.includes("-e GITHUB_RUN_ATTEMPT"), shapeArgs);
});

test("every shell step of the Action and the shared workflow parses as bash", () => {
  for (const url of [new URL("../action.yml", import.meta.url), new URL("../.github/workflows/org-review.yml", import.meta.url)]) {
    const lines = readFileSync(url, "utf8").split("\n");
    let scripts = 0;
    lines.forEach((line, index) => {
      const single = /^\s+run: (?!\|)(.+)$/.exec(line);
      let script = single?.[1] ?? null;
      if (/^\s+run: \|\s*$/.test(line)) {
        const indent = line.search(/\S/);
        const body: string[] = [];
        for (const next of lines.slice(index + 1)) {
          if (next.trim() && next.search(/\S/) <= indent) break;
          body.push(next);
        }
        const strip = Math.min(...body.filter((next) => next.trim()).map((next) => next.search(/\S/)));
        script = body.map((next) => next.slice(strip)).join("\n");
      }
      if (script === null) return;
      scripts += 1;
      assert.doesNotThrow(() => execFileSync("bash", ["-n", "-c", script!], { stdio: "pipe" }), `${url.pathname.split("/").pop()}:${index + 1}`);
    });
    assert.ok(scripts > 3, `found the steps of ${url.pathname}`);
  }
});

test("the stop comment says what was kept, and why not when GitHub's cache was the reason", () => {
  const said = (env: Record<string, string>) => {
    let body = "";
    runStep("Say that the review stopped", { REPO: "o/r", NUMBER: "7", RUN: "https://x/run", DEFAULT_BRANCH: "main", GITHUB_REF: "refs/heads/main", GH_TOKEN: "t", CATEGORY: "", KEPT: "", READONLY: "", ...env }, (temp) => {
      mkdirSync(join(temp, "bin"), { recursive: true });
      writeFileSync(join(temp, "bin/gh"), `#!/bin/bash\nwhile [ "$1" != --body ]; do shift; done\nprintf '%s' "$2" > "${join(temp, "body")}"\n`);
      chmodSync(join(temp, "bin/gh"), 0o755);
      body = join(temp, "body");
    });
    return readFileSync(body, "utf8");
  };
  assert.match(said({ STOP: "sol-unavailable", KEPT: "true" }), /It keeps what it has read/);
  assert.match(said({ STOP: "time", READONLY: "true" }), /GitHub's cache didn't let this run keep what it read/);
  assert.doesNotMatch(said({ STOP: "time" }), /GitHub's cache/, "nothing to keep is no cache's doing");
  assert.match(said({ STOP: "sol-unavailable", KEPT: "true", GITHUB_REF: "refs/heads/dev" }), /a later manual run of this head on dev; a \/review comment runs on the default branch, where what this run kept isn't, and goes on from what a run there kept, if any, or reads it from the start\./);
  assert.match(said({ STOP: "refused", CATEGORY: "cyber_policy" }), /refused one of its calls \(category: cyber_policy\)\. It won't go on by itself, and a \/review may meet the same refusal\./);
});

test("the dependencies job installs each lockfile with its own installer, and only a root with none from package.json's ranges", () => {
  const install = (files: string[], leaves = true) => runStep("Install the dependencies, scripts off, in a container", {}, (temp) => {
    mkdirSync(join(temp, "head"));
    for (const file of files) writeFileSync(join(temp, "head", file), "{}");
    // What the head itself commits at node_modules, a ranges marker among it, is never passed on.
    mkdirSync(join(temp, "head/node_modules/committed"), { recursive: true });
    writeFileSync(join(temp, "head/node_modules/.installed-from-ranges"), "");
    // docker as the install leaves it: node_modules with a package, and a link a lockfile could ask for.
    stub(temp, "docker", `printf '%s\\n' "$@" > "${join(temp, "docker-args")}"\n${leaves ? `mkdir -p node_modules/pkg && echo x > node_modules/pkg/index.js && ln -s /proc/self/environ node_modules/env` : ""}`);
  }, { source: WORKFLOW, cwd: "head" });
  const asked = (temp: string) => existsSync(join(temp, "docker-args")) ? readFileSync(join(temp, "docker-args"), "utf8").split("\n").filter(Boolean) : [];
  const cases: Array<[string[], string | null, string[]]> = [
    [["package.json", "bun.lock"], "oven/bun:1", ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]],
    [["package.json", "bun.lockb"], "oven/bun:1", ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]],
    [["package.json", "package-lock.json"], "node:24", ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
    [["package.json", "npm-shrinkwrap.json"], "node:24", ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
    [["package.json"], "node:24", ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"]],
    [["package.json", "yarn.lock"], null, []],
    [["package.json", "pnpm-lock.yaml"], null, []],
    // bun's or npm's lockfile beside yarn's or pnpm's is installed from.
    [["package.json", "bun.lock", "yarn.lock"], "oven/bun:1", ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]],
    [["package.json", "package-lock.json", "pnpm-lock.yaml"], "node:24", ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
    [[], null, []],
  ];
  const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
  const gid = execFileSync("id", ["-g"], { encoding: "utf8" }).trim();
  for (const [files, image, command] of cases) {
    const { outputs, temp, stdout } = install(files);
    const args = asked(temp);
    if (!image) {
      assert.deepEqual([args, outputs], [[], {}], `${files.join(" ") || "nothing"}: no install`);
      assert.match(stdout, files.length ? /::notice::The head's only lockfile is yarn's or pnpm's/ : /::notice::No package\.json at the root/);
      continue;
    }
    // The container sees only the checkout, as the runner's own user.
    assert.deepEqual(args.slice(0, args.indexOf(image)), ["run", "--rm", "-v", `${join(temp, "head")}:/work`, "-w", "/work", "--user", `${uid}:${gid}`, "-e", "HOME=/tmp"], files.join(" "));
    assert.deepEqual(args.slice(args.indexOf(image)), [image, ...command], files.join(" "));
    assert.ok(!existsSync(join(temp, "head/node_modules/committed")), `${files.join(" ")}: what the head committed at node_modules is gone`);
    assert.equal(outputs.installed, "true", files.join(" "));
    assert.equal(existsSync(join(temp, "head/node_modules/.installed-from-ranges")), files.length === 1, `${files.join(" ")}: the ranges marker only where there's no lockfile`);
    assert.ok(!existsSync(join(temp, "head/node_modules/env")) && existsSync(join(temp, "head/node_modules/pkg/index.js")), `${files.join(" ")}: links go, packages stay`);
  }
  const empty = install(["package.json"], false);
  assert.deepEqual(empty.outputs, {}, "an install that leaves no node_modules passes nothing on, and doesn't fail");
  assert.match(empty.stdout, /::notice::The install left no node_modules/);
});

test("a consumer that can't be cloned, or isn't owner/name, is said and the rest are still read", () => {
  const { stdout, temp } = runStep("Check out the consumers", { CONSUMERS: "o/gone ../x o/kept" }, (temp) => {
    mkdirSync(join(temp, "rev-engine-prime-checkout"));
    // A clone that fails partway leaves what it wrote.
    stub(temp, "git", `for last; do :; done\nmkdir -p "$last"\ncase "$*" in *o/gone.git*) touch "$last/partial"; exit 128 ;; esac`);
  });
  assert.deepEqual(readdirSync(join(temp, "rev-engine-prime-checkout/.consumers")), ["o__kept"], "nothing of a failed clone is left to read");
  assert.match(stdout, /::warning::consumers: o\/gone couldn't be cloned/);
  assert.match(stdout, /::warning::consumers: "\.\.\/x" is not owner\/name/);
});

test("dependencies that aren't placed are said, with why", () => {
  assert.match(runStep("Say why the dependencies aren't placed", { DEPENDENCIES_HEAD: "" }).stdout, /No dependencies-head was given/);
  assert.match(runStep("Say why the dependencies aren't placed", { DEPENDENCIES_HEAD: "a".repeat(40) }).stdout, /The head under review isn't dependencies-head/);
});

test("a review that stops reads its stop from stopped.json, and one it can't read fails the step", () => {
  const review = (stopped: string | null, status = 3) => runStep("Review", { RB_MODEL_BASE_URL: "http://m", SHAPE: "on", KEPT: "", RB_NWO: "o/r", RB_PR_NUMBER: "7" }, (temp) => {
    stub(temp, "docker", `${stopped === null ? "" : `mkdir -p "${join(temp, "rev-engine-prime/out")}" && printf '%s' '${stopped}' > "${join(temp, "rev-engine-prime/out/stopped.json")}"`}\nexit ${status}`);
  });
  assert.deepEqual(review('{"reason":"refused","category":"cyber_policy"}').outputs, { status: "3", stop: "refused", category: "cyber_policy" });
  assert.deepEqual(review('{"reason":"time"}').outputs, { status: "3", stop: "time", category: "" });
  assert.throws(() => review("not json"), "an unreadable stop fails the step");
  assert.throws(() => review('{"category":"x"}'), "a stop with no reason fails the step");
  assert.throws(() => review(null), "a stop with no stopped.json fails the step");
  assert.throws(() => review(null, 1), "a failed review fails the step");
  assert.deepEqual(review(null, 0).outputs, { status: "0" });
});

test("the diffs are written with paths as themselves", () => {
  const diffs = ACTION.split("\n").filter((line) => /git -C "\$repo".* diff /.test(line));
  assert.equal(diffs.length, 2);
  for (const line of diffs) assert.match(line, /-c core\.quotePath=false diff/);
});
