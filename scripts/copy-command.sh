#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
SRC_CMD="$SRC/commands"
DST="${HOME}/.claude/commands"

mkdir -p "$DST"

if [[ -z "${CC_USAGE_PREFIX:-}" ]]; then
  EXISTING=""
  for f in "$DST"/*-usage.md; do
    [[ -f "$f" ]] || continue
    fname="$(basename "$f")"
    EXISTING="${fname%-usage.md}"
    break
  done
  DEFAULT="${EXISTING:-my}"
  if [[ -t 0 ]]; then
    read -r -p "Command prefix (the slash command will be /<prefix>-usage) [${DEFAULT}]: " CC_USAGE_PREFIX
  fi
  CC_USAGE_PREFIX="${CC_USAGE_PREFIX:-$DEFAULT}"
fi

if [[ ! "$CC_USAGE_PREFIX" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Invalid prefix: '$CC_USAGE_PREFIX' (allowed: a-z, A-Z, 0-9, -, _)" >&2
  exit 1
fi

CMD_NAME="${CC_USAGE_PREFIX}-usage"
DST_FILE="$DST/${CMD_NAME}.md"
VERSION_FILE="$DST/.${CMD_NAME}.version"
SRC_FILE="$SRC_CMD/ok-usage.md"

if [[ "$SRC_CMD" == "$DST" ]]; then
  echo "Commands already at $DST — nothing to copy."
  exit 0
fi

PKG_VERSION="$(node -p "require('$SRC/package.json').version")"

install_command() {
  cp -f "$SRC_FILE" "$DST_FILE"
  printf '%s\n' "$PKG_VERSION" > "$VERSION_FILE"
}

if [[ ! -f "$DST_FILE" ]]; then
  install_command
  echo "Slash command installed to $DST_FILE (v$PKG_VERSION)"
  echo "It will be available as /${CMD_NAME} in any Claude Code session."
  exit 0
fi

INSTALLED_VERSION="$(cat "$VERSION_FILE" 2>/dev/null || echo "0.0.0")"

LATEST="$(printf '%s\n%s\n' "$INSTALLED_VERSION" "$PKG_VERSION" | sort -V | tail -1)"
if [[ "$LATEST" == "$PKG_VERSION" && "$INSTALLED_VERSION" != "$PKG_VERSION" ]]; then
  install_command
  echo "Slash command upgraded at $DST_FILE (v$INSTALLED_VERSION → v$PKG_VERSION, /${CMD_NAME})"
else
  echo "Slash command already at $DST_FILE (v$INSTALLED_VERSION ≥ v$PKG_VERSION) — skipping."
fi
