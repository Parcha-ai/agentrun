#!/usr/bin/env node
// npx @parcha/agentrun: AgentRun Server on this machine with one command. Node first, in syntax any Node reads, so an old one
// gets one plain line rather than a parse error; the repository's own rule (scripts/check-node.mjs). The floor is read from
// this package's own engines field (">=MAJOR.MINOR.PATCH"), so the line never names another version than npm's. The patch
// counts: the floor is a security release, and the releases before it on the same minor lack its fixes.
import { readFileSync } from "node:fs";

const engines = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engines);
if (!floor) throw new Error(`this package's engines.node is ${JSON.stringify(engines)}, not ">=MAJOR.MINOR.PATCH"`);
const need = floor.slice(1).map(Number);
const have = process.versions.node.split(".").map(Number);
const at = need.findIndex((part, i) => have[i] !== part);
if (at !== -1 && !(have[at] > need[at])) {
  console.error(`AgentRun needs Node.js ${need.join(".")} or newer; you have v${process.versions.node}.`);
  process.exit(1);
}
import("../lib/start.mjs").then(({ main }) => main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
