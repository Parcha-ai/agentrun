#!/bin/sh
# The image carries no coding-agent CLI: the Claude Agent SDK and its platform packages (which hold the Claude CLI), and
# the Codex CLI and its platform packages (which hold its binary), with their bin links. Each installs itself on first
# use into the data's harnesses, at its pin and by the lock serve ships (src/harness-install.ts). Their adapters develop
# against them as dev dependencies, and npm ci installs those, so the Dockerfile removes them and runs this check on the
# final image's tree.
#   image-check.sh <root>
set -eu
root=${1:?usage: image-check.sh <root>}
found=$(find "$root" \( \
  -path '*/node_modules/@anthropic-ai/claude-agent-sdk' -o -path '*/node_modules/@anthropic-ai/claude-agent-sdk-*' \
  -o -path '*/node_modules/@anthropic-ai/claude-code' -o -path '*/node_modules/.bin/claude' \
  -o -path '*/node_modules/@openai/codex' -o -path '*/node_modules/@openai/codex-*' -o -path '*/node_modules/.bin/codex' \
  \) -prune -print)
if [ -n "$found" ]; then
  printf 'image check: %s carries a coding-agent CLI the image does not ship:\n%s\n' "$root" "$found" >&2
  exit 1
fi
echo "image check: no Claude Agent SDK, Claude CLI or Codex CLI under $root"
