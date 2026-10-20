#!/usr/bin/env node
// Edit the prompt variants in an agent's own home (its agent.sqlite): read prompts.json, check it, save it with
// setPrompts of @parcha/pi-durable-agent; or print what the home holds now.
//   node edit-prompts.mjs --home DIR [--file prompts.json]   save the file's variants, replacing the home's
//   node edit-prompts.mjs --home DIR --show [--json]         print what the home holds
//   node edit-prompts.mjs --home DIR --init                  make the home from agent.json and skills/ first, when it has none
//   node edit-prompts.mjs --check [--file prompts.json]      only check the file; no home is opened
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkPrompts, normalizePrompts, readPromptsFile, readQuestion, ruleText, withQuestion } from "./prompts-lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const USAGE = "usage: edit-prompts.mjs --home DIR [--file prompts.json] [--init] | --home DIR --show [--json] | --check [--file prompts.json]";

/** The definition and skill files this directory's agent is made from. */
async function agentFiles(dir) {
  const definition = JSON.parse(await readFile(join(dir, "agent.json"), "utf8"));
  const skills = {};
  for (const name of definition.skills ?? []) skills[`${name}/SKILL.md`] = await readFile(join(dir, "skills", name, "SKILL.md"), "utf8");
  return { definition, skills };
}

const firstLine = (text) => String(text).split("\n").find((line) => line.trim()) ?? "";
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** One line per variant: its role, its id, its rule (a question's options), its size and how its text starts. */
export function listing(variants) {
  const rule = (v) => (v.role === "question" ? `options: ${Object.keys(v.criteria ?? {}).join(", ")}` : ruleText(v.when) || "-");
  const rows = variants.map((v) => [v.role ?? "?", v.id ?? v.label ?? "?", rule(v), `${String(v.text ?? "").length} chars`, clip(firstLine(v.text), 60)]);
  const width = [0, 1, 2, 3].map((column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => `${row[0].padEnd(width[0])}  ${row[1].padEnd(width[1])}  ${row[2].padEnd(width[2])}  ${row[3].padEnd(width[3])}  ${row[4]}`).join("\n");
}

/**
 * Run the tool; returns the exit code (0 done, 1 refused or failed, 2 a usage error). `api` is @parcha/pi-durable-agent's
 * (openAgentHome, readAgentHome, createAgentHome, setPrompts), loaded when not given. A home is never printed by path.
 */
export async function main(argv, { api, out = (line) => console.log(line), err = (line) => console.error(line), dir = HERE } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { home: { type: "string" }, file: { type: "string" }, show: { type: "boolean", default: false }, json: { type: "boolean", default: false }, init: { type: "boolean", default: false }, check: { type: "boolean", default: false } }, allowPositionals: false }));
  } catch (error) {
    err(`${error.message}\n${USAGE}`);
    return 2;
  }
  if ((!values.home && !values.check) || (values.show && (values.file || values.init || values.check)) || (values.check && (values.home || values.init)) || (values.json && !values.show)) {
    err(USAGE);
    return 2;
  }
  const question = await readQuestion(join(dir, "question.json")).catch(() => undefined);
  const file = resolve(values.file ?? join(dir, "prompts.json"));

  if (!values.show) {
    let variants;
    try {
      variants = await readPromptsFile(file);
    } catch (error) {
      err(error.message);
      return 1;
    }
    if (!question) {
      err("question.json is missing or is not JSON: the overlays' rules need the question they answer");
      return 1;
    }
    const problems = checkPrompts(variants, question);
    if (problems.length) {
      err(`${basename(file)} is not saved: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
      for (const problem of problems) err(`  ${problem}`);
      return 1;
    }
    if (values.check) {
      out(`${basename(file)} is valid: ${variants.length} variants, and the question ${question.id}\n${listing(withQuestion(variants, question))}`);
      return 0;
    }
    const clean = withQuestion(variants.map(({ id, role, label, text, when }) => ({ id, role, label, text, ...(when ? { when } : {}) })), question);
    api ??= await import("@parcha/pi-durable-agent");
    if (typeof api.setPrompts !== "function") {
      err("this build of @parcha/pi-durable-agent has no setPrompts: the prompts are in its durable-agent/prompts branch");
      return 1;
    }
    const home = resolve(values.home);
    try {
      if (!existsSync(join(home, "agent.sqlite"))) {
        if (!values.init) throw new Error(`${basename(home)} is not an agent home; add --init to make one from this agent's agent.json`);
        await mkdir(home, { recursive: true, mode: 0o700 });
        await api.createAgentHome(home, await agentFiles(dir));
        out(`made the agent home ${basename(home)}`);
      }
      const handle = await api.openAgentHome(home);
      const { changed } = await api.setPrompts(handle, clean);
      const saved = normalizePrompts((await api.readAgentHome(handle)).prompts);
      if (saved.length !== clean.length) throw new Error(`saved ${clean.length} variants but the home holds ${saved.length}`);
      const what = `${clean.length - 1} prompt variants and the question ${question.id}`;
      out(`${changed === false ? `the ${what} were already saved in ${basename(home)}: nothing changed` : `saved ${what} in ${basename(home)}`}\n${listing(saved)}`);
      return 0;
    } catch (error) {
      err(`not saved: ${error.message}`);
      return 1;
    }
  }

  api ??= await import("@parcha/pi-durable-agent");
  try {
    const home = resolve(values.home);
    if (!existsSync(join(home, "agent.sqlite"))) throw new Error(`${basename(home)} is not an agent home`);
    const state = await api.readAgentHome(await api.openAgentHome(home));
    const prompts = normalizePrompts(state.prompts);
    if (values.json) out(JSON.stringify({ agent: { id: state.identity.id, name: state.definition.name }, prompts }, null, 2));
    else {
      const variants = prompts.filter((v) => v.role !== "question").length;
      out(`${state.definition.name} (${state.identity.id}): ${variants} prompt variant${variants === 1 ? "" : "s"}${prompts.length - variants ? " and a question" : ""}${prompts.length ? `\n${listing(prompts)}` : ""}`);
    }
    return 0;
  } catch (error) {
    err(`cannot read the prompts: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
