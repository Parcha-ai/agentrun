// Local template evals share one install of each harness's pin (harness-install.ts sharedInstaller, which template-eval.ts
// hands its scratch server and the runner beside it): the first eval installs it under a root of its own, and every eval
// after it, each on a data directory of its own, gets a link to that install, never a copy. The install's own checks
// (the entry's `lacking`) take the link as it is. A stand-in install, no npm and no network.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";

const { claimInstallsStopped, HARNESS_INSTALLS, HarnessInstall, installDirOf, installForClaim, sharedInstaller } = await import("../dist/harness-install.js");

const CLAUDE = HARNESS_INSTALLS["claude-agent"];
const PINS = { version: "0.3.286", platform: `${process.platform}-${process.arch}` };

/** A stand-in for npmInstall: a tree the Claude entry's `lacking` takes as whole (the SDK at the pin, this platform's CLI,
 *  the MCP library's server and types), written beside `dir` and renamed into place, as npmInstall lands an install.
 *  `installs` counts its calls; each takes `ms`, so two evals at once overlap. */
function standIn(ms = 0) {
  const installs = [];
  const install = async (_entry, dir, pins) => {
    installs.push(dir);
    await new Promise((resolve) => setTimeout(resolve, ms));
    const staging = `${dir}.staging`;
    const file = (path, text) => (mkdirSync(join(staging, "node_modules", path, ".."), { recursive: true }), writeFileSync(join(staging, "node_modules", path), text));
    file("@anthropic-ai/claude-agent-sdk/package.json", JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: pins.version, exports: { ".": "./sdk.mjs" } }));
    file("@anthropic-ai/claude-agent-sdk/sdk.mjs", "export {};\n");
    file(`@anthropic-ai/claude-agent-sdk-${pins.platform}/package.json`, "{}");
    file(`@anthropic-ai/claude-agent-sdk-${pins.platform}/${process.platform === "win32" ? "claude.exe" : "claude"}`, "#!/bin/sh\n");
    file("@modelcontextprotocol/sdk/package.json", JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "1.0.0", exports: { "./server/mcp.js": "./server/mcp.js", "./types.js": "./types.js" } }));
    file("@modelcontextprotocol/sdk/server/mcp.js", "export {};\n");
    file("@modelcontextprotocol/sdk/types.js", "export {};\n");
    renameSync(staging, dir);
  };
  return { installs, install };
}

/** The regular files under `dir`, no link followed. */
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((one) => (one.isDirectory() ? filesUnder(join(dir, one.name)) : one.isFile() ? [join(dir, one.name)] : []));

/** One local eval's server, as startServe makes its first-use install of Claude Code on `data` with the eval's installer. */
const evalServer = (data, installer) => new HarnessInstall(CLAUDE, installDirOf(data, CLAUDE.id), async () => PINS, installer);

test("two local evals in a row install Claude Code once: the second's data holds a link to that install, no copy", async (t) => {
  const [root, first, second] = [await scratch(t), await scratch(t), await scratch(t)];
  const { installs, install } = standIn();
  const shared = installDirOf(root, `${CLAUDE.id}@${PINS.version}-${PINS.platform}`);
  for (const data of [first, second]) {
    await evalServer(data, sharedInstaller(root, install)).ensure();
    const dir = installDirOf(data, CLAUDE.id);
    assert.equal(CLAUDE.lacking(dir, PINS), undefined, "the install's own check takes the eval's harness as whole");
    assert.ok(lstatSync(dir).isSymbolicLink(), "the eval's harness is a link");
    assert.equal(realpathSync(dir), realpathSync(shared), "to the one shared install");
    assert.deepEqual(filesUnder(data), [], "the eval's data holds no file of the install");
  }
  assert.deepEqual(installs, [shared], "installed once, into the shared root");
});

test("two local evals at once install once, and neither reads the install before it is whole", async (t) => {
  const [root, first, second] = [await scratch(t), await scratch(t), await scratch(t)];
  const { installs, install } = standIn(300);
  await Promise.all([first, second].map((data) => evalServer(data, sharedInstaller(root, install)).ensure()));
  assert.equal(installs.length, 1, "one install for both");
  for (const data of [first, second]) assert.equal(CLAUDE.lacking(installDirOf(data, CLAUDE.id), PINS), undefined, "each eval's harness is whole once its install resolves");
});

test("a run's claim on an eval's data with no install yet links the shared one, which an eval before it installed", async (t) => {
  const [root, first, second] = [await scratch(t), await scratch(t), await scratch(t)];
  const { installs, install } = standIn();
  const installer = sharedInstaller(root, install);
  await evalServer(first, installer).ensure();
  // The runner beside the eval's server installs for a claim through installForClaim, given the same installer.
  const dir = installDirOf(second, CLAUDE.id);
  await installForClaim(CLAUDE, dir, async () => PINS, { install: installer });
  await claimInstallsStopped();
  assert.equal(installs.length, 1, "the claim installed nothing");
  assert.ok(lstatSync(dir).isSymbolicLink(), "the claim's harness is a link");
  assert.equal(CLAUDE.lacking(dir, PINS), undefined);
});
