// A template package whose agent is a workflow: agent.md's `workflow` names a JSON file in the package holding an
// agentrun-dsl workflow, and apply makes a workflow revision from it, its parameters filled in the workflow's text. The
// bundled stream-router is one: each signed note from a Sandbar Stream ring starts it, and one Jev route picks who acts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compiled, PackageError, readPackage, TEMPLATES_DIR, workflowPackageProblems } from "../dist/templates.js";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { asOwner, scratch, serve, withEnv } from "./support.mjs";
import { firings } from "./trigger-support.mjs";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

/** A workflow that answers a note in one extract step, its instructions and label naming the assistant's parameter. */
const FLOW = {
  v: 2, name: "triage",
  schemas: {
    Note: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
  },
  input: { schemaId: "Note" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "${parameters.name} answers", instructions: "You are ${parameters.name}. Answer the note.", out: "Answer", as: "answer" }] },
};

const MANIFEST = ({ extra = "", body = "" } = {}) => `---
name: triage
version: 0.1.0
description: Answers each note that arrives.
workflow: triage.workflow.json
parameters:
  name: { type: string, required: false, default: Arun, description: The assistant's name. }
budget: { per_run_usd: 0.5 }
approvals: never
${extra}triggers:
  - name: notes
    source: { kind: webhook, signature: stream, accept: [{ event: interaction }] }
    target: { kind: start_run, input: { content: "A note arrived." } }
---
${body}`;

/** A package folder `triage` with its manifest and workflow file (`flow` as text when a string, none when null), and any
 *  other files. */
async function pkg(t, { manifest = MANIFEST(), flow = FLOW, files = {} } = {}) {
  const dir = join(await scratch(t), "templates", "triage");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), manifest);
  if (flow !== null) writeFileSync(join(dir, "triage.workflow.json"), typeof flow === "string" ? flow : JSON.stringify(flow, null, 2));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** The problems readPackage refuses `dir` with. */
const refusals = (dir) => {
  try {
    readPackage(dir);
  } catch (error) {
    if (error instanceof PackageError) return error.problems;
    throw error;
  }
  assert.fail("the package was read");
};

test("a package that names a workflow makes a workflow revision: its parameters filled in the workflow's text, with no instructions, model or skills", async (t) => {
  const p = readPackage(await pkg(t));
  assert.equal(p.workflowFile, "triage.workflow.json");
  assert.deepEqual(p.workflow, FLOW, "the workflow as the package holds it, placeholders unfilled");
  assert.equal(p.instructions, "", "a workflow package's body is empty");
  const { agent, triggers } = compiled(p, { name: "Kai" }, { mcp: [], defaultTools: [], grants: [], approvals: "never" });
  const step = agent.definition.workflow.root.steps[0];
  assert.deepEqual([step.label, step.instructions], ["Kai answers", "You are Kai. Answer the note."], "the parameter filled in the workflow's text");
  assert.deepEqual(Object.keys(agent.definition).sort(), ["approvals", "description", "max_cost_usd", "name", "workflow"], "no instructions, model, skills or tools: its nodes carry their own");
  assert.deepEqual(triggers[0].source, { kind: "webhook", signature: "stream", accept: [{ event: "interaction" }] });
  assert.deepEqual(await workflowPackageProblems(p), [], "the workflow checks as a save checks it, and takes the trigger's input");
});

test("a workflow package refuses what only an agentic package has: instructions, a model, tools, MCP needs, skills and evals", async (t) => {
  const extra = [
    "harness: [pi]", "model: { tier: fast }", "effort: low", "tools: [web_search]", "computer: [none]", "checkout: repository",
    "learning: true", "inputs: { topic: { type: string } }", "output: { schema: answer.json }",
    "mcp: [{ source: composio, toolkit: slack, tools: [SLACK_SEND_MESSAGE] }]",
  ].join("\n") + "\n";
  const problems = refusals(await pkg(t, {
    manifest: MANIFEST({ extra, body: "You are a helpful assistant.\n" }),
    files: { "answer.json": "{}", "skills/notes/SKILL.md": "---\nname: notes\ndescription: Notes.\n---\nTake notes.\n", "evals/one/prompt.md": "A note.\n", "evals/one/graders/ok.md": "---\ntype: regex\n---\n" },
  }));
  for (const field of ["harness", "model", "effort", "tools", "computer", "checkout", "learning", "inputs", "output", "mcp"]) {
    assert.ok(problems.some((one) => one.startsWith(`agent.md: ${field} is an agentic package's: a workflow package's agent is its workflow`)), `${field}: ${problems.join("\n")}`);
  }
  assert.ok(problems.includes("agent.md: its body is the agent's instructions, and a workflow package's agent has none: its workflow's nodes carry their own. Leave the body empty"), problems.join("\n"));
  assert.ok(problems.includes("skills/: a workflow package has no skills: its workflow's nodes carry their own instructions"), problems.join("\n"));
  assert.ok(problems.includes("evals/: a workflow package has no eval cases: they run an agentic package's agent"), problems.join("\n"));
});

