#!/usr/bin/env node
// npx @parcha/agentrun: AgentRun Server on this machine with one command. Node first, in syntax any Node reads, so an old one
// gets one plain line rather than a parse error; the repository's own rule (scripts/check-node.mjs). The floor is read from
// this package's own engines field (">=MAJOR.MINOR.PATCH"), so the line never names another version than npm's. The patch
// counts: the floor is a security release, and the releases before it on the same minor lack its fixes. The line ends
// with the installer's command, which brings a Node of its own (install.sh). `--version` alone prints this package's version.
import { readFileSync } from "node:fs";

const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const engines = own.engines.node;
const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engines);
if (!floor) throw new Error(`this package's engines.node is ${JSON.stringify(engines)}, not ">=MAJOR.MINOR.PATCH"`);
const need = floor.slice(1).map(Number);
const have = process.versions.node.split(".").map(Number);
const at = need.findIndex((part, i) => have[i] !== part);
if (at !== -1 && !(have[at] > need[at])) {
  console.error(`AgentRun needs Node.js ${need.join(".")} or newer; you have v${process.versions.node}. To install AgentRun with a Node.js of its own, run: curl -fsSL https://agentrun.ai/install | sh`);
  process.exit(1);
}
if (process.argv[2] === "--version" && process.argv.length === 3) {
  console.log(own.version);
  process.exit(0);
}
import("../lib/start.mjs").then(({ main }) => main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
