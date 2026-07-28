#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

LINK=0
[[ "${1:-}" == "--link" ]] && LINK=1

if [[ -d "$CONFIG_DIR/plugin" && ! -d "$CONFIG_DIR/plugins" ]]; then
  PLUGIN_DIR="$CONFIG_DIR/plugin"
else
  PLUGIN_DIR="$CONFIG_DIR/plugins"
fi

mkdir -p "$PLUGIN_DIR/model-router"
rm -f "$PLUGIN_DIR/model-router.ts" "$PLUGIN_DIR/model-router/core.ts"

if [[ $LINK -eq 1 ]]; then
  ln -sf "$REPO_DIR/src/model-router.ts" "$PLUGIN_DIR/model-router.ts"
  ln -sf "$REPO_DIR/src/model-router/core.ts" "$PLUGIN_DIR/model-router/core.ts"
  echo "linked  $PLUGIN_DIR/model-router.ts -> $REPO_DIR/src/model-router.ts"
else
  cp "$REPO_DIR/src/model-router.ts" "$PLUGIN_DIR/model-router.ts"
  cp "$REPO_DIR/src/model-router/core.ts" "$PLUGIN_DIR/model-router/core.ts"
  echo "installed  $PLUGIN_DIR/model-router.ts"
fi

if [[ -f "$CONFIG_DIR/model-router.json" ]]; then
  echo "kept       $CONFIG_DIR/model-router.json (existing config left alone)"
else
  echo "note       $CONFIG_DIR/model-router.json will be created on first prompt"
fi

if [[ ! -f "$CONFIG_DIR/package.json" ]] || ! grep -q '@opencode-ai/plugin' "$CONFIG_DIR/package.json" 2>/dev/null; then
  echo
  echo "next       the plugin needs its types installed:"
  echo "             cd $CONFIG_DIR && npm install @opencode-ai/plugin"
fi

echo
echo "done       restart OpenCode to load the router"
