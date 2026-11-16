// One local eval's server installing Claude Code on its own data, in a process of its own, for eval-harness-share.test.mjs:
//   node eval-harness-child.mjs <root> <data> <peer data> <log>
// installs through the eval's installer over <root> (sharedInstaller) with the stand-in (eval-harness-stand-in.mjs),
// appending one line to <log> per install it makes. An install it makes holds until the other eval's server, on
// <peer data>, has started its own install (its mark there), so the two always meet at the shared install's hold; it fails
// after 30 s without. Prints "whole" once this eval's harness passes `lacking`.
import { appendFileSync, existsSync } from "node:fs";
import { PINS, writeTree } from "./eval-harness-stand-in.mjs";

const [root, data, peer, log] = process.argv.slice(2);
const { HARNESS_INSTALLS, HarnessInstall, installDirOf, installMarkOf, sharedInstaller } = await import("../../dist/harness-install.js");
const claude = HARNESS_INSTALLS["claude-agent"];
const install = async (_entry, dir, pins) => {
  appendFileSync(log, `${dir}\n`);
  const until = Date.now() + 30_000;
  while (!existsSync(installMarkOf(installDirOf(peer, claude.id)))) {
    if (Date.now() > until) throw new Error("the other eval never started its install");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  writeTree(dir, pins);
};
await new HarnessInstall(claude, installDirOf(data, claude.id), async () => PINS, sharedInstaller(root, install)).ensure();
console.log(claude.lacking(installDirOf(data, claude.id), PINS) === undefined ? "whole" : "not whole");
