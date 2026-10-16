import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AgentHomeError, createAgentHome, openAgentHome, readAgentHome, setAlias, setBindings } from "../dist/index.js";
import { DEFINITION, scratch, sha256 } from "./support.mjs";

const FULL = {
  id: "agt_research",
  version: 3,
  name: "Researcher",
  description: "Finds sources and cites them.",
  instructions: "Cite every claim.",
  skills: ["cite"],
  tools: ["web_search", "browser"],
  input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  output_schema: { type: "object", properties: { answer: { type: "string" } } },
  workflow: { v: 2, nodes: [{ id: "answer", type: "agent" }] },
  max_cost_usd: 2.5,
};

const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));

function child(source, onLine) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (chunk) => {
    out += chunk;
    if (onLine && out.includes("\n")) onLine(out);
  });
  return { proc, done: new Promise((resolve, reject) => proc.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}`))))) };
}

test("the definition round-trips with exactly its stored field names", async () => {
  const dir = path.join(await scratch(), "acme");
  const home = await createAgentHome(dir, { definition: FULL, skills: { "cite/SKILL.md": "# Cite\n\nQuote the source.\n" } });
  assert.deepEqual(home.identity, { id: "agt_research", name: "Researcher", formatVersion: 1 });
  const state = await readAgentHome(home);
  assert.deepEqual(Object.keys(state.definition).sort(), [
    "description", "id", "input_schema", "instructions", "max_cost_usd", "name", "output_schema", "skills", "tools", "version", "workflow",
  ]);
  assert.deepEqual(state.definition, FULL);
  assert.deepEqual(state.identity, home.identity);
  assert.deepEqual(state.skills, { "cite/SKILL.md": { content: "# Cite\n\nQuote the source.\n", sha256: sha256("# Cite\n\nQuote the source.\n") } });
  assert.deepEqual({ aliases: state.aliases, bindings: state.bindings, runs: state.runs, leases: state.leases, profiles: state.profiles }, { aliases: {}, bindings: {}, runs: {}, leases: {}, profiles: {} });
  assert.ok(existsSync(path.join(dir, "agent.sqlite")) && existsSync(path.join(dir, "runs")));
});

test("an agent without an id gets a UUIDv7, and a minimal definition keeps no optional field", async () => {
  const before = Date.now();
  const home = await createAgentHome(await scratch(), { definition: { ...DEFINITION, instructions: "" } });
  assert.match(home.identity.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const ms = Number.parseInt(home.identity.id.replaceAll("-", "").slice(0, 12), 16);
  assert.ok(ms >= before && ms <= Date.now(), "the id starts with its creation time");
  const { definition } = await readAgentHome(home);
  assert.deepEqual(definition, { ...DEFINITION, instructions: "", id: home.identity.id });
});

test("a definition with a model, a thinking level or a malformed field is refused, and nothing is created", async () => {
  const root = await scratch();
  const cases = [
    [{ ...FULL, model: "some-model" }, /model/],
    [{ ...FULL, thinkingLevel: "high" }, /thinkingLevel/],
    [{ ...FULL, version: 0 }, /version/],
    [{ ...FULL, tools: ["browser", "browser"] }, /tools/],
    [{ ...FULL, skills: "cite" }, /skills/],
    [{ ...FULL, workflow: [] }, /workflow/],
    [{ ...FULL, max_cost_usd: -1 }, /max_cost_usd/],
    [{ ...FULL, instructions: undefined }, /instructions/],
    [{ ...FULL, id: "" }, /id/],
  ];
  for (const [index, [definition, pattern]] of cases.entries()) {
    const dir = path.join(root, `case-${index}`);
    await assert.rejects(createAgentHome(dir, { definition }), refused("invalid", pattern));
    assert.ok(!existsSync(dir), `case ${index} created nothing`);
  }
  for (const file of ["../escape.md", "/abs.md", "a//b.md", "a\\b.md", "./a.md"]) {
    await assert.rejects(createAgentHome(path.join(root, "skills"), { definition: DEFINITION, skills: { [file]: "x" } }), refused("invalid", /skill path/));
  }
  assert.ok(!existsSync(path.join(root, "skills")));
});

test("a directory that already holds an agent home is refused, and a directory without one does not open", async () => {
  const dir = await scratch();
  const home = await createAgentHome(dir, { definition: DEFINITION });
  await assert.rejects(createAgentHome(dir, { definition: DEFINITION }), refused("exists"));
  assert.deepEqual((await openAgentHome(dir)).identity, home.identity);
  await assert.rejects(openAgentHome(path.join(dir, "runs")), refused("missing"));
});

test("aliases and bindings are kept per host, and a host's bindings are replaced as a whole", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION });
  await setAlias(home, "parcha", "exp_123");
  await setBindings(home, "parcha", { web_search: "mcp:https://tools.example.com/mcp", browser: "local" });
  await setBindings(home, "laptop", { browser: "local" });
  await setBindings(home, "parcha", { web_search: "hosted:search" });
  const state = await readAgentHome(home);
  assert.deepEqual(state.aliases, { parcha: { externalId: "exp_123" } });
  assert.deepEqual(state.bindings, { parcha: { web_search: "hosted:search" }, laptop: { browser: "local" } });
  await assert.rejects(setAlias(home, "", "x"), refused("invalid"));
  await assert.rejects(setBindings(home, "parcha", { browser: "" }), refused("invalid"));
});

test("another process reopens the home and reads back everything this one wrote", async () => {
  const dir = await scratch();
  const home = await createAgentHome(dir, { definition: FULL, skills: { "cite/SKILL.md": "# Cite\n" } });
  await setAlias(home, "parcha", "exp_123");
  const mine = await readAgentHome(home);
  const index = new URL("../dist/index.js", import.meta.url).href;
  const { done } = child(`
    const { openAgentHome, readAgentHome } = await import(${JSON.stringify(index)});
    console.log(JSON.stringify(await readAgentHome(await openAgentHome(${JSON.stringify(dir)}))));
  `);
  assert.deepEqual(JSON.parse(await done), mine);
});

test("a writer in another process holds the home, and the next writer waits for it", async () => {
  const dir = await scratch();
  const home = await createAgentHome(dir, { definition: DEFINITION });
  let held;
  const ready = new Promise((resolve) => { held = resolve; });
  const { done } = child(`
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(path.join(dir, "owner.lock"))}, { timeout: 0 });
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
    console.log("held");
    setTimeout(() => db.close(), 700);
  `, held);
  await ready;
  const started = Date.now();
  await setAlias(home, "parcha", "exp_after_wait");
  const waited = Date.now() - started;
  await done;
  assert.ok(waited >= 400, `the write waited for the other process (${waited} ms)`);
  assert.deepEqual((await readAgentHome(home)).aliases, { parcha: { externalId: "exp_after_wait" } });
});
