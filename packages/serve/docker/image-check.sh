#!/bin/sh
# The image carries no coding-agent CLI whose licence has not been reviewed for redistribution: the Claude Agent SDK and its
# platform packages (which hold the Claude CLI). Its adapter develops against it as a dev dependency, and npm ci installs
# those, so the Dockerfile removes it and runs this check on the final image's tree; the release's own image check runs it
# again. A CLI that is cleared for the image is installed on purpose, pinned, and leaves this list in the same change.
#   image-check.sh <root>
set -eu
root=${1:?usage: image-check.sh <root>}
found=$(find "$root" \( \
  -path '*/node_modules/@anthropic-ai/claude-agent-sdk' -o -path '*/node_modules/@anthropic-ai/claude-agent-sdk-*' \
  -o -path '*/node_modules/@anthropic-ai/claude-code' -o -path '*/node_modules/.bin/claude' \
  \) -prune -print)
if [ -n "$found" ]; then
  printf 'image check: %s carries a coding-agent CLI the image may not ship yet:\n%s\n' "$root" "$found" >&2
  exit 1
fi
echo "image check: no Claude Agent SDK or Claude CLI under $root"
