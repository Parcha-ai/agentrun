// A stand-in for npmInstall of Claude Code, for eval-harness-share.test.mjs: a tree the Claude entry's `lacking` takes as
// whole (the SDK at the pin, this platform's CLI, the MCP library's server and types), written beside the install's
// directory and renamed into place, as npmInstall lands an install. No npm, no network. eval-harness-child.mjs runs one
// eval's install on it in a process of its own.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PINS = { version: "0.3.286", platform: `${process.platform}-${process.arch}` };

/** The stand-in's tree, written whole into `dir`. */
export function writeTree(dir, pins) {
  const staging = `${dir}.staging-${process.pid}`;
  const file = (path, text) => (mkdirSync(join(staging, "node_modules", path, ".."), { recursive: true }), writeFileSync(join(staging, "node_modules", path), text));
  file("@anthropic-ai/claude-agent-sdk/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: pins.version, exports: { ".": "./sdk.mjs" } }));
  file("@anthropic-ai/claude-agent-sdk/sdk.mjs", "export {};\n");
  file(`@anthropic-ai/claude-agent-sdk-${pins.platform}/package.json`, "{}");
  file(`@anthropic-ai/claude-agent-sdk-${pins.platform}/${process.platform === "win32" ? "claude.exe" : "claude"}`, "#!/bin/sh\n");
  file("@modelcontextprotocol/sdk/package.json", JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "1.0.0", exports: { "./server/mcp.js": "./server/mcp.js", "./types.js": "./types.js" } }));
  file("@modelcontextprotocol/sdk/server/mcp.js", "export {};\n");
  file("@modelcontextprotocol/sdk/types.js", "export {};\n");
  renameSync(staging, dir);
}

/** A stand-in install: `installs` lists the directory of each install it made; each takes `ms`. */
export function standIn(ms = 0) {
  const installs = [];
  const install = async (_entry, dir, pins) => {
    installs.push(dir);
    await new Promise((resolve) => setTimeout(resolve, ms));
    writeTree(dir, pins);
  };
  return { installs, install };
}
