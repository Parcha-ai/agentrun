import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  AgentHomeError, carryBack, createAgentHome, homeRevision, openAgentHome, readAgentHome, refreshAgentHome, setAlias, setBindings, startRun,
} from "../dist/index.js";
import { DEFINITION, scratch } from "./support.mjs";

const PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_1 = "1f0c9e2b7d4a8e3c5b6a7f8d9e0c1b2a3d4e5f60";
const SHA_2 = "9a8b7c6d5e4f30211203f4e5d6c7b8a990a1b2c3";
const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));

test("an agent id given in the definition must be one URL segment; a minted id is one", async () => {
  const root = await scratch();
  const bad = ["has space", "-leading", ".leading", "_leading", "a/b", "a:b", "ü", "a".repeat(129), "", 7];
  for (const [index, id] of bad.entries()) {
    const dir = path.join(root, `bad-${index}`);
    await assert.rejects(createAgentHome(dir, { definition: { ...DEFINITION, id } }), refused("invalid", /does not match \^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,127\}\$/), String(id));
    assert.equal(existsSync(dir), false);
  }
  for (const [index, id] of ["a", "Agent.v2_research-9", "7", "x".repeat(128)].entries()) {
    const home = await createAgentHome(path.join(root, `good-${index}`), { definition: { ...DEFINITION, id } });
    assert.equal(home.identity.id, id);
  }
  const minted = await createAgentHome(path.join(root, "minted"), { definition: DEFINITION });
  assert.match(minted.identity.id, PATTERN);
  assert.match(minted.identity.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(await refreshAgentHome(minted, { sha: SHA_1, definition: { ...DEFINITION, id: minted.identity.id }, skills: {} }), { changed: true });
  await assert.rejects(refreshAgentHome(minted, { sha: SHA_2, definition: { ...DEFINITION, id: "another-agent" }, skills: {} }), refused("invalid", /not this agent's id/));
});

test("homeRevision is the agent store's head commit: every write moves it by one; reads and a same-sha refresh do not", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n" }, sha: SHA_1 });
  const steps = [];
  const step = async (name, write) => { await write(); steps.push([name, await homeRevision(home)]); };
  steps.push(["create", await homeRevision(home)]);
  await step("setAlias", () => setAlias(home, "host-a", "ext-1"));
  await step("setBindings", () => setBindings(home, "host-a", { browser: "local" }));
  let run;
  await step("startRun", async () => { run = await startRun(home, { runId: "r1", host: "host-a" }); });
  await step("carryBack", () => carryBack(home, run, { outcome: "completed" }));
  await step("refresh", () => refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite v2\n" } }));
  await step("same-sha refresh", () => refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION, skills: {} }));
  await step("second carryBack", () => carryBack(home, run, { outcome: "completed" }));
  await step("reads", async () => { await readAgentHome(home); await openAgentHome(home.dir); await homeRevision(home); });
  assert.deepEqual(steps, [
    ["create", 1], ["setAlias", 2], ["setBindings", 3], ["startRun", 4], ["carryBack", 5], ["refresh", 6],
    ["same-sha refresh", 6], ["second carryBack", 6], ["reads", 6],
  ]);
});

test("homeRevision refuses a directory that is not an agent home", async () => {
  const dir = await scratch();
  await assert.rejects(homeRevision({ dir, identity: { id: "x", name: "x", formatVersion: 1 } }), refused("missing"));
});
