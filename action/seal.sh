#!/bin/bash
# seal.sh OUT FILE seals the review shape's run directory OUT into FILE with SEAL_KEY, the model key: OUT as a tar,
# encrypted with AES-256-CBC (PBKDF2, SHA-256, 100000 rounds, a salt of its own). The run holds what the review doesn't
# post, and anyone signed in to GitHub can download a public repository's artifacts, while a pull request's own workflow
# can restore the default branch's cache, so it goes to either only sealed. Whoever holds the model key opens it
# (docs/INSTALL.md says how). FILE is removed first, and an OUT that doesn't exist seals nothing and leaves no FILE. Any
# step that fails fails the script, a tar that couldn't read a file included, and action.yml saves FILE only after the
# script succeeds, so a half-sealed one is never saved.
set -euo pipefail
out=$1 file=$2
rm -f "$file"
[ -d "$out" ] || exit 0
# The key without the whitespace round it, as the model client takes RB_MODEL_API_KEY and whoever opens a run reads it:
# so a secret pasted with its line end still seals with the key everyone else reads.
SEAL_KEY="${SEAL_KEY:-}"; SEAL_KEY="${SEAL_KEY#"${SEAL_KEY%%[![:space:]]*}"}"; export SEAL_KEY="${SEAL_KEY%"${SEAL_KEY##*[![:space:]]}"}"
[ -n "$SEAL_KEY" ] || { echo "seal.sh: no model key to seal with" >&2; exit 1; }
mkdir -p "$(dirname "$file")"
tar -C "$out" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -salt -pass env:SEAL_KEY -out "$file"
