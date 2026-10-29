#!/bin/sh
# The image carries no coding-agent CLI whose licence has not been reviewed for redistribution: the Claude Agent SDK and its
# platform packages (which hold the Claude CLI). Its adapter develops against it as a dev dependency, and npm ci installs
# those, so the Dockerfile removes it and runs this check on the final image's tree; the release's own image check runs it
# again. A CLI that is cleared for the image is installed on purpose, pinned, and leaves this list in the same change.
# The Codex CLI is one: it ships with its adapter, from the lock, and the tree must hold the build @parcha/agentrun-codex
# is pinned to for the image's platform. The adapter's own check reads the pins (its platform package's version, the
# binary's sha256 and the version it reports); a missing or different build fails with the typed error it prints.
# With CLAUDE_AGENT_SDK set (an image built with that build arg, for testing claude-agent), the SDK is meant to be there
# instead: the check is then that the adapter finds that version and its pinned CLI.
#   image-check.sh <root>
set -eu
root=${1:?usage: image-check.sh <root>}
if [ -n "${CLAUDE_AGENT_SDK:-}" ]; then
  node --input-type=module -e '
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";
const [root, want] = argv.slice(1);
const pkg = dirname(createRequire(resolve(root, "package.json")).resolve("@parcha/agentrun-claude-agent/package.json"));
const { verifyClaudeAgent } = await import(pathToFileURL(join(pkg, "dist", "index.js")).href);
const sdk = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version;
if (sdk !== want) { console.error(`image check: CLAUDE_AGENT_SDK=${want}, but the tree holds @anthropic-ai/claude-agent-sdk ${sdk}`); exit(1); }
try {
  const { cliPath } = verifyClaudeAgent({});
  console.log(`image check: Claude Agent SDK ${sdk} and its pinned CLI at ${cliPath} (CLAUDE_AGENT_SDK=${want})`);
} catch (error) {
  console.error(`image check: CLAUDE_AGENT_SDK=${want}, but the adapter does not find what it runs: ${error?.message ?? error}`);
  exit(1);
}
' "$root" "$CLAUDE_AGENT_SDK"
else
  found=$(find "$root" \( \
    -path '*/node_modules/@anthropic-ai/claude-agent-sdk' -o -path '*/node_modules/@anthropic-ai/claude-agent-sdk-*' \
    -o -path '*/node_modules/@anthropic-ai/claude-code' -o -path '*/node_modules/.bin/claude' \
    \) -prune -print)
  if [ -n "$found" ]; then
    printf 'image check: %s carries a coding-agent CLI the image may not ship yet:\n%s\n' "$root" "$found" >&2
    exit 1
  fi
  echo "image check: no Claude Agent SDK or Claude CLI under $root"
fi
env -u CODEX_BIN node --input-type=module -e '
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";
const root = argv[1];
let pkg;
try {
  pkg = dirname(createRequire(resolve(root, "package.json")).resolve("@parcha/agentrun-codex/package.json"));
} catch {
  console.error(`image check: ${root} has no @parcha/agentrun-codex to check its Codex CLI with`);
  exit(1);
}
const { verifyCodex } = await import(pathToFileURL(join(pkg, "dist", "verify.js")).href);
const { CODEX_VERSION } = await import(pathToFileURL(join(pkg, "dist", "versions.js")).href);
try {
  const { path } = verifyCodex();
  console.log(`image check: Codex ${CODEX_VERSION} at ${path} is the pinned build`);
} catch (error) {
  if (!error?.code) throw error;
  console.error(`image check: ${root} does not hold the pinned Codex CLI: ${error.name} (${[error.code, error.pin].filter(Boolean).join(", ")}): ${error.message}`);
  exit(1);
}
' "$root"
