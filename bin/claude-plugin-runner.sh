#!/bin/sh
# The Claude Code plugin runs this for its channel server and for each hook
# call. A machine that already has the CLI on PATH uses that one: a hook runs
# up to six times per AskUserQuestion, and a download per call would be slow.
# Without the CLI, the plugin runs the package version its manifest pins.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if command -v your-attention >/dev/null 2>&1; then
  exec your-attention "$@"
fi
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json" | head -n 1)
if [ -z "$version" ]; then
  echo "claude-plugin-runner: no version in $root/.claude-plugin/plugin.json" >&2
  exit 1
fi
exec npx -y "your-attention@$version" "$@"
