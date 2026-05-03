#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${HOME}/.claude/dashboard"
VERSION_FILE="$DST/.version"

mkdir -p "$DST"

if [[ "$SRC" == "$DST" ]]; then
  echo "Package is already at $DST — nothing to copy."
  exit 0
fi

PKG_VERSION="$(node -p "require('$SRC/package.json').version")"

install_files() {
  cp -f "$SRC/build.sh"      "$DST/build.sh"
  cp -f "$SRC/template.html" "$DST/template.html"
  chmod +x "$DST/build.sh"
  printf '%s\n' "$PKG_VERSION" > "$VERSION_FILE"
}

if [[ ! -f "$DST/build.sh" || ! -f "$DST/template.html" ]]; then
  install_files
  echo "Dashboard files installed to $DST (v$PKG_VERSION)"
  exit 0
fi

INSTALLED_VERSION="$(cat "$VERSION_FILE" 2>/dev/null || echo "0.0.0")"

LATEST="$(printf '%s\n%s\n' "$INSTALLED_VERSION" "$PKG_VERSION" | sort -V | tail -1)"
if [[ "$LATEST" == "$PKG_VERSION" && "$INSTALLED_VERSION" != "$PKG_VERSION" ]]; then
  install_files
  echo "Dashboard files upgraded at $DST (v$INSTALLED_VERSION → v$PKG_VERSION)"
else
  echo "Dashboard files already at $DST (v$INSTALLED_VERSION ≥ v$PKG_VERSION) — skipping."
fi
