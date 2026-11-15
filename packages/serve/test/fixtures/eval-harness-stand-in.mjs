// A stand-in for npmInstall of Claude Code, for eval-harness-share.test.mjs: a tree the Claude entry's `lacking` takes as
// whole (the SDK at the pin, this platform's CLI, the MCP library's server and types), written beside the install's
// directory and renamed into place, as npmInstall lands an install. No npm, no network.
//
// Run as a script, it is one local eval's server on its own data, in a process of its own:
//   node eval-harness-stand-in.mjs <root> <data> <log> <ms>
// installs Claude Code on <data> through the eval's installer over <root> (sharedInstaller), its stand-in taking <ms>
// and appending one line to <log> per install it makes; prints "whole" once the eval's harness passes `lacking`.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PINS = { version: "0.3.286", platform: `${process.platform}-${process.arch}` };

/** The stand-in's tree, written whole into `dir`. */
export async function writeTree(dir, pins, ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    await writeTree(dir, pins, ms);
  };
  return { installs, install };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, data, log, ms] = process.argv.slice(2);
  const { HARNESS_INSTALLS, HarnessInstall, installDirOf, sharedInstaller } = await import("../../dist/harness-install.js");
  const claude = HARNESS_INSTALLS["claude-agent"];
  const install = async (_entry, dir, pins) => {
    appendFileSync(log, `${dir}\n`);
    await writeTree(dir, pins, Number(ms));
  };
  await new HarnessInstall(claude, installDirOf(data, claude.id), async () => PINS, sharedInstaller(root, install)).ensure();
  console.log(claude.lacking(installDirOf(data, claude.id), PINS) === undefined ? "whole" : "not whole");
}
