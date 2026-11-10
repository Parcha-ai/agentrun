// The plane shows bash's family only where a run of the agent gets it. Where the run's shell is follows one rule, the
// claim's (workspace/resolve-computer.ts runShellOf, read off the agent's computer setting and the server's folder mode):
// a computer that mounts the run's folder ("computer") gives bash and the five background tools; with none, Mode 2 runs
// bash on Archil's exec ("local") and the background tools are not there; Mode 1 ("none"), or a setting the server
// refuses, gives none of them. An agent's read (GET /agents/{id} tools) says a missing one is unavailable, in the words a
// call of it gets on that run (the kernel registry's NO_SHELL and NEEDS_A_COMPUTER), and capabilities shows bash where no
// box runs it only in Mode 2, whose exec runs it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { NEEDS_A_COMPUTER, NO_SHELL } from "@parcha/agentrun-kernel/kernel";
import { BACKGROUND_TOOLS } from "../dist/background.js";
import { agentTools, shellUnavailable } from "../dist/tool-plane.js";
import { agent, SECRET_WRITE_PATHS, serve as served, withEnv } from "./support.mjs";

const SHELL = ["bash", ...BACKGROUND_TOOLS];
const NO_BASH = `unavailable: ${NO_SHELL}`;
const NO_BACKGROUND = `unavailable: ${NEEDS_A_COMPUTER}`;
/** Each tool of the family to what its read resolves to: undefined where it is there. */
const resolvedOf = (tools) => Object.fromEntries(SHELL.map((name) => [name, tools.find((tool) => tool.name === name)?.resolved]));
const there = Object.fromEntries(SHELL.map((name) => [name, undefined]));
const none = Object.fromEntries(SHELL.map((name) => [name, name === "bash" ? NO_BASH : NO_BACKGROUND]));
const local = Object.fromEntries(SHELL.map((name) => [name, name === "bash" ? undefined : NO_BACKGROUND]));

// The Archil settings' PUT is a secret write (archil-routes.ts): the client sends it from the owner's session.
SECRET_WRITE_PATHS.push({ methods: ["PUT"], path: /^\/workspace\/archil$/ });
const ARCHIL = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example", keys: { ARCHIL_API_KEY: "fake-test-key" } };

async function serve(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  return served(t, { runner: false, accounts: true, openSetup: true });
}

test("each shell place, the family as a run of it gets it: all on a computer, bash alone on Archil's exec, none with no shell", () => {
  for (const name of SHELL) assert.equal(shellUnavailable(name, "computer"), undefined, `${name} on a computer`);
  assert.deepEqual(Object.fromEntries(SHELL.map((name) => [name, shellUnavailable(name, "local")])), local);
  assert.deepEqual(Object.fromEntries(SHELL.map((name) => [name, shellUnavailable(name, "none")])), none);
  for (const name of ["read", "write", "web_fetch", "browser"]) assert.equal(shellUnavailable(name, "none"), undefined, `${name} is no tool of the family`);
  const tooling = { tools: ["read", ...SHELL] };
  const order = ["read", ...SHELL];
  assert.deepEqual(resolvedOf(agentTools(process.env, {}, tooling, order, "computer")), there);
  assert.deepEqual(resolvedOf(agentTools(process.env, {}, tooling, order, "local")), local);
  assert.deepEqual(resolvedOf(agentTools(process.env, {}, tooling, order, "none")), none);
  assert.equal(agentTools(process.env, {}, tooling, order, "none").find((tool) => tool.name === "read").resolved, undefined, "read stays as it was");
});

test("an agent's read follows its computer setting and the folder mode now: Mode 1 a Docker sandbox has the family and a Daytona one none; Mode 2 the other way round", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  // Saved in Mode 1, each with the whole family. Neither box runs here (each saves with a warning), and the plane reads
  // the setting, as the claim does, never whether its box answers now.
  for (const [id, provider] of [["docked", "docker"], ["remote", "daytona"]]) {
    const made = await api("POST", "/agents", agent(id, { computer: { kind: "sandbox", provider }, tools: SHELL }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
  }
  const read = async (id) => resolvedOf((await api("GET", `/agents/${id}`)).body.tools);
  assert.deepEqual(await read("docked"), there, "Mode 1: Docker binds the run's folder, so its sandbox is the run's shell");
  assert.deepEqual(await read("remote"), none, "Mode 1: a Daytona sandbox cannot reach a folder of this machine, so the run has no shell");

  // Mode 2: the folder is on Archil, which a Daytona sandbox mounts and a local Docker one cannot.
  const on = await api("PUT", "/workspace/archil", ARCHIL);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(await read("docked"), none, "Mode 2: a Docker sandbox cannot mount Archil, so the run has no shell");
  assert.deepEqual(await read("remote"), there, "Mode 2: Daytona mounts the folder, so its sandbox is the run's shell");

  assert.equal((await api("DELETE", "/workspace/archil")).body.on, false);
  assert.deepEqual(await read("docked"), there, "back in Mode 1");
  assert.deepEqual(await read("remote"), none, "back in Mode 1");
});

test("capabilities with no box: bash is unavailable in Mode 1 and available in Mode 2, on Archil's exec; the background tools need a box in both", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const family = async () => Object.fromEntries((await api("GET", "/capabilities")).body.tools.filter((tool) => SHELL.includes(tool.name)).map((tool) => [tool.name, [tool.available, tool.reason]]));
  const mode1 = await family();
  const noBox = mode1.bash[1];
  assert.match(noBox ?? "", /^no box is set up on this server/, JSON.stringify(mode1));
  assert.deepEqual(mode1, Object.fromEntries(SHELL.map((name) => [name, [false, noBox]])), "Mode 1 with no box: none of the family");

  assert.equal((await api("PUT", "/workspace/archil", ARCHIL)).status, 200);
  assert.deepEqual(await family(), Object.fromEntries(SHELL.map((name) => [name, name === "bash" ? [true, undefined] : [false, noBox]])), "Mode 2: bash on Archil's exec, the background tools still need a box");

  assert.equal((await api("DELETE", "/workspace/archil")).body.on, false);
  assert.deepEqual(await family(), mode1, "back in Mode 1");
});
