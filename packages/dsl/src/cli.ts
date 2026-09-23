#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflow, validateWorkflow, type Workflow } from "./workflow.js";
import { dryRunWorkflow } from "./dry-run.js";
import { demoScenarios, runTriageDemo, supportTriage, type DemoScenario } from "./demo.js";
import { inspectWorkflow, formatWorkflowTree } from "./inspection.js";

const help = `AgentRun DSL — build, test, and run agent workflows

  agentrun demo [--scenario billing|technical|ambiguous] [--json]
  agentrun example [file.json]            Write the demo workflow (never overwrite)
  agentrun inspect workflow.json [--json] Show structure without executing code
  agentrun validate workflow.json [input.json] --trusted
  agentrun dry-run workflow.json [input.json] --trusted
  agentrun run workflow.json input.json --trusted

demo runs the real interpreter with scripted judgments, without a key or network.
run supports deterministic workflows; use the JavaScript API to supply agent,
Jev, or effect adapters. --trusted acknowledges that authored code may execute
during validation and running. Only use workflows you trust; this is not a sandbox.
validate checks a supplied input against the workflow's input contract.
dry-run uses supplied input, or synthesizes it from the declared input schema.
Without an input schema, dry-run starts with an empty input object.
`;

async function main(args: string[]) {
  const [command] = args;
  if (!command || command === "--help" || command === "help" || command === "-h") { console.log(help); return; }
  if (command === "demo") {
    let scenario: DemoScenario = "billing";
    let scenarioProvided = false;
    let json = false;
    const usage = "Usage: agentrun demo [--scenario billing|technical|ambiguous] [--json]";
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--json") { json = true; continue; }
      if (arg !== "--scenario") throw new Error(`Unexpected demo argument "${arg}". ${usage}`);
      if (scenarioProvided) throw new Error(`Pass --scenario only once. ${usage}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`--scenario needs a value. ${usage}`);
      if (!Object.prototype.hasOwnProperty.call(demoScenarios, value)) throw new Error(`Unknown scenario "${value}". Choose billing, technical, or ambiguous.`);
      scenario = value as DemoScenario;
      scenarioProvided = true;
    }
    const demo = await runTriageDemo(scenario);
    if (json) console.log(JSON.stringify(demo, null, 2));
    else {
      console.log("AgentRun · real control flow, scripted judgments\n");
      console.log(`Ticket: ${demo.input.ticket}\n`);
      for (const event of demo.events) console.log(`  ${event.label} · ${event.type}`);
      console.log(`\nStatus: ${demo.result.status}`);
      console.log(JSON.stringify(demo.result.status === "complete" ? demo.result.output : demo.result.escalation, null, 2));
      const cliPath = relative(process.cwd(), fileURLToPath(import.meta.url));
      const quotedPath = `'${cliPath.replace(/'/g, "'\\''")}'`;
      console.log(`\nSave this workflow: node ${quotedPath} example workflow.json`);
    }
    return;
  }
  if (command === "example") {
    const target = resolve(args[1] || "workflow.json");
    await writeFile(target, `${JSON.stringify(supportTriage, null, 2)}\n`, { flag: "wx" });
    console.log(`Wrote ${target}`); return;
  }
  if (command === "inspect") {
    const positional = args.slice(1).filter(arg => arg !== "--json");
    if (positional.length !== 1 || positional[0].startsWith("--")) throw new Error("Usage: agentrun inspect workflow.json [--json]");
    const inspection = inspectWorkflow(JSON.parse(await readFile(resolve(positional[0]), "utf8")));
    console.log(args.includes("--json") ? JSON.stringify(inspection, null, 2) : formatWorkflowTree(inspection));
    return;
  }
  if (!["validate", "dry-run", "run"].includes(command)) throw new Error(`Unknown command "${command}". Use agentrun --help.`);
  if (!args.includes("--trusted")) throw new Error("Pass --trusted only after reviewing the workflow. Authored JavaScript may execute, including during validation.");
  const positional = args.slice(1).filter(arg => arg !== "--trusted");
  const unknown = positional.find(arg => arg.startsWith("--"));
  if (unknown) throw new Error(`Unknown option "${unknown}". Use agentrun --help.`);
  if (!positional[0]) throw new Error("Provide a workflow JSON file.");
  if (positional.length > 2) throw new Error(`Usage: agentrun ${command} workflow.json ${command === "run" ? "input.json" : "[input.json]"} --trusted`);
  if (command === "run" && !positional[1]) throw new Error("Provide an input JSON file.");
  const workflow = JSON.parse(await readFile(resolve(positional[0]), "utf8")) as Workflow;
  let input: Record<string, unknown> | undefined;
  if (positional[1]) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(resolve(positional[1]), "utf8")); }
    catch (error) { throw new Error(`Cannot read input JSON file "${positional[1]}": ${error instanceof Error ? error.message : String(error)}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Input JSON must be an object.");
    input = parsed as Record<string, unknown>;
  }
  if (command === "validate") {
    const result = validateWorkflow(workflow, input === undefined ? undefined : { input });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "dry-run") {
    const result = await dryRunWorkflow(workflow, input === undefined ? undefined : { input });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    const result = await runWorkflow(workflow, input!, {});
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "complete") process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : "Workflow failed.");
  process.exitCode = 1;
});
