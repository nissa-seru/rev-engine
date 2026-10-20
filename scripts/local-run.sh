#!/usr/bin/env bash
#
# Builds the image and runs it on ReviewBench pull requests on this machine,
# through the benchmark's own scripts/try-agent.sh. Nothing is pushed anywhere.
#
#   scripts/local-run.sh <run-name> [--pr <index>] [--set test|full] [-e NAME[=VALUE] ...]
#
#   scripts/local-run.sh smoke --pr 0
#   JOBS=5 scripts/local-run.sh cheap -e RB_CONFIG_MODEL=vendor/model
#
# Needs a clone of https://github.com/review-bench/ReviewBench beside this
# repository, or at $REVIEWBENCH_DIR, and OPENROUTER_API_KEY in .env or the shell,
# or another model endpoint's RB_MODEL_* settings there (docs/SETTINGS.md).
# Results land in runs/<run-name>/, which git ignores.
#
# JOBS=<n> runs n pull requests of the test set at a time. The full set shares
# repository checkouts between pull requests, so it always runs one at a time.
# PRS=0,3,7 limits a test set run to those indexes.
set -euo pipefail

[ $# -ge 1 ] || { sed -n '6,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
name="$1"; shift

here="$(cd "$(dirname "$0")/.." && pwd)"
bench="${REVIEWBENCH_DIR:-$here/../ReviewBench}"
[ -x "$bench/scripts/try-agent.sh" ] || { echo "no ReviewBench clone at $bench; set REVIEWBENCH_DIR" >&2; exit 2; }

if [ -f "$here/.env" ]; then set -a; . "$here/.env"; set +a; fi
[ -n "${RB_MODEL_API_KEY:-${OPENROUTER_API_KEY:-}}" ] || { echo "OPENROUTER_API_KEY is not set, nor RB_MODEL_API_KEY" >&2; exit 2; }
# The endpoint's settings, each passed to the container only when it is set.
model_env=(-e OPENROUTER_API_KEY -e RB_MODEL_API_KEY -e RB_MODEL_BASE_URL -e RB_MODEL_API -e RB_MODEL_HEADERS)

image="${IMAGE:-rev-engine-prime:dev}"
docker build --quiet --platform linux/amd64 -t "$image" "$here" >/dev/null

run="$here/runs/$name"
mkdir -p "$run/logs" "$here/runs/.cache/repos" "$run/.try-agent"
# Share fetched repositories between runs; everything else stays per run.
[ -e "$run/.try-agent/repos" ] || ln -s "$here/runs/.cache/repos" "$run/.try-agent/repos"

# try-agent.sh runs each container on Docker's default network, which can't reach an
# endpoint on this machine's loopback, and it has no option for another network. For
# such an endpoint, the docker it calls runs its containers on the host's network.
# An -e RB_MODEL_BASE_URL=... option names the endpoint the containers get.
base_url="${RB_MODEL_BASE_URL:-}"
previous=""
for arg in "$@"; do
  if [ "$previous" = -e ]; then case "$arg" in RB_MODEL_BASE_URL=*) base_url="${arg#RB_MODEL_BASE_URL=}" ;; esac; fi
  previous="$arg"
done
host=$(sed -E 's#^[a-z]+://(\[[^]]*\]|[^/:]+).*#\1#' <<<"$base_url")
case "$host" in
  localhost|127.0.0.1|'[::1]')
    docker="$(command -v docker)"
    mkdir -p "$run/.bin"
    printf '#!/bin/sh\nif [ "$1" = run ]; then shift; exec "%s" run --network host "$@"; fi\nexec "%s" "$@"\n' "$docker" "$docker" > "$run/.bin/docker"
    chmod +x "$run/.bin/docker"
    export PATH="$run/.bin:$PATH"
    ;;
esac
cd "$run"

jobs="${JOBS:-1}"
prs="${PRS:-all}"
single=0
case " $* " in *" --pr "*|*" --set full "*) single=1 ;; esac

if [ "$single" -eq 1 ] || { [ "$jobs" -le 1 ] && [ "$prs" = all ]; }; then
  "$bench/scripts/try-agent.sh" "$image" "${model_env[@]}" -e RB_CONTEXT_OUT=/work/out/context.json "$@" 2>&1 | tee "logs/run.log"
  exit "${PIPESTATUS[0]}"
fi

if [ "$prs" = all ]; then
  indexes=$(seq 0 $(($(jq length "$bench/corpus/test/test.json") - 1)))
else
  indexes=$(tr ',' '\n' <<<"$prs")
fi
count=$(wc -l <<<"$indexes" | tr -d ' ')
export bench image
rm -rf findings logs/pr-*.log
xargs -P "$jobs" -I{} sh -c \
  '"$bench/scripts/try-agent.sh" "$image" -e OPENROUTER_API_KEY -e RB_MODEL_API_KEY -e RB_MODEL_BASE_URL -e RB_MODEL_API -e RB_MODEL_HEADERS -e RB_CONTEXT_OUT=/work/out/context.json --pr {} "$@" > "logs/pr-{}.log" 2>&1 || true' sh "$@" <<<"$indexes"
done_count=$(find findings -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
grep -h -E '^(==|   (ok|FAIL))' logs/pr-*.log || true
echo "$done_count of $count pull requests produced a valid findings file; logs in $run/logs" >&2
[ "$done_count" -eq "$count" ]
