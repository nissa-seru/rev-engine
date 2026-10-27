import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Action's shell steps, run as bash runs them, with GitHub's environment and the gh CLI stood in.
const ACTION = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
const WORKFLOW = readFileSync(new URL("../.github/workflows/org-review.yml", import.meta.url), "utf8");
/** The Action's own directory, as GITHUB_ACTION_PATH names it to its steps. */
const ROOT = new URL("..", import.meta.url).pathname;

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

/** A step's block of the Action (or the given file): from its `- name:` line to the next step's, as written. */
function stepBlock(name: string, source = ACTION): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `no step named ${name}`);
  const indent = lines[start]!.search(/\S/);
  const end = lines.findIndex((line, index) => index > start && line.search(/\S/) === indent && line.trim().startsWith("- "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function runStep(name: string, env: Record<string, string>, setup?: (temp: string) => void, options: { source?: string; cwd?: string; errexit?: boolean } = {}): { outputs: Record<string, string>; stdout: string; temp: string } {
  const temp = mkdtempSync(join(tmpdir(), "action-step-"));
  const output = join(temp, "github-output");
  writeFileSync(output, "");
  setup?.(temp);
  const stdout = execFileSync("bash", [...(options.errexit ? ["-e"] : []), "-c", stepScript(name, options.source)], {
    env: { PATH: `${join(temp, "bin")}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_WORKSPACE: temp, GITHUB_OUTPUT: output, ...env },
    encoding: "utf8",
    ...(options.cwd ? { cwd: join(temp, options.cwd) } : {}),
  });
  const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]));
  return { outputs, stdout, temp };
}

/** What a step that failed printed: its stdout, which holds its ::error:: line, not the script execFileSync quotes. */
function failedOutput(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { stdout?: unknown }).stdout ?? "");
  }
  assert.fail("the step didn't fail");
}

/** A stand-in for a program on the step's PATH: a bash script run with the step's arguments. */
function stub(temp: string, name: string, script: string): void {
  mkdirSync(join(temp, "bin"), { recursive: true });
  writeFileSync(join(temp, "bin", name), `#!/bin/bash\n${script}\n`);
  chmodSync(join(temp, "bin", name), 0o755);
}

/** Asserts that a step of the Action (or the given file) holds this line, as written. */
function bound(step: string, line: string, source = ACTION): void {
  assert.ok(stepBlock(step, source).split("\n").some((each) => each.trim() === line), `${step}: ${line}`);
}

/** Opens a seal with a model key, as INSTALL.md's command does, and returns the files it holds. */
function openSealed(file: string, key: string): Record<string, string> {
  return sealedFiles(`openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -pass env:MODEL_API_KEY -in "${file}"`, { MODEL_API_KEY: key });
}

/** The real tar, for a stand-in that writes its archive whole and then fails, as tar does when it couldn't read a file. */
const TAR = execFileSync("bash", ["-c", "command -v tar"], { encoding: "utf8" }).trim();

function failingTar(temp: string): void {
  stub(temp, "tar", `"${TAR}" "$@"; exit 2`);
}

/** Files a sealed tar holds, opened as `open` (a shell command reading the sealed bytes on stdin) writes the tar. */
function sealedFiles(open: string, env: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "action-open-"));
  execFileSync("bash", ["-c", `set -euo pipefail; ${open} | tar -C "${dir}" -xf -`], { env: { ...process.env, ...env } });
  const files: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const name of readdirSync(at, { withFileTypes: true })) {
      if (name.isDirectory()) walk(join(at, name.name), `${prefix}${name.name}/`);
      else files[`${prefix}${name.name}`] = readFileSync(join(at, name.name), "utf8");
    }
  };
  walk(dir, "");
  return files;
}

test("a stopped review's answers are gathered only where GitHub lets the run write its cache", () => {
  const wrotePlan = (temp: string) => {
    mkdirSync(join(temp, "rev-engine-prime/out/shape"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/out/shape/shape-plan.json"), "{}");
  };
  // A run step never sees the runner's ACTIONS_CACHE_MODE, so the event alone decides.
  const cases: Array<[string, Record<string, string>]> = [
    ["workflow_dispatch", { kept: "true" }],
    ["pull_request_target", { readonly: "true" }],
    ["issue_comment", { readonly: "true" }],
    ["pull_request", { readonly: "true" }],
  ];
  for (const [event, expected] of cases) {
    assert.deepEqual(runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: event, SEAL_KEY: "model-key", GITHUB_ACTION_PATH: ROOT }, wrotePlan).outputs, expected, event);
  }
  assert.deepEqual(runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: "workflow_dispatch" }).outputs, {}, "a run that wrote no plan keeps nothing new");
  const restoredOnly = (temp: string) => {
    mkdirSync(join(temp, "rev-engine-prime/kept"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/kept/shape-plan.json"), "{}");
  };
  assert.deepEqual(runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: "pull_request_target" }, restoredOnly).outputs, {}, "a restored plan with no new one is neither kept again nor blamed on the cache");
  // What an earlier run kept was restored to the same place: the new answers replace it whole.
  const { temp } = runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: "workflow_dispatch", SEAL_KEY: "model-key", GITHUB_ACTION_PATH: ROOT }, (temp) => {
    wrotePlan(temp);
    restoredOnly(temp);
    writeFileSync(join(temp, "rev-engine-prime/kept/shape-plan.json"), "stale");
    writeFileSync(join(temp, "rev-engine-prime/kept/stale-answer.json"), "stale");
  });
  assert.deepEqual(readdirSync(join(temp, "rev-engine-prime/kept")), ["kept.tar.enc"], "only the sealed answers are kept, nothing restored beside them");
  assert.deepEqual(openSealed(join(temp, "rev-engine-prime/kept/kept.tar.enc"), "model-key"), { "shape-plan.json": "{}" }, "sealed with the model key: the new plan is what's kept");
  assert.throws(() => runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: "workflow_dispatch", SEAL_KEY: "model-key", GITHUB_ACTION_PATH: ROOT }, (temp) => {
    wrotePlan(temp);
    failingTar(temp);
  }), "answers tar couldn't read whole aren't kept (pipefail)");
  assert.throws(() => runStep("Gather a stopped review's answers", { GITHUB_EVENT_NAME: "workflow_dispatch", SEAL_KEY: "", GITHUB_ACTION_PATH: ROOT }, wrotePlan), "no key to seal with fails the step rather than keeping the answers in the clear");
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
  const workspace = mkdtempSync(join(tmpdir(), "action-round-"));
  const checkout = join(workspace, "rev-engine-prime-checkout");
  const git = (...args: string[]) => execFileSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  mkdirSync(checkout);
  git("init", "-q");
  const tree = git("hash-object", "-t", "tree", "-w", "/dev/null");
  const earlier = git("commit-tree", tree, "-m", "earlier");
  const later = git("commit-tree", tree, "-p", earlier, "-m", "later");
  const since = { ...env, HEAD: later, GITHUB_WORKSPACE: workspace };
  const earlierReview = reviews([summary(`<!-- rev-engine-shape-review re-o.r-7-08 ${earlier} -->`)]);
  assert.deepEqual(runStep("Find the review's round", { ...since, BATTERY_A: "terra" }, earlierReview).outputs, { round: "9", "round-of": "re-o.r-7-08", base: earlier }, "on terra, only what changed since");
  assert.deepEqual(runStep("Find the review's round", { ...since, BATTERY_A: "sol" }, earlierReview).outputs, { round: "9", "round-of": "", base: "b".repeat(40) }, "on Sol, the whole pull request, whichever battery read the last review");
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
    runStep("Say that the review stopped", { REPO: "o/r", NUMBER: "7", RUN: "https://x/run", DEFAULT_BRANCH: "main", GITHUB_REF: "refs/heads/main", GH_TOKEN: "t", CATEGORY: "", KEPT: "", READONLY: "", EVENT_NAME: "pull_request_target", OFF_LABEL: "", COMMAND: "/review", ...env }, (temp) => {
      mkdirSync(join(temp, "bin"), { recursive: true });
      writeFileSync(join(temp, "bin/gh"), `#!/bin/bash\nwhile [ "$1" != --body ]; do shift; done\nprintf '%s' "$2" > "${join(temp, "body")}"\n`);
      chmodSync(join(temp, "bin/gh"), 0o755);
      body = join(temp, "body");
    });
    return readFileSync(body, "utf8");
  };
  // actions/cache's save warns and succeeds when the cache refuses it, so what was kept is said as asked of the cache, with where to look.
  assert.match(said({ STOP: "unavailable", KEPT: "true" }), /It asked GitHub's cache to keep what it has read \(the run's log says if the cache refused\)/);
  assert.match(said({ STOP: "unavailable", BATTERY_A: "terra" }), /^This review stopped before it finished, because Terra, one of its two readers, couldn't take its calls\. /);
  assert.match(said({ STOP: "unavailable", BATTERY_A: "sol", COMMAND: "/review deep" }), /^This review stopped before it finished, because Sol, one of its two readers, couldn't take its calls\. A later run of this head from the same base, which a \/review deep comment/);
  assert.match(said({ STOP: "time", READONLY: "true" }), /This run kept nothing for a later run to go on from: only a manual run keeps a stopped review's answers\./);
  assert.doesNotMatch(said({ STOP: "time" }), /GitHub's cache|kept nothing/, "nothing to keep is no cache's doing");
  // The command the caller configured, wherever the notice names one.
  const configured = said({ STOP: "time", KEPT: "true", COMMAND: "/check" });
  assert.match(configured, /which a \/check comment from someone with write access starts/);
  assert.doesNotMatch(configured, /\/review/);
  assert.match(said({ STOP: "refused", CATEGORY: "cyber_policy", COMMAND: "/check" }), /a \/check comment may meet the same refusal/);
  assert.match(said({ STOP: "time", COMMAND: "/check" }), /which a \/check comment from someone with write access starts, goes on from what an earlier run of it kept/, "and with nothing kept");
  assert.match(said({ STOP: "unavailable", KEPT: "true", GITHUB_REF: "refs/heads/dev" }), /a later manual run of this head on dev; a \/review comment runs on the default branch, where what this run kept isn't, and goes on from what a run there kept, if any, or reads it from the start\./);
  assert.match(said({ STOP: "refused", CATEGORY: "cyber_policy" }), /refused one of its calls \(category: cyber_policy\)\. It won't go on by itself, and a \/review comment may meet the same refusal\./);
  assert.ok(said({ STOP: "time" }).endsWith("The run: https://x/run\n\n<!-- rev-engine-prime -->"), "the marker tells a later review it's this Action's own post");
  // The off label put on meanwhile keeps the notice off the thread, as it keeps the review, unless a comment asked.
  const labelled = (event: string, labels: string, label = "no-automated-review") => runStep("Say that the review stopped", { REPO: "o/r", NUMBER: "7", RUN: "https://x/run", DEFAULT_BRANCH: "main", GITHUB_REF: "refs/heads/main", GH_TOKEN: "t", CATEGORY: "", KEPT: "", READONLY: "", STOP: "time", EVENT_NAME: event, OFF_LABEL: label, COMMAND: "/review" }, (temp) => {
    stub(temp, "gh", `if [ "$1" = api ]; then ${labels}; exit; fi\nwhile [ "$1" != --body ]; do shift; done\nprintf '%s' "$2" > "${join(temp, "body")}"`);
  });
  const quiet = labelled("pull_request_target", "printf '%s\\n' bug no-automated-review");
  assert.ok(!existsSync(join(quiet.temp, "body")));
  assert.match(quiet.stdout, /::notice::Not posted: pull request 7 now carries the label no-automated-review, so its review stopping isn't said there\. A comment of \/review reviews it again\./);
  assert.ok(existsSync(join(labelled("issue_comment", "printf '%s\\n' no-automated-review").temp, "body")), "a review a comment asked for says it stopped");
  assert.ok(existsSync(join(labelled("pull_request_target", "printf '%s\\n' no-automated-reviews").temp, "body")), "only the label itself counts");
  assert.ok(existsSync(join(labelled("pull_request_target", "printf '%s\\n' holdx", "hold.*").temp, "body")), "a label of the caller's own naming, taken literally");
  assert.ok(!existsSync(join(labelled("pull_request_target", "printf '%s\\n' 'hold.*'", "hold.*").temp, "body")), "and matched as itself");
  assert.throws(() => labelled("pull_request_target", "exit 1"), "a failed label lookup fails the step rather than posting past it");
  const workflow = runStep("Say that the review stopped", { REPO: "o/r", NUMBER: "7", RUN: "https://x/run", GH_TOKEN: "t" }, (temp) => {
    stub(temp, "gh", `while [ "$1" != --body ]; do shift; done\nprintf '%s' "$2" > "${join(temp, "body")}"`);
  }, { source: WORKFLOW });
  assert.ok(readFileSync(join(workflow.temp, "body"), "utf8").endsWith("The run's log says why: https://x/run\n\n<!-- rev-engine-prime -->"), "and the shared workflow's stop notice too");
});

test("the dependencies job installs each lockfile with its own installer, and only a root with none from package.json's ranges", () => {
  const install = (files: string[], leaves: "files" | "nothing" | "links" = "files") => runStep("Install the dependencies, scripts off, in a container", {}, (temp) => {
    mkdirSync(join(temp, "head"));
    for (const file of files) writeFileSync(join(temp, "head", file), "{}");
    // What the head itself commits at node_modules, a ranges marker among it, is never passed on.
    mkdirSync(join(temp, "head/node_modules/committed"), { recursive: true });
    writeFileSync(join(temp, "head/node_modules/.installed-from-ranges"), "");
    // docker as the install leaves it: node_modules with a package, and a link a lockfile could ask for.
    stub(temp, "docker", `printf '%s\\n' "$@" > "${join(temp, "docker-args")}"\n${{ files: `mkdir -p node_modules/pkg && echo x > node_modules/pkg/index.js && ln -s /proc/self/environ node_modules/env`, links: `mkdir -p node_modules && ln -s /proc/self/environ node_modules/env`, nothing: "" }[leaves]}`);
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
  const empty = install(["package.json"], "nothing");
  assert.deepEqual(empty.outputs, {}, "an install that leaves no node_modules passes nothing on, and doesn't fail");
  assert.match(empty.stdout, /::notice::The install left no node_modules/);
  const onlyLinks = install(["package.json", "package-lock.json"], "links");
  assert.deepEqual(onlyLinks.outputs, {}, "an install that leaves nothing but links passes nothing on, since an upload of no files makes no artifact");
  assert.match(onlyLinks.stdout, /::notice::The install left no files in node_modules/);
});

test("a consumer that can't be cloned, or isn't owner/name, is said and the rest are still read", () => {
  const { stdout, temp } = runStep("Check out the consumers", { CONSUMERS: "o/gone ../x o/kept o/kept" }, (temp) => {
    mkdirSync(join(temp, "rev-engine-prime-checkout"));
    // A clone that fails partway leaves what it wrote.
    stub(temp, "git", `for last; do :; done\nmkdir -p "$last"\ncase "$*" in *o/gone.git*) touch "$last/partial"; exit 128 ;; esac`);
  });
  assert.deepEqual(readdirSync(join(temp, "rev-engine-prime-checkout/.consumers")), ["o__kept"], "nothing of a failed clone is left to read");
  assert.deepEqual(readdirSync(join(temp, "rev-engine-prime-checkout/.consumers/o__kept")), [], "a consumer named twice keeps its first clone");
  assert.match(stdout, /::notice::consumers: o\/kept is named more than once, and is read once/);
  assert.match(stdout, /::warning::consumers: o\/gone couldn't be cloned \(a misspelt name, or a repository this job can't read\), so the review reads without it/);
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

test("the off label skips a review nobody asked for by comment, and keeps one from posting when it's put on meanwhile", () => {
  const head = "c".repeat(40);
  const pull = (labels: string[]) => (temp: string) => {
    // gh as GitHub answers: the pull request, with these labels, and write access for the commenter.
    writeFileSync(join(temp, "pull.json"), JSON.stringify({ base: { sha: "b".repeat(40) }, head: { sha: head, repo: { full_name: "o/r" } }, title: "t", body: "", labels: labels.map((name) => ({ name })) }));
    stub(temp, "gh", `case "$2" in *collaborators*) echo write ;; *) cat "${join(temp, "pull.json")}" ;; esac`);
  };
  const ask = (event: string, labels: string[], extra: Record<string, string> = {}) => runStep("Check who asked", {
    GH_TOKEN: "t", REPO: "o/r", EVENT_NAME: event, ACTOR: "ann", COMMENT: "/review", COMMENT_ON_PR: "https://api.github.com/repos/o/r/pulls/7", EVENT_NUMBER: "7",
    INPUT_NUMBER: "", COMMAND: "/review", ALLOW_FORKS: "false", AUTHORS: "any", PIPELINE: "shape", OFF_LABEL: "no-automated-review", MODEL_API_KEY: "k", GITHUB_ACTION_PATH: ROOT, ...extra,
  }, pull(labels));
  const skipped = ask("pull_request_target", ["bug", "no-automated-review"]);
  assert.equal(skipped.outputs.run, "false");
  assert.match(skipped.stdout, /::notice::No review: pull request 7 carries the label no-automated-review; comment \/review on it to review it/);
  assert.equal(ask("workflow_dispatch", ["no-automated-review"], { INPUT_NUMBER: "7" }).outputs.run, "false", "a dispatched run, such as a resume, is skipped too");
  assert.equal(ask("issue_comment", ["no-automated-review"]).outputs.run, "true", "a comment asking for a review still has it");
  assert.equal(ask("issue_comment", ["bug"], { COMMAND: "/review deep", COMMENT: "/review deep\r\nThe auth part, please." }).outputs.run, "true", "a command with a note on the next line asks too");
  assert.equal(ask("issue_comment", ["bug"], { COMMAND: "/review deep", COMMENT: "/review deeper" }).outputs.run, "false", "but not a longer word");
  assert.equal(ask("pull_request_target", ["bug"]).outputs.run, "true");
  assert.equal(ask("pull_request_target", ["no-automated-review"], { OFF_LABEL: "" }).outputs.run, "true", "an empty off-label turns nothing off");
  // The shape saves its run only sealed with the model key, so it doesn't start without one.
  assert.match(failedOutput(() => ask("pull_request_target", ["bug"], { MODEL_API_KEY: "" })), /::error::The review shape needs model-api-key, which also seals what it saves, so no review runs/);
  assert.equal(ask("pull_request_target", ["bug"], { PIPELINE: "reader", MODEL_API_KEY: "" }).outputs.run, "true", "the reader saves nothing of the kind, and needs no key");

  const post = (event: string, labels: string[], label = "no-automated-review") => runStep("Post the review", {
    GITHUB_TOKEN: "t", RB_NWO: "o/r", RB_PR_NUMBER: "7", RB_HEAD: head, SHAPE: "on", EVENT_NAME: event, OFF_LABEL: label, COMMAND: "/review", GITHUB_ACTION_PATH: "/action",
  }, (temp) => {
    stub(temp, "gh", `printf '%s\\n' ${labels.map((label) => `'${label}'`).join(" ")}`);
    stub(temp, "docker", `echo posted > "${join(temp, "posted")}"`);
  });
  const late = post("pull_request_target", ["no-automated-review"]);
  assert.ok(!existsSync(join(late.temp, "posted")));
  assert.match(late.stdout, /::notice::Not posted: pull request 7 now carries the label no-automated-review\. The review's results are saved with this run, and a comment of \/review reviews it again and posts\./);
  assert.ok(existsSync(join(post("issue_comment", ["no-automated-review"]).temp, "posted")), "a review a comment asked for posts");
  assert.ok(existsSync(join(post("pull_request_target", ["no-automated-reviews", "bug"]).temp, "posted")), "only the label itself counts");
  const unlabelled = runStep("Post the review", { GITHUB_TOKEN: "t", RB_NWO: "o/r", RB_PR_NUMBER: "7", RB_HEAD: head, SHAPE: "on", EVENT_NAME: "pull_request_target", OFF_LABEL: "", GITHUB_ACTION_PATH: "/action" }, (temp) => {
    stub(temp, "gh", "exit 1");
    stub(temp, "docker", `echo posted > "${join(temp, "posted")}"`);
  });
  assert.ok(existsSync(join(unlabelled.temp, "posted")), "an empty off-label holds nothing back at posting, and asks GitHub for no labels");
  assert.ok(!existsSync(join(post("pull_request_target", ["hold.*"], "hold.*").temp, "posted")), "a label of the caller's own naming, taken literally");
  assert.ok(existsSync(join(post("pull_request_target", ["holdx"], "hold.*").temp, "posted")), "matched as itself, not as a pattern");
  assert.equal(ask("pull_request_target", ["skip me"], { OFF_LABEL: "skip me" }).outputs.run, "false", "the ask step reads the caller's own label");
  assert.equal(ask("pull_request_target", ["skip-me"], { OFF_LABEL: "skip.me" }).outputs.run, "true", "as itself");
  assert.throws(() => runStep("Post the review", { GITHUB_TOKEN: "t", RB_NWO: "o/r", RB_PR_NUMBER: "7", SHAPE: "", EVENT_NAME: "pull_request_target", OFF_LABEL: "no-automated-review", GITHUB_ACTION_PATH: "/action" }, (temp) => {
    stub(temp, "gh", "exit 1");
    stub(temp, "docker", `echo posted > "${join(temp, "posted")}"`);
  }), "a failed label lookup fails the step rather than posting past it");
});

test("the shape's run is saved sealed with the model key, and opens only with it", () => {
  const run = (key: string, out = true, step = "Seal the review shape's run") => runStep(step, { SEAL_KEY: key, GITHUB_ACTION_PATH: ROOT }, (temp) => {
    if (!out) return;
    mkdirSync(join(temp, "rev-engine-prime/out/shape/re-o.n-7-1/answers"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/out/shape/run.json"), '{"outcome":"done"}');
    writeFileSync(join(temp, "rev-engine-prime/out/shape/re-o.n-7-1/answers/A-t.json"), "held text");
  });
  const { outputs, temp } = run("model-key");
  assert.deepEqual(outputs, { sealed: "true" });
  const sealed = join(temp, "rev-engine-prime/sealed");
  assert.deepEqual(readdirSync(sealed), ["shape.tar.enc"], "the upload holds the seal and nothing in the clear");
  assert.ok(!readFileSync(join(sealed, "shape.tar.enc")).includes("held text"));
  assert.deepEqual(openSealed(join(sealed, "shape.tar.enc"), "model-key"), { "run.json": '{"outcome":"done"}', "re-o.n-7-1/answers/A-t.json": "held text" });
  assert.throws(() => openSealed(join(sealed, "shape.tar.enc"), "another key"), "another key doesn't open it");
  // Each seal its own salt, which openssl writes after "Salted__" at its start: compared there, not in bytes a tar's
  // times could make differ.
  const other = join(run("model-key").temp, "rev-engine-prime/sealed/shape.tar.enc");
  const start = (file: string) => readFileSync(file).subarray(0, 16);
  assert.equal(start(join(sealed, "shape.tar.enc")).subarray(0, 8).toString("latin1"), "Salted__");
  assert.ok(!start(join(sealed, "shape.tar.enc")).subarray(8).equals(start(other).subarray(8)), "two seals' salts differ");
  assert.deepEqual(run("model-key", false).outputs, {}, "a review that wrote no run seals nothing, and nothing is uploaded");
  const left = runStep("Seal the review shape's run", { SEAL_KEY: "model-key", GITHUB_ACTION_PATH: ROOT }, (temp) => {
    mkdirSync(join(temp, "rev-engine-prime/sealed"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/sealed/shape.tar.enc"), "a seal from before");
  });
  assert.deepEqual(left.outputs, {}, "a seal already there is no seal of this run");
  assert.ok(!existsSync(join(left.temp, "rev-engine-prime/sealed/shape.tar.enc")));
  assert.throws(() => run(""), "no key to seal with fails the step rather than saving the run in the clear");
  assert.throws(() => run(" \n"), "nor does a key of whitespace alone");
  // A secret pasted with its line end seals with the key as the model client and an opener read it, trimmed.
  const padded = run(" model-key\n");
  assert.deepEqual(openSealed(join(padded.temp, "rev-engine-prime/sealed/shape.tar.enc"), "model-key"), { "run.json": '{"outcome":"done"}', "re-o.n-7-1/answers/A-t.json": "held text" });
  // After posting, the run is sealed again the same way, with what the post wrote into it, in the first seal's place.
  const again = runStep("Seal it again with its comments", { SEAL_KEY: "model-key", GITHUB_ACTION_PATH: ROOT }, (temp) => {
    mkdirSync(join(temp, "rev-engine-prime/out/shape/re-o.n-7-1"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/out/shape/re-o.n-7-1/posted.json"), '{"I1":9001}');
    mkdirSync(join(temp, "rev-engine-prime/sealed"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/sealed/shape.tar.enc"), "the first seal");
  });
  assert.deepEqual(again.outputs, { sealed: "true" });
  assert.deepEqual(readdirSync(join(again.temp, "rev-engine-prime/sealed")), ["shape.tar.enc"]);
  assert.deepEqual(openSealed(join(again.temp, "rev-engine-prime/sealed/shape.tar.enc"), "model-key"), { "re-o.n-7-1/posted.json": '{"I1":9001}' }, "the first seal is replaced");
  // A file tar can't read fails the step (pipefail), rather than sealing a run with it left out.
  assert.throws(() => runStep("Seal the review shape's run", { SEAL_KEY: "model-key", GITHUB_ACTION_PATH: ROOT }, (temp) => {
    mkdirSync(join(temp, "rev-engine-prime/out/shape"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/out/shape/run.json"), "{}");
    failingTar(temp);
  }), "a run tar couldn't read whole isn't sealed");
});

test("what a stopped review kept opens with the model key, and anything else restored is set aside", () => {
  const keep = (temp: string, key: string) => {
    mkdirSync(join(temp, "rev-engine-prime/out/shape"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/out/shape/shape-plan.json"), "{}");
    mkdirSync(join(temp, "rev-engine-prime/kept"), { recursive: true });
    execFileSync("bash", ["-c", `tar -C "${join(temp, "rev-engine-prime/out/shape")}" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -salt -pass env:KEPT_KEY -out "${join(temp, "rev-engine-prime/kept/kept.tar.enc")}"`], { env: { ...process.env, KEPT_KEY: key } });
  };
  const opened = runStep("Open a stopped review's answers", { KEPT_KEY: "model-key" }, (temp) => keep(temp, "model-key"));
  assert.deepEqual(readdirSync(join(opened.temp, "rev-engine-prime/kept")), ["shape-plan.json"], "the answers are where the review reads them");
  const paddedKey = runStep("Open a stopped review's answers", { KEPT_KEY: "model-key\n" }, (temp) => keep(temp, "model-key"));
  assert.deepEqual(readdirSync(join(paddedKey.temp, "rev-engine-prime/kept")), ["shape-plan.json"], "a key with its line end opens what the trimmed key sealed");
  assert.ok(!existsSync(join(opened.temp, "rev-engine-prime/kept.tar.enc")));
  const wrong = runStep("Open a stopped review's answers", { KEPT_KEY: "model-key" }, (temp) => keep(temp, "another key"));
  assert.ok(!existsSync(join(wrong.temp, "rev-engine-prime/kept")), "a seal the key doesn't open leaves nothing to resume from");
  assert.match(wrong.stdout, /::warning::What a stopped review kept doesn't open with this repository's model key, so the review reads from the start/);
  // A seal cut short: openssl fails at its last block while tar may still read what came before (pipefail).
  const short = runStep("Open a stopped review's answers", { KEPT_KEY: "model-key" }, (temp) => {
    keep(temp, "model-key");
    const file = join(temp, "rev-engine-prime/kept/kept.tar.enc");
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length - 16));
  });
  assert.ok(!existsSync(join(short.temp, "rev-engine-prime/kept")), "a seal cut short leaves nothing to resume from");
  assert.match(short.stdout, /::warning::What a stopped review kept doesn't open/);
  const plain = runStep("Open a stopped review's answers", { KEPT_KEY: "model-key" }, (temp) => {
    mkdirSync(join(temp, "rev-engine-prime/kept"), { recursive: true });
    writeFileSync(join(temp, "rev-engine-prime/kept/shape-plan.json"), "{}");
  });
  assert.ok(!existsSync(join(plain.temp, "rev-engine-prime/kept")), "answers kept in the clear, as before sealing, aren't read");
  assert.match(plain.stdout, /::notice::What was restored for this review isn't sealed/);
  assert.deepEqual(runStep("Open a stopped review's answers", { KEPT_KEY: "model-key" }).stdout, "", "nothing restored, nothing to say");
});

test("each value a step reads is bound from the input or variable it stands for", () => {
  bound("Check who asked", "OFF_LABEL: ${{ inputs.off-label }}");
  bound("Check who asked", "MODEL_API_KEY: ${{ inputs.model-api-key }}");
  bound("Check who asked", "COMMENT: ${{ github.event.comment.body }}", WORKFLOW);
  bound("Check who asked", "NUMBER: ${{ github.event.issue.number }}", WORKFLOW);
  bound("Check who asked", "RUN: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}", WORKFLOW);
  bound("Check who asked", "DEFAULT_PIPELINE: ${{ vars.REVIEW_PIPELINE }}", WORKFLOW);
  bound("Post the review", "DEEP_COMMAND: ${{ (inputs.pipeline != 'shape' || inputs.battery-a != 'sol') && inputs.deep-command || '' }}");
  bound("Say that the review stopped", "BATTERY_A: ${{ inputs.battery-a }}");
  bound("Review", "RB_SHAPE_BATTERY_A: ${{ inputs.battery-a }}");
  bound("Review", "RB_RESPONSES_BASE_URL: ${{ inputs.responses-base-url }}");
  assert.match(stepScript("Review"), /-e RB_RESPONSES_BASE_URL -e RB_SHAPE_BATTERY_A /, "the review's container is given both");
  bound("Check who asked", "AUTHOR: ${{ github.event.pull_request.user.login }}", WORKFLOW);
  bound("Check who asked", "SKIP_AUTHORS: ${{ vars.REVIEW_SKIP_AUTHORS }}", WORKFLOW);
  bound("Review", "responses-base-url: ${{ vars.RESPONSES_BASE_URL }}", WORKFLOW);
  bound("Review", "battery-a: ${{ needs.who.outputs.battery-a }}", WORKFLOW);
  bound("Post the review", "OFF_LABEL: ${{ inputs.off-label }}");
  bound("Say that the review stopped", "OFF_LABEL: ${{ inputs.off-label }}");
  bound("Say that the review stopped", "EVENT_NAME: ${{ github.event_name }}");
  bound("Say that the review stopped", "COMMAND: ${{ inputs.command }}");
  bound("Post the review", "EVENT_NAME: ${{ github.event_name }}");
  bound("Post the review", "COMMAND: ${{ inputs.command }}");
  bound("Post the review", "GITHUB_SERVER_URL: ${{ github.server_url }}");
  assert.match(stepScript("Post the review"), /-e GITHUB_SERVER_URL /, "the posting container is given it");
  bound("Collect earlier decisions", "KNOWN_PATH: ${{ inputs.pipeline == 'shape' && '/work/pr/known.json' || '' }}");
  assert.match(stepScript("Collect earlier decisions"), /-e KNOWN_PATH /, "the collector's container is given it");
  bound("Open a stopped review's answers", "KEPT_KEY: ${{ inputs.model-api-key }}");
  bound("Gather a stopped review's answers", "SEAL_KEY: ${{ inputs.model-api-key }}");
  bound("Seal the review shape's run", "SEAL_KEY: ${{ inputs.model-api-key }}");
  bound("Seal the review shape's run", "if: steps.ask.outputs.run == 'true' && inputs.pipeline == 'shape' && !cancelled()");
  bound("Save the review shape's run", "path: ${{ runner.temp }}/rev-engine-prime/sealed", ACTION);
  bound("Save the review shape's run", "if: steps.seal.outputs.sealed == 'true' && !cancelled()");
  bound("Seal it again with its comments", "SEAL_KEY: ${{ inputs.model-api-key }}");
  bound("Seal it again with its comments", "if: steps.seal.outputs.sealed == 'true' && !cancelled() && (steps.post.outcome == 'success' || steps.post.outcome == 'failure')");
  bound("Save it again with its comments", "path: ${{ runner.temp }}/rev-engine-prime/sealed");
  bound("Save it again with its comments", "if: steps.reseal.outputs.sealed == 'true' && !cancelled()");
  // Each attempt's saves, and each of its two, under a name of its own, never over another: upload-artifact deletes a
  // same-named artifact before it uploads (overwrite), and without overwrite fails on the name (its v4 README).
  bound("Save the review shape's run", "name: rev-engine-shape-${{ steps.ask.outputs.number }}-${{ steps.round.outputs.round }}-${{ github.run_attempt }}");
  bound("Save it again with its comments", "name: rev-engine-shape-${{ steps.ask.outputs.number }}-${{ steps.round.outputs.round }}-${{ github.run_attempt }}-posted");
  for (const step of ["Save the review shape's run", "Save it again with its comments"]) {
    bound(step, "if-no-files-found: error");
    assert.doesNotMatch(stepBlock(step, ACTION), /overwrite/, `${step} saves over nothing`);
  }
  // Posting has no status function, so it waits on success(): a failed save before it stops the post.
  bound("Post the review", "if: steps.ask.outputs.run == 'true' && steps.review.outputs.status != '3'");
  bound("Post the review", "id: post");
  bound("Save the review", "if: steps.ask.outputs.run == 'true' && inputs.pipeline != 'shape' && !cancelled()");
  // The sealed run is saved before anything is posted on the pull request, and sealed again after the review is.
  const at = (step: string) => ACTION.indexOf(`- name: ${step}\n`);
  assert.ok(at("Save the review shape's run") < at("Say that the review stopped") && at("Say that the review stopped") < at("Post the review") && at("Post the review") < at("Seal it again with its comments"));
  bound("Review", "model-api-key: ${{ secrets.MODEL_API_KEY }}", WORKFLOW);
  assert.match(ACTION, /\n  off-label:\n    description: [^\n]+\n    default: no-automated-review\n/);
});

test("the shared workflow reviews a write-access /review deep comment with the shape, and every other review with the repository's default", () => {
  const deep = /^  DEEP_COMMAND: (.+)$/m.exec(WORKFLOW)?.[1];
  const plain = /^  REVIEW_COMMAND: (.+)$/m.exec(WORKFLOW)?.[1];
  assert.equal(deep, "/review deep");
  assert.equal(plain, "/review");
  const ask = (event: string, comment: string, defaultPipeline = "", permission = "write", commands = { REVIEW_COMMAND: plain!, DEEP_COMMAND: deep! }) => runStep("Check who asked", {
    EVENT_NAME: event, COMMENT: comment, DEFAULT_PIPELINE: defaultPipeline, ...commands, REPO: "o/r", ACTOR: "someone", GH_TOKEN: "t",
  }, (temp) => stub(temp, "gh", `echo ${permission}`), { source: WORKFLOW }).outputs;
  assert.deepEqual(ask("issue_comment", "/review deep"), { pipeline: "shape", command: "/review deep", "battery-a": "sol", allowed: "true" });
  assert.deepEqual(ask("issue_comment", "/review deep please, the auth part"), { pipeline: "shape", command: "/review deep", "battery-a": "sol", allowed: "true" });
  assert.deepEqual(ask("issue_comment", "/review deep\r\nThe auth part, please."), { pipeline: "shape", command: "/review deep", "battery-a": "sol", allowed: "true" }, "a note on the next line, as GitHub's editor sends it");
  assert.deepEqual(ask("issue_comment", "/review"), { pipeline: "reader", command: "/review", "battery-a": "terra", allowed: "true" });
  assert.deepEqual(ask("issue_comment", "/review deeper"), { pipeline: "reader", command: "/review", "battery-a": "terra", allowed: "true" }, "only the word itself");
  assert.deepEqual(ask("issue_comment", "/review\r\nThe auth part, please."), { pipeline: "reader", command: "/review", "battery-a": "terra", allowed: "true" }, "a line break after the command, as after the deep one");
  assert.deepEqual(ask("issue_comment", "/reviewer, could you look?"), {}, "a comment that only begins like the command asks for nothing");
  assert.match(failedOutput(() => ask("issue_comment", "/review deep", "", "write", { REVIEW_COMMAND: plain!, DEEP_COMMAND: "" })), /::error::The workflow's REVIEW_COMMAND or DEEP_COMMAND is empty/, "an empty command fails rather than taking a deep request as the reader's");
  assert.deepEqual(ask("issue_comment", "/review the deep parts"), { pipeline: "reader", command: "/review", "battery-a": "terra", allowed: "true" });
  assert.deepEqual(ask("issue_comment", "/review", "shape"), { pipeline: "shape", command: "/review", "battery-a": "terra", allowed: "true" }, "where the shape is the default");
  assert.deepEqual(ask("pull_request_target", ""), { pipeline: "reader", command: "/review", "battery-a": "terra", allowed: "true" });
  assert.deepEqual(ask("pull_request_target", "", "shape"), { pipeline: "shape", command: "/review", "battery-a": "terra", allowed: "true" });
  assert.deepEqual(ask("workflow_dispatch", ""), { pipeline: "reader", command: "/review", "battery-a": "terra", allowed: "true" }, "a manual run is the default's");
  assert.equal(ask("issue_comment", "/review deep", "", "read").allowed, undefined, "and asks write access, as /review does");
  assert.equal(ask("issue_comment", "/review deep", "", "triage").allowed, undefined);
});

test("a pull request opened by an author the caller lists isn't reviewed at open, and a comment or a manual run still reviews it", () => {
  const ask = (event: string, author: string, skip: string, comment = "") => runStep("Check who asked", {
    EVENT_NAME: event, COMMENT: comment, DEFAULT_PIPELINE: "shape", REVIEW_COMMAND: "/review", DEEP_COMMAND: "/review deep", REPO: "o/r", ACTOR: "someone", GH_TOKEN: "t",
    AUTHOR: author, SKIP_AUTHORS: skip,
  }, (temp) => {
    stub(temp, "gh", "echo write");
    // A file a careless glob of the list would expand to, in the step's working directory.
    mkdirSync(join(temp, "work"), { recursive: true });
    writeFileSync(join(temp, "work", "build-bott"), "");
  }, { source: WORKFLOW, cwd: "work" });
  const skip = "octo-dev build-bot[bot]";
  const skipped = ask("pull_request_target", "build-bot[bot]", skip);
  assert.equal(skipped.outputs.allowed, undefined, "a login with brackets matches itself, whatever the directory holds");
  assert.match(skipped.stdout, /::notice::No review: pull requests build-bot\[bot\] opens aren't reviewed when opened, reopened or marked ready \(REVIEW_SKIP_AUTHORS\); a \/review comment reviews one/);
  assert.equal(ask("pull_request_target", "octo-dev", skip).outputs.allowed, undefined);
  assert.equal(ask("pull_request_target", "build-bot[bot]", "  octo-dev\nbuild-bot[bot]\n").outputs.allowed, undefined, "spaces and line breaks separate the list's words");
  assert.equal(ask("pull_request_target", "build-bot[bot]", "build-bot[bot]\r\nocto-dev").outputs.allowed, undefined, "a line break as a browser's form sends it");
  assert.equal(ask("pull_request_target", "Octo-Dev", skip).outputs.allowed, undefined, "in any case, as GitHub's logins are");
  assert.equal(ask("pull_request_target", "octo-dev", "Octo-Dev").outputs.allowed, undefined, "a list written in another case too");
  assert.equal(ask("pull_request_target", "xocto-dev", skip).outputs.allowed, "true", "a login that only contains a listed one");
  assert.equal(ask("pull_request_target", "octo", skip).outputs.allowed, "true", "or is contained in one");
  assert.equal(ask("pull_request_target", "build-bott", skip).outputs.allowed, "true", "or matches a listed one as a glob");
  assert.equal(ask("pull_request_target", "someone", "").outputs.allowed, "true", "an empty list skips no one");
  assert.equal(ask("issue_comment", "octo-dev", skip, "/review").outputs.allowed, "true", "a /review comment on a listed author's pull request");
  assert.equal(ask("workflow_dispatch", "", skip).outputs.allowed, "true", "a manual run");
});

test("a deep review and a review on terra queue together and keep their stopped answers apart", () => {
  assert.ok(WORKFLOW.includes("\n      group: rev-engine-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr-number }}-${{ needs.who.outputs.pipeline }}\n"), "one group whatever battery A, so each counts its round on from the other's");
  bound("Restore a stopped review's answers", "key: rev-engine-shape-${{ inputs.battery-a }}-${{ steps.ask.outputs.number }}-${{ steps.ask.outputs.head }}-${{ steps.round.outputs.base }}");
  bound("Restore a stopped review's answers", "restore-keys: rev-engine-shape-${{ inputs.battery-a }}-${{ steps.ask.outputs.number }}-${{ steps.ask.outputs.head }}-${{ steps.round.outputs.base }}-");
  bound("Keep a stopped review's answers", "key: rev-engine-shape-${{ inputs.battery-a }}-${{ steps.ask.outputs.number }}-${{ steps.ask.outputs.head }}-${{ steps.round.outputs.base }}-${{ github.run_id }}-${{ github.run_attempt }}");
});

test("a write-access /review deep comment is answered as the run starts, and so is a /review the shape reviews, and no other request is", () => {
  const ask = (event: string, comment: string, options: { permission?: string; answer?: number; defaultPipeline?: string } = {}) => {
    const run = runStep("Check who asked", {
      EVENT_NAME: event, COMMENT: comment, NUMBER: "7", RUN: "https://github.com/o/r/actions/runs/9", DEFAULT_PIPELINE: options.defaultPipeline ?? "", REVIEW_COMMAND: "/review", DEEP_COMMAND: "/review deep", REPO: "o/r", ACTOR: "someone", GH_TOKEN: "t",
    }, (temp) => stub(temp, "gh", `if [ "$1 $2" = "pr comment" ]; then printf '%s\\0' "$@" > "$RUNNER_TEMP/answered"; exit ${options.answer ?? 0}; fi\necho ${options.permission ?? "write"}`), { source: WORKFLOW, errexit: true });
    const file = join(run.temp, "answered");
    return { outputs: run.outputs, stdout: run.stdout, answered: existsSync(file) ? readFileSync(file, "utf8").split("\0").slice(0, -1) : [] };
  };
  const deep = ask("issue_comment", "/review deep\r\nThe auth part, please.");
  assert.deepEqual(deep.answered, [
    "pr", "comment", "7", "--repo", "o/r", "--body",
    "A deep review of this pull request has been requested. It usually takes less than 30 minutes, though it may first wait for an earlier review of this pull request to finish. When it finishes, the review is posted on this pull request.\n\nThe run: https://github.com/o/r/actions/runs/9\n\n<!-- rev-engine-prime -->",
  ], "the answer carries the marker that tells the workflow's own posts from others' when a later review reads the thread");
  assert.deepEqual(deep.outputs, { pipeline: "shape", command: "/review deep", "battery-a": "sol", allowed: "true" });
  assert.deepEqual(ask("issue_comment", "/review").answered, [], "a plain /review");
  assert.deepEqual(ask("issue_comment", "/review\r\nThe auth part, please.", { defaultPipeline: "shape" }).answered, [
    "pr", "comment", "7", "--repo", "o/r", "--body",
    "A review of this pull request has been requested. It may first wait for an earlier review of this pull request to finish. When the requested review finishes, it's posted on this pull request.\n\nThe run: https://github.com/o/r/actions/runs/9\n\n<!-- rev-engine-prime -->",
  ], "a plain /review where the shape is the default, which reads with battery A on terra");
  assert.deepEqual(ask("issue_comment", "/review deep", { permission: "read" }).answered, [], "a comment from someone without write access, which runs nothing");
  assert.deepEqual(ask("pull_request_target", "").answered, []);
  assert.deepEqual(ask("workflow_dispatch", "").answered, []);
  const refused = ask("issue_comment", "/review deep", { answer: 1 });
  assert.deepEqual(refused.outputs, { pipeline: "shape", command: "/review deep", "battery-a": "sol", allowed: "true" }, "an answer GitHub refuses doesn't stop the review");
  assert.match(refused.stdout, /::warning::Could not answer the \/review deep comment; the review goes on/);
});

test("what follows the review's pipeline in the shared workflow reads the who job's choice, not the repository's default", () => {
  const readers = WORKFLOW.split("\n").filter((line) => line.includes("vars.REVIEW_PIPELINE"));
  assert.deepEqual(readers.map((line) => line.trim()), ["DEFAULT_PIPELINE: ${{ vars.REVIEW_PIPELINE }}"], "so a deep run gets the shape's dependencies, time limit and head wherever it runs");
});

test("the reader's review is posted from a container that's given the deep command, so the review can name it", () => {
  const head = "c".repeat(40);
  const posted = runStep("Post the review", {
    GITHUB_TOKEN: "t", RB_NWO: "o/r", RB_PR_NUMBER: "7", RB_HEAD: head, SHAPE: "", EVENT_NAME: "issue_comment", OFF_LABEL: "", COMMAND: "/review", DEEP_COMMAND: "/review deep", GITHUB_ACTION_PATH: "/action",
  }, (temp) => stub(temp, "docker", `printf '%s\\n' "$@" > "${join(temp, "docker-args")}"`));
  const args = readFileSync(join(posted.temp, "docker-args"), "utf8").split("\n");
  assert.ok(args.some((arg, index) => arg === "-e" && args[index + 1] === "DEEP_COMMAND"), args.join(" "));
});
