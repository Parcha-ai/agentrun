// An agent with a computer setting is checked at its save and its run's start by the answers the claim gives
// (resolve-computer.ts computerReadiness: the provider and the kind it serves, the mode's mount, the provider's keys), not
// as one of the old boxes (boxes.ts BOX_IDS, only those AGENTRUN_BOXES lists, docker alone by default); an agent with only
// an old place keeps the box check (runnable.ts).
//
// So a remote sandbox (E2B, Daytona) with its key saved in Settings → Computers runs in Mode 2 (the server's Archil
// settings saved, so it mounts the run's folder from Archil): its save says nothing of its place, and its run is never
// refused for it. One whose key is not saved is refused in words that name Settings → Computers. In Mode 1 a sandbox needs
// a bind mount of this machine's folder, which only Docker gives: an E2B sandbox is refused in those words, and a Docker
// one runs where Docker answers; where it does not, it is refused at the start in the Docker box probe's words (a fake
// `docker` first on PATH stands in for Docker either way: no Docker command runs here). The real server path: the keys go through the owner's routes, the agent through POST /v2/agents, its run
// through POST /v2/agents/{id}/runs. No provider is called; the key values are the export fakes. A run may still be
// refused for having no model key (none is saved here); only a refusal for its computer or its place is asserted on.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { scratch, SECRET_WRITE_PATHS, serve, withEnv } from "./support.mjs";

const { blockersOf } = await import("../dist/runnable.js");

// A computer key's save and the Archil settings' PUT are secret writes: the client sends them from the owner's session.
SECRET_WRITE_PATHS.push({ methods: ["PUT"], path: /^\/computers\/[^/]+\/keys$/ }, { methods: ["PUT"], path: /^\/workspace\/archil$/ });

const ARCHIL = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example", keys: { ARCHIL_API_KEY: "fake-test-key" } };
/** The words runnable.ts says of a place this server can't run as a box. */
const PLACE_WORDS = /This agent's place is sandbox on [a-z0-9-]+, and this server cannot run it there/;
/** No provider key comes from this process's environment: each is the one saved here, or none. */
const UNSET = ["AGENTRUN_SEAL_KEY", "AGENTRUN_BOXES", "E2B_API_KEY", "DAYTONA_API_KEY", "ARCHIL_API_KEY"];

/** A fake `docker` first on PATH, so the server's start-time probe of the Docker box (boxes.ts: `docker version`) never
 *  reaches a real one: it names a daemon's version when `answers`, else fails as a CLI with no daemon does. Every other
 *  call is a quiet success (an image it is asked about is there). */
