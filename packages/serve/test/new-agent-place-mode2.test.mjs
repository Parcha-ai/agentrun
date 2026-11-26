// In Mode 2 a new agent's default place is the runner, never Docker's box: the folder is on Archil, and a local Docker
// computer can't mount it (resolve-computer.ts refuses such a sandbox in Mode 2). capabilities' places.default_place says
// so, and an agent that names no place and a shell tool (bash, as a race lane or the agent form sends it) resolves to
// the runner, where Archil's serverless exec runs bash, so its run starts instead of being refused for a Docker sandbox.
// No Docker command runs here: a fake `docker` first on PATH answers the probe.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { boxesLine, defaultPlaceOf, placesOf } from "../dist/place.js";
import { scratch, SECRET_WRITE_PATHS, serve, withEnv } from "./support.mjs";

SECRET_WRITE_PATHS.push({ methods: ["PUT"], path: /^\/workspace\/archil$/ });
const ARCHIL = { region: "aws-us-east-1", s3Url: "https://s3.archil.example", keys: { ARCHIL_API_KEY: "fake-test-key" } };
const DOCKER_WORDS = /Mode 2 keeps workspaces on Archil; a local Docker computer can't mount them/;
const flags = (tool) => ({ bash: { sandboxOnly: true }, bash_background: { sandboxOnly: true }, browser: { runnerOnly: true } })[tool];

/** A server with a fake `docker` that answers, in Mode 2 when `archil`. */
async function dockerServer(t, { archil }) {
  const bin = join(await scratch(t), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = version ]; then echo 27.0.0-fake; exit 0; fi\nexit 0\n`);
  chmodSync(join(bin, "docker"), 0o755);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), PATH: `${bin}:${process.env.PATH}` }, ["AGENTRUN_BOXES", "ARCHIL_API_KEY", "AGENTRUN_DOCKER_IMAGE"]);
  const served = await serve(t, { accounts: true, openSetup: true });
  if (archil) {
    const saved = await served.api("PUT", "/workspace/archil", ARCHIL);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  return served;
}

/** A race lane's agent as the console sends it (race.ts laneStart): a harness, a model, `tools`, no place, no computer. */
const lane = (id, harness, model, tools) => ({ definition: { id, version: 1, name: id, instructions: "Do the task you are given.", harness, model, tools, skills: [] } });

test("placesOf and defaultPlaceOf: Docker's box is the default where the runner has no shell (Mode 1); where it has one (Mode 2) the runner is, Docker answering or not", () => {
  const docker = [{ id: "docker", available: true }];
  assert.deepEqual(placesOf(docker, "none", false).default_place, { mode: "sandbox", box: "docker" });
  assert.deepEqual(defaultPlaceOf("agentic", ["bash"], docker, flags, false), { mode: "sandbox", box: "docker" });
  const mode2 = placesOf(docker, "none", true);
  assert.deepEqual(mode2.default_place, { mode: "runner" }, "Mode 2: never Docker's box");
  assert.equal("default_reason" in mode2, false);
  for (const tools of [["bash"], ["read", "bash", "bash_background"]]) assert.deepEqual(defaultPlaceOf("agentic", tools, docker, flags, true), { mode: "runner" }, JSON.stringify(tools));
  // The start's Boxes line says the same.
  assert.equal(boxesLine(docker, new Set(), "none", true, false), "Boxes: docker (on by default; set AGENTRUN_BOXES to change).");
  assert.equal(boxesLine(docker, new Set(), "none", true, true), "Boxes: docker (on by default; set AGENTRUN_BOXES to change). New agents run on the runner: Mode 2 keeps workspaces on Archil, which the docker box can't mount.");
});

test("Mode 2 with Docker answering: default_place is the runner, and a race lane's agent with bash and no place starts its run on the runner, never refused for a Docker sandbox", async (t) => {
  const { api } = await dockerServer(t, { archil: true });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.places.default_place, { mode: "runner" }, JSON.stringify(caps.places));
  const harness = caps.harnesses.find((one) => one.available && one.default_model);
  assert.ok(harness, JSON.stringify(caps.harnesses));
  const made = await api("POST", "/agents", lane("race-mode2-1-1", harness.id, harness.default_model, ["read", "write", "bash"]));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.definition?.place, undefined, "no place stamped: it runs where a no-place agent does");
  const started = await api("POST", "/agents/race-mode2-1-1/runs", { input: { content: "Say hi." }, max_cost_usd: 1, labels: { race: "mode2", lane: "1" } });
  assert.ok(started.status === 201 || started.status === 202, JSON.stringify(started.body));
  assert.doesNotMatch(JSON.stringify(started.body), DOCKER_WORDS);
  assert.deepEqual(started.body.run?.place ?? started.body.place, { mode: "runner" }, JSON.stringify(started.body));
});

test("Mode 1 with Docker answering: default_place stays Docker's box", async (t) => {
  const { api } = await dockerServer(t, { archil: false });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.places.default_place, { mode: "sandbox", box: "docker" });
});
