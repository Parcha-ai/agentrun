#!/usr/bin/env node
// npx @parcha/agentrun: AgentRun Server on this machine with one command. Node first, in syntax any Node reads, so an old one
// gets one plain line rather than a parse error; the repository's own rule (scripts/check-node.mjs).
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19) || major === 23 || (major === 24 && minor < 2)) {
  console.error(`AgentRun needs Node.js 22.19 or newer on 22, or 24.2 or newer; you have v${process.versions.node}.`);
  process.exit(1);
}
import("../lib/start.mjs").then(({ main }) => main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
