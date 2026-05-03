#!/usr/bin/env bash
set -euo pipefail

DST="${HOME}/.claude/commands"

EXISTING=""
if [[ -d "$DST" ]]; then
  for f in "$DST"/*-usage.md; do
    [[ -f "$f" ]] || continue
    fname="$(basename "$f")"
    EXISTING="${fname%-usage.md}"
    break
  done
fi

DEFAULT="${EXISTING:-my}"

if [[ -z "${CC_USAGE_PREFIX:-}" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Command prefix (the slash command will be /<prefix>-usage) [${DEFAULT}]: " CC_USAGE_PREFIX
  fi
  CC_USAGE_PREFIX="${CC_USAGE_PREFIX:-$DEFAULT}"
fi

if [[ ! "$CC_USAGE_PREFIX" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Invalid prefix: '$CC_USAGE_PREFIX' (allowed: a-z, A-Z, 0-9, -, _)" >&2
  exit 1
fi

export CC_USAGE_PREFIX

echo "Using slash command: /${CC_USAGE_PREFIX}-usage"
echo

npm run copy-dashboard
npm run copy-command