async function fakeDocker(t, answers) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  const version = answers ? "echo 27.0.0-fake; exit 0" : "echo 'Cannot connect to the Docker daemon' >&2; exit 1";
  await writeFile(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = version ]; then ${version}; fi\nexit 0\n`, { mode: 0o755 });
  await chmod(join(bin, "docker"), 0o755);
  return `${bin}:${process.env.PATH}`;
}

/** A server with the real computer registry (no --faux), the server alone, with the default boxes (docker alone, on a
 *  fake that `docker` answers or not); in Mode 2 when `archil`. */
async function server(t, { archil, docker = false }) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), PATH: await fakeDocker(t, docker) }, UNSET);
  const { api } = await serve(t, { faux: undefined, runner: false, accounts: true, openSetup: true });
  if (archil) {
    const saved = await api("PUT", "/workspace/archil", ARCHIL);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  return api;
}

/** An agent with `setting` (its computer, or its place), saved and started: its save's warnings and its run's refusal, on its computer or its place. */
async function saveAndStart(api, id, setting) {
  const made = await api("POST", "/agents", { definition: { id, version: 1, name: id, instructions: "Answer.", skills: [], tools: [], ...setting } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Answer." } });
  const ours = (one) => one.field === "definition.computer" || one.field === "definition.place";
  return {
    saved: (made.body.warnings ?? []).filter(ours).map((one) => [one.field, one.reason, one.message]),
    refused: (started.body?.error?.fields ?? []).filter(ours).map((one) => [one.field, one.reason, one.message]),
    started: [started.status, started.body?.error?.code, started.body?.error?.message],
  };
}

for (const [provider, keys] of [["e2b", { E2B_API_KEY: "fake-test-key" }], ["daytona", { DAYTONA_API_KEY: "fake-test-key" }]]) {
  test(`an agent whose computer is a ${provider} sandbox, its key saved in Settings → Computers, is never refused for its place in Mode 2 (AGENTRUN_BOXES unset)`, async (t) => {
    const api = await server(t, { archil: true });
    const saved = await api("PUT", `/computers/${provider}/keys`, keys);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.ready, true, `${provider} is ready with its key saved: ${JSON.stringify(saved.body)}`);

    const said = await saveAndStart(api, `remote-${provider}`, { computer: { kind: "sandbox", provider } });
    assert.deepEqual(said.saved, [], `the agent is saved with a warning on its computer or place: ${JSON.stringify(said)}`);
    assert.deepEqual(said.refused, [], `the run is refused for its computer or place: ${JSON.stringify(said)}`);
    assert.doesNotMatch(said.started[2] ?? "", PLACE_WORDS, `the run is refused for its place: ${JSON.stringify(said)}`);
  });
}

test("an agent whose computer is an e2b sandbox with no key saved is refused in Mode 2 in words that name Settings → Computers", async (t) => {
  const api = await server(t, { archil: true });
  const said = await saveAndStart(api, "remote-unkeyed", { computer: { kind: "sandbox", provider: "e2b" } });
  const words = /E2B.* needs its key E2B_API_KEY saved: add it in Settings → Computers\./;
  // A setting this host fixes: a warning at the save, the run refused at its start (409), never for its place as a box.
  assert.equal(said.saved.length, 1, JSON.stringify(said));
  assert.deepEqual(said.saved[0].slice(0, 2), ["definition.computer", "not_set_up_here"], JSON.stringify(said));
  assert.match(said.saved[0][2], words);
  assert.equal(said.refused.length, 1, JSON.stringify(said));
  assert.deepEqual(said.refused[0].slice(0, 2), ["definition.computer", "not_set_up_here"], JSON.stringify(said));
  assert.match(said.refused[0][2], words);
  assert.equal(said.started[1], "agent_not_runnable", JSON.stringify(said));
  assert.doesNotMatch(said.started[2], PLACE_WORDS);
});

test("Mode 1: an e2b sandbox is refused, as a sandbox there needs a bind mount of this machine's folder, which only Docker gives", async (t) => {
  // main's design (resolve-computer.ts): Mode 1 runs a sandbox only on Docker, whose bind mount reaches the run's folder on
  // this machine; a remote sandbox cannot, whatever keys it has.
  const api = await server(t, { archil: false });
  const saved = await api("PUT", "/computers/e2b/keys", { E2B_API_KEY: "fake-test-key" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const said = await saveAndStart(api, "remote-mode1", { computer: { kind: "sandbox", provider: "e2b" } });
  const words = /^Mode 1 runs a sandbox only on Docker: a E2B sandbox can't reach the run's folder on this machine\. Pick Docker for this agent's computer in Settings → Computers, or another kind of computer\.$/;
  assert.equal(said.refused.length, 1, JSON.stringify(said));
  assert.deepEqual(said.refused[0].slice(0, 2), ["definition.computer", "not_set_up_here"], JSON.stringify(said));
  assert.match(said.refused[0][2], words);
  assert.equal(said.started[1], "agent_not_runnable", JSON.stringify(said));
  assert.doesNotMatch(said.started[2], PLACE_WORDS);
});

test("Mode 1: an agent whose computer is a Docker sandbox still runs where Docker answers (no refusal for its computer or place)", async (t) => {
  const api = await server(t, { archil: false, docker: true });
  const said = await saveAndStart(api, "local-docker", { computer: { kind: "sandbox", provider: "docker" } });
  assert.deepEqual(said.saved, [], JSON.stringify(said));
  assert.deepEqual(said.refused, [], JSON.stringify(said));
  // What is left is the model key this test saves none of: nothing of its computer keeps it from running.
  assert.deepEqual(said.started.slice(0, 2), [409, "agent_not_runnable"], JSON.stringify(said));
  assert.match(said.started[2], /^No model yet: add a model key in Settings → Model keys[^.]*\.$/, JSON.stringify(said));
});

test("Mode 1: an agent saved with place {sandbox, docker} on a host where Docker does not answer is refused at its run's start (409), in the box's own words with their fix", async (t) => {
  // The claim has no answer of Docker's: it would only fail to launch it, later, as computer_unavailable. The start's check
  // asks the boxes' start-time probe (in memory, no new probe) and refuses it now, with the probe's reason.
  const api = await server(t, { archil: false, docker: false });
  const said = await saveAndStart(api, "docker-down", { place: { mode: "sandbox", box: "docker" } });
  const words = "This agent's computer is a Docker sandbox, and this server cannot run it: Docker isn't running on this machine, or this user may not use it (docker version failed: exit 1): start Docker, or add this user to the docker group, then restart AgentRun.";
  assert.deepEqual(said.saved, [["definition.computer", "not_set_up_here", words]], JSON.stringify(said));
  assert.deepEqual(said.refused, [["definition.computer", "not_set_up_here", words]], JSON.stringify(said));
  assert.deepEqual(said.started.slice(0, 2), [409, "agent_not_runnable"], JSON.stringify(said));
});

test("an agent with only an old place {mode: sandbox, box: docker} keeps the box check; one with a computer setting is asked the readiness instead", async () => {
  // A revision saved before the computer setting keeps its place alone: the API saves both now (computer-setting.ts), so it
  // is reached here, at runnable.ts, with the server's own options shape. No box is set up (boxes: none), so the box
  // check refuses it in the place words; the readiness is never asked for it.
  const asked = [];
  const computerReady = async (setting) => { asked.push(setting); return { ok: true }; };
  const options = { boxes: [], offers: [{ id: "pi", available: true }], computerReady };
  const place = { mode: "sandbox", box: "docker" };
  const old = (await blockersOf({}, { kind: "agentic", instructions: "Answer.", place }, {}, options)).filter((one) => one.field === "definition.place" || one.field === "definition.computer");
  assert.deepEqual(old.map((one) => [one.field, one.reason, one.box]), [["definition.place", "not_set_up_here", "docker"]]);
  assert.match(old[0].message, /^This agent's place is sandbox on docker, and this server cannot run it there/);
  assert.deepEqual(asked, [], "an old place is never asked the computer readiness");

  // The same place with its computer setting: the readiness answers, and the box check is not made.
  const computer = { kind: "sandbox", provider: "docker" };
  const set = (await blockersOf({}, { kind: "agentic", instructions: "Answer.", place, computer }, {}, options)).filter((one) => one.field === "definition.place" || one.field === "definition.computer");
  assert.deepEqual(set, []);
  assert.deepEqual(asked, [computer]);
});
