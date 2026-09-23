#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { authorWorkflow, runWorkflow, validateWorkflow, type WorkflowDeps } from "@parcha/agentrun-dsl";
import { createPiRunner, type PiRunnerOptions } from "./runner.js";

const help = `Usage:
  agentrun-pi validate workflow.json [--inputs key1,key2]
  agentrun-pi author --config ./pi.config.mjs --out ./candidates "Describe the workflow"
  agentrun-pi run --config ./pi.config.mjs workflow.json input.json

Config is trusted JavaScript exporting default PiRunnerOptions, optionally deps (Jev/effect adapters).
Author saves candidates; it does not execute or activate them.
Validate may execute code probes. Run executes trusted workflow code and exits 2 on escalation.
Model and authentication must be configured explicitly. No shell/filesystem tools are enabled by default.`;
async function main(args: string[]) {
  const command = args.shift();
  if (!command || command === "--help" || command === "help") { console.log(help); return; }
  const flag = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    args.splice(index, 2);
    return value;
  };
  const configPath = flag("--config");
  const outputDir = flag("--out") ?? "./candidates";
  const inputKeys = (flag("--inputs") ?? "").split(",").filter(Boolean);
  if (command === "validate") {
    if (args.length !== 1) throw new Error(help);
    const candidate = JSON.parse(await readFile(args[0], "utf8"));
    const verdict = validateWorkflow(candidate, { inputKeys: inputKeys.length ? inputKeys : undefined });
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.ok) process.exitCode = 1;
    return;
  }
  if (command !== "author" && command !== "run") throw new Error(help);
  if (!configPath) throw new Error("Supply --config with an explicit model and modelRuntime");
  const config = await import(pathToFileURL(resolve(configPath)).href) as { default: PiRunnerOptions; deps?: WorkflowDeps };
  if (command === "author") {
    if (args.length !== 1) throw new Error(help);
    const maxCandidates = 4;
    // The author session gets no host tools and stops at the candidate limit.
    const runNode = createPiRunner({ ...config.default, tools: [], maxSubmissions: maxCandidates });
    const authored = await authorWorkflow({ request: args[0], outputDir, inputKeys, runNode, maxCandidates });
    console.log(JSON.stringify({ path: authored.path, candidates: authored.candidates, checks: authored.checks }, null, 2));
  } else {
    if (args.length !== 2) throw new Error(help);
    const workflow = JSON.parse(await readFile(args[0], "utf8"));
    const input = JSON.parse(await readFile(args[1], "utf8"));
    const result = await runWorkflow(workflow, input, { ...config.deps, runNode: createPiRunner(config.default) });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "escalated") process.exitCode = 2;
  }
}
main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