test("a workflow package's workflow is a JSON object in the package, and its placeholders name parameters", async (t) => {
  assert.ok(refusals(await pkg(t, { flow: null })).includes("agent.md: workflow is a JSON file in the package, holding the agent's workflow"));
  assert.ok(refusals(await pkg(t, { flow: "[1, 2]" })).includes("triage.workflow.json: is not a JSON object"));
  assert.ok(refusals(await pkg(t, { flow: "{ not json" })).includes("triage.workflow.json: is not a JSON object"));
  const named = { ...FLOW, root: { ...FLOW.root, steps: [{ ...FLOW.root.steps[0], instructions: "You are ${parameters.nickname}." }] } };
  assert.ok(refusals(await pkg(t, { flow: named })).includes("agent.md: ${parameters.nickname} names no parameter"));
});

test("a workflow package's workflow is checked as a save checks it, and each trigger's input against the workflow's input: by the check and by template validate", async (t) => {
  const broken = { ...FLOW, root: { node: "chain", steps: [{ node: "teleport", label: "nowhere" }] } };
  const p = readPackage(await pkg(t, { flow: broken }));
  const problems = await workflowPackageProblems(p);
  assert.ok(problems.length && problems.every((one) => one.startsWith("triage.workflow.json")), problems.join("\n"));
  assert.ok(problems.some((one) => one.startsWith("triage.workflow.json/root/steps/0")), problems.join("\n"));
  const dir = await pkg(t, { flow: broken });
  const cli = spawnSync(process.execPath, [CLI, "validate-template", dir], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /triage\.workflow\.json\/root\/steps\/0/);
  // The workflow takes {content, topic}; the trigger hands it {content} alone.
  const topical = { ...FLOW, schemas: { ...FLOW.schemas, Note: { ...FLOW.schemas.Note, required: ["content", "topic"], properties: { ...FLOW.schemas.Note.properties, topic: { type: "string" } } } } };
  const untaken = await workflowPackageProblems(readPackage(await pkg(t, { flow: topical })));
  assert.equal(untaken.length, 1, untaken.join("\n"));
  assert.match(untaken[0], /^agent\.md: triggers\[0\]\.target\.input: the workflow does not take it/);
  const ok = spawnSync(process.execPath, [CLI, "validate-template", await pkg(t)], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).workflow, "triage.workflow.json");
});

test("a workflow package takes no model override or choice at apply: its nodes run on this host's models for their tiers", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { templates: join(await pkg(t), "..") });
  const refused = await asOwner(server)("POST", "/templates/triage/apply", { overrides: { model: "openai/gpt-5" } });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((f) => f.field), ["overrides.model"]);
  assert.equal((await server.api("GET", "/agents")).body.agents.length, 0, "nothing was made");
});

test("the bundled stream-router: apply makes its workflow agent and a stream trigger waiting for Stream's secret; a signed note then runs the router, and Jev's none wakes no agent", { timeout: 120_000 }, async (t) => {
  const p = readPackage(join(TEMPLATES_DIR, "stream-router"));
  assert.deepEqual(await workflowPackageProblems(p), []);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), TYPESAFE_API_KEY: CANARY });
  const server = await serve(t, { fauxJev: FAUX_JEV });
  const owner = asOwner(server);
  const read = await server.api("GET", "/templates/stream-router");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.template.workflow, "router.workflow.json");
  assert.equal(read.body.instructions, "");
  assert.equal(read.body.workflow.name, "stream-router", "the read answers the workflow whole, placeholders unfilled");
  const applied = await owner("POST", "/templates/stream-router/apply", { parameters: { assistant: "Kai" } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.webhook_secrets, undefined, "Stream makes the secret: none is minted to show");
  const secretWarning = applied.body.warnings.find((w) => w.field === "triggers.0.secret");
  assert.match(secretWarning.message, /^Stream makes this trigger's secret: give it on the trigger's page \(Set secret\), or with POST \/v2\/triggers\/\{id\}\/secret/);
  const definition = (await server.api("GET", `/agents/${applied.body.agent_id}`)).body.definition;
  assert.equal(definition.instructions, undefined);
  assert.equal(definition.model, undefined, "no model: its nodes run on this host's models for their tiers");
  const assistant = definition.workflow.root.steps[0].branches.assistant.body;
  assert.equal(assistant.label, "Kai", "the assistant's name filled in");
  assert.match(assistant.instructions, /^You are Kai, the person's chief of staff\./);
  const [{ trigger_id: id }] = applied.body.triggers;
  const trigger = (await server.api("GET", `/triggers/${id}`)).body;
  assert.deepEqual([trigger.source.kind, trigger.source.signature, trigger.source.accept, trigger.secret.set], ["webhook", "stream", [{ event: "interaction" }], false]);
  const secret = `swh_${randomBytes(32).toString("base64url")}`;
  assert.equal((await owner("POST", `/triggers/${id}/secret`, { secret })).status, 200);
  const body = JSON.stringify({ interaction_id: crypto.randomUUID().toUpperCase(), text: "Bought oat milk." });
  const at = Math.floor(Date.now() / 1000);
  const signature = `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
  const res = await fetch(`${server.baseUrl}/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-stream-signature": signature }, body });
  assert.equal(res.status, 202, await res.text());
  const [fired] = await firings(server.api, id, 1);
  assert.ok(fired.run_id, JSON.stringify(fired));
  let run;
  for (let i = 0; i < 600 && !["completed", "failed", "escalated", "stopped"].includes(run?.status); i++) {
    run = (await server.api("GET", `/runs/${fired.run_id}`)).body;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(run.status, "completed", JSON.stringify(run.error ?? run));
  assert.deepEqual(run.result.output, { branch: "none", taken: "none", unsure: false }, "the faux Jev's pick, none: no agent wakes");
});
