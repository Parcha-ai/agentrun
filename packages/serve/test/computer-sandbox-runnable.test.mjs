// An agent with a computer setting is checked at its save and its run's start by the answers the claim gives
// (resolve-computer.ts computerReadiness: the provider and the kind it serves, the mode's mount, the provider's keys), not
// as one of the old boxes (boxes.ts BOX_IDS, only those AGENTRUN_BOXES lists, docker alone by default); an agent with only
// an old place keeps the box check (runnable.ts).
//
// So a remote sandbox (E2B, Modal) with its key saved in Settings → Computers runs in Mode 2 (the server's Archil
// settings saved, so it mounts the run's folder from Archil): its save says nothing of its place, and its run is never
// refused for it. One whose key is not saved is refused in words that name Settings → Computers. In Mode 1 a sandbox needs
// a bind mount of this machine's folder, which only Docker gives: an E2B sandbox is refused in those words, and a Docker
// one runs where Docker answers; where it does not, it is refused at the start in the Docker box probe's words (a fake
// `docker` first on PATH stands in for Docker either way: no Docker command runs here). The real server path: the keys go through the owner's routes, the agent through POST /v2/agents, its run
// through POST /v2/agents/{id}/runs. No provider is called; the key values are the export fakes. A run may still be
// refused for having no model key (none is saved here); only a refusal for its computer or its place is asserted on.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { asOwner, scratch, SECRET_WRITE_PATHS, serve, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { twoToolPackage } from "./fixtures/two-tool-template.mjs";
import { NO_DOCKER_HERE } from "../dist/place-offers.js";

const { blockersOf } = await import("../dist/runnable.js");
const { computerDepsFrom, resolveComputer } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");

// A computer key's save and the Archil settings' PUT are secret writes: the client sends them from the owner's session.
SECRET_WRITE_PATHS.push({ methods: ["PUT"], path: /^\/computers\/[^/]+\/keys$/ }, { methods: ["PUT"], path: /^\/workspace\/archil$/ });

const ARCHIL = { region: "aws-us-east-1", s3Url: "https://s3.archil.example", keys: { ARCHIL_API_KEY: "fake-test-key" } };
/** The words runnable.ts says of a place this server can't run as a box. */
const PLACE_WORDS = /This agent's place is sandbox on [a-z0-9-]+, and this server cannot run it there/;
/** No provider key comes from this process's environment: each is the one saved here, or none. */
const UNSET = ["AGENTRUN_SEAL_KEY", "AGENTRUN_BOXES", "DOCKER_HOST", "DOCKER_CONTEXT", "E2B_API_KEY", "DAYTONA_API_KEY", "DAYTONA_ARCHIL_EGRESS", "AGENTRUN_DAYTONA_SNAPSHOT", "ARCHIL_API_KEY"];

/** A fake `docker` first on PATH, so the server's start-time probe of the Docker box (boxes.ts: `docker version`) never
 *  reaches a real one: it names a daemon's version when `answers`, else fails as a CLI with no daemon does. Every other
 *  call is a quiet success (an image it is asked about is there). With `adb`, a fake `adb` beside it, which the server
 *  only looks for on PATH (the phone provider's host command); without it, no folder of PATH holds an adb. */
async function fakeDocker(t, answers, adb = true) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  const version = answers ? "echo 27.0.0-fake; exit 0" : "echo 'Cannot connect to the Docker daemon' >&2; exit 1";
  await writeFile(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = version ]; then ${version}; fi\nexit 0\n`, { mode: 0o755 });
  await chmod(join(bin, "docker"), 0o755);
  if (adb) await writeFile(join(bin, "adb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const rest = (process.env.PATH ?? "").split(delimiter).filter((folder) => adb || !existsSync(join(folder, "adb")));
  return [bin, ...rest].join(delimiter);
}

/** A server alone, with the default boxes (docker alone, on a fake that `docker` answers or not), and an `adb` on PATH
 *  unless `adb` is false; on the real models (no --faux) unless `faux`; in Mode 2 when `archil`; with the template
 *  packages in `templates`, when given; its client sends every request from the owner's session when `owner`. */
async function server(t, { archil, docker = false, faux = false, adb = true, templates, owner = false, env = {}, probeContainer }) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), PATH: await fakeDocker(t, docker, adb), ...env }, UNSET);
  const started = await serve(t, { ...(faux ? {} : { faux: undefined }), runner: false, accounts: true, openSetup: true, ...(templates ? { templates } : {}), ...(probeContainer ? { probeContainer } : {}) });
  const api = owner ? asOwner(started) : started.api;
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

for (const kind of ["sandbox", "desktop"]) {
  test(`Mode 2: an agent whose computer is an E2B ${kind}, its key saved, is ready, warned of nothing at its save and never refused for its computer or its place at its run's start: E2B starts from the box template its prepareImage() answers`, async (t) => {
    const api = await server(t, { archil: true });
    const saved = await api("PUT", "/computers/e2b/keys", { E2B_API_KEY: "fake-test-key" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.ready, saved.body.why], [true, undefined], JSON.stringify(saved.body));
    const said = await saveAndStart(api, `remote-e2b-${kind}`, { computer: { kind, provider: "e2b" } });
    assert.deepEqual([said.saved, said.refused], [[], []], JSON.stringify(said));
    assert.doesNotMatch(said.started[2] ?? "", /E2B (sandbox|desktop) can't/, JSON.stringify(said));
    assert.doesNotMatch(said.started[2] ?? "", PLACE_WORDS, JSON.stringify(said));
  });
}

test("Mode 2: an agent whose computer is a Modal sandbox, its keys saved, is ready, warned of nothing at its save and never refused for its computer at its run's start: Modal starts from the box image its prepareImage() answers", async (t) => {
  const api = await server(t, { archil: true });
  const saved = await api("PUT", "/computers/modal/keys", { MODAL_TOKEN_ID: "fake-test-id", MODAL_TOKEN_SECRET: "fake-test-key" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.ready, saved.body.why], [true, undefined], JSON.stringify(saved.body));
  const said = await saveAndStart(api, "remote-modal", { computer: { kind: "sandbox", provider: "modal" } });
  assert.deepEqual([said.saved, said.refused], [[], []], JSON.stringify(said));
  assert.doesNotMatch(said.started[2] ?? "", /Modal sandbox can't/, JSON.stringify(said));
  assert.doesNotMatch(said.started[2] ?? "", PLACE_WORDS, JSON.stringify(said));
});

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

/** A Daytona sandbox ready in Mode 2: warned of nothing at its save, never refused for its computer at its run's start. */
const ready = (said) => {
  assert.deepEqual([said.saved, said.refused], [[], []], JSON.stringify(said));
  assert.doesNotMatch(said.started[2] ?? "", /Daytona sandbox can't/, JSON.stringify(said));
};

test("Mode 2: a Daytona sandbox on hosted Daytona (no DAYTONA_ARCHIL_EGRESS), with GPUs or without, holds a synced folder: ready, warned of nothing at its save and never refused for its computer at its run's start", async (t) => {
  const api = await server(t, { archil: true });
  assert.equal((await api("PUT", "/computers/daytona/keys", { DAYTONA_API_KEY: "fake-test-key" })).status, 200);
  for (const [name, gpu] of [["no-gpu", undefined], ["gpu", { type: "H100", count: 1 }]]) ready(await saveAndStart(api, name, { computer: { kind: "sandbox", provider: "daytona", ...(gpu ? { gpu } : {}) } }));
});

// A self-hosted Daytona target with an Archil egress relay mounts Archil (a run on one completed in Mode 2, 11-14). With
// DAYTONA_ARCHIL_EGRESS saved, a Daytona sandbox mounts the run's folder where it starts from the operator's snapshot of
// box/Dockerfile, which AGENTRUN_DAYTONA_SNAPSHOT names; without the snapshot, or on a GPU (no /dev/fuse), it holds a
// synced folder instead. Ready either way.
const DAYTONA_KEY = "daytona-fake-key-must-never-be-echoed";
const EGRESS = "192.0.2.40:18100:42050";
const SNAPSHOT = "agentrun-archil-0123456789ab";

for (const snapshot of [SNAPSHOT, undefined]) {
  test(`Mode 2: with DAYTONA_ARCHIL_EGRESS saved and ${snapshot ? "AGENTRUN_DAYTONA_SNAPSHOT named" : "no AGENTRUN_DAYTONA_SNAPSHOT"}, a Daytona sandbox, with GPUs or without, is ready, warned of nothing at its save and never refused for its computer at its run's start`, async (t) => {
    const api = await server(t, { archil: true, env: snapshot ? { AGENTRUN_DAYTONA_SNAPSHOT: snapshot } : {} });
    const saved = await api("PUT", "/computers/daytona/keys", { DAYTONA_API_KEY: DAYTONA_KEY, DAYTONA_ARCHIL_EGRESS: EGRESS });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.ready, saved.body.why], [true, undefined], JSON.stringify(saved.body));
    const said = await saveAndStart(api, "daytona-egress", { computer: { kind: "sandbox", provider: "daytona" } });
    ready(said);
    const gpu = await saveAndStart(api, "daytona-egress-gpu", { computer: { kind: "sandbox", provider: "daytona", gpu: { type: "H100", count: 1 } } });
    ready(gpu);
    for (const text of [JSON.stringify(said), JSON.stringify(gpu), JSON.stringify(saved.body)]) assert.ok(!text.includes(DAYTONA_KEY), "no key in a save's, a start's or the view's words");
  });
}

test("Mode 2: a DAYTONA_ARCHIL_EGRESS of whitespace alone is refused at its save; Settings and the run's start agree the sandbox is ready, on a synced folder", async (t) => {
  const api = await server(t, { archil: true, env: { AGENTRUN_DAYTONA_SNAPSHOT: SNAPSHOT } });
  assert.equal((await api("PUT", "/computers/daytona/keys", { DAYTONA_API_KEY: DAYTONA_KEY })).status, 200);
  const blank = await api("PUT", "/computers/daytona/keys", { DAYTONA_ARCHIL_EGRESS: "   " });
  assert.equal(blank.status, 422, JSON.stringify(blank.body));
  assert.match(JSON.stringify(blank.body), /DAYTONA_ARCHIL_EGRESS is a non-empty string/);
  const view = await api("GET", "/computers");
  const daytona = view.body.kinds.find((one) => one.kind === "sandbox").providers.find((one) => one.id === "daytona");
  assert.deepEqual([daytona.ready, daytona.why], [true, undefined], JSON.stringify(daytona));
  ready(await saveAndStart(api, "daytona-blank-egress", { computer: { kind: "sandbox", provider: "daytona" } }));
});

// A computer that runs only on the vendor's own network (the cloud phone's provider declares network "open" alone): on a
// server whose AGENTRUN_BOX_ALLOW is none, the operator's word for no network at all, its run is refused at the start in
// words naming the setting, as the claim refuses it; under the default list (the setting unset) or the operator's own
// list it is not, and runs open (the claim's networkOf).
const noNetwork = (what) => `This agent's computer is a ${what}, which needs a network (the vendor's own, or public addresses from this machine), and this server's AGENTRUN_BOX_ALLOW is none (no network): pick a computer that runs with no network in Settings → Computers, or restart the server with AGENTRUN_BOX_ALLOW set to a host list.`;
const NO_NETWORK_PHONE = noNetwork("Phone harness phone");
for (const boxAllow of ["none", undefined, "pypi.org"]) {
  const refused = boxAllow === "none";
  test(`a cloud phone, its key saved, is ${refused ? "refused at its run's start in words" : "not refused for its network"} where AGENTRUN_BOX_ALLOW is ${boxAllow ?? "unset"}`, async (t) => {
    withEnv(t, boxAllow === undefined ? {} : { AGENTRUN_BOX_ALLOW: boxAllow }, ["AGENTRUN_BOX_ALLOW"]);
    const api = await server(t, {});
    const saved = await api("PUT", "/computers/phone-harness/keys", { PHONE_HARNESS_API_KEY: "fake-test-key" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const said = await saveAndStart(api, `phone-${boxAllow ?? "unset"}`.replace(/\./g, "-"), { computer: { kind: "phone", provider: "phone-harness" } });
    if (!refused) {
      assert.deepEqual(said.refused, [], `the run is refused for its computer: ${JSON.stringify(said)}`);
      return;
    }
    assert.deepEqual(said.refused.map((one) => one.slice(0, 2)), [["definition.computer", "not_set_up_here"]], JSON.stringify(said));
    assert.equal(said.refused[0][2], NO_NETWORK_PHONE);
    assert.equal(said.started[1], "agent_not_runnable", JSON.stringify(said));
  });
}

// The phone provider drives its phone with adb on this machine. With no adb on PATH at the server's start, Settings →
// Computers says so in words of what to install, its key saved or not, and the run is refused at its start in the same
// words, as Docker's box is when no docker answers.
const NO_ADB = "adb isn't installed on this server (no adb command on PATH): install Android platform-tools, then restart AgentRun";
test("a cloud phone on a server with no adb on its PATH is not ready in Settings, and its run is refused at its start in words", async (t) => {
  const api = await server(t, { adb: false });
  const saved = await api("PUT", "/computers/phone-harness/keys", { PHONE_HARNESS_API_KEY: "fake-test-key" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.ready, saved.body.why], [false, NO_ADB]);
  const listed = (await api("GET", "/computers")).body.kinds.find((one) => one.kind === "phone").providers.find((one) => one.id === "phone-harness");
  assert.deepEqual([listed.ready, listed.why], [false, NO_ADB]);
  const said = await saveAndStart(api, "phone-no-adb", { computer: { kind: "phone", provider: "phone-harness" } });
  assert.deepEqual(said.refused.map((one) => one.slice(0, 2)), [["definition.computer", "not_set_up_here"]], JSON.stringify(said));
  assert.equal(said.refused[0][2], `This agent's computer is a Phone harness phone, and this server cannot run it: ${NO_ADB}.`);
  assert.equal(said.started[1], "agent_not_runnable", JSON.stringify(said));
});

// A computer every tool of which is set to deny is never started (computer-all-denied.test.mjs): its save warns in words,
// on definition.computer, and its run's start asks nothing of it, so a phone with no adb or no key saved starts the run.
// With its tools allowed, nothing is said of it at the save. The agent's own deny and the server's alike.
const ALL_DENIED_PHONE = "Every tool for this agent's phone is set to deny, so a run never starts it: allow one, or set the computer to none.";
for (const [where, setUp] of [["for this agent", async () => ({ tool_settings: { phone: { permission: "deny" } } })], ["on this server", async (api) => {
  assert.equal((await api("PUT", "/settings/tools", { phone: { permission: "deny" } })).status, 200);
  return {};
}]]) {
  test(`a phone set to deny ${where} saves with a warning that a run never starts it, and its run is not refused for it, with no adb and no key saved`, async (t) => {
    const api = await server(t, { adb: false });
    const said = await saveAndStart(api, `phone-denied-${where.replace(/ /g, "-")}`, { computer: { kind: "phone", provider: "phone-harness" }, ...(await setUp(api)) });
    assert.deepEqual(said.saved, [["definition.computer", "not_allowed", ALL_DENIED_PHONE]], JSON.stringify(said));
    assert.deepEqual(said.refused, [], `the run is not refused for its phone: ${JSON.stringify(said)}`);
  });
}

test("a phone allowed, its key saved, saves with no warning on its computer", async (t) => {
  const api = await server(t, {});
  assert.equal((await api("PUT", "/computers/phone-harness/keys", { PHONE_HARNESS_API_KEY: "fake-test-key" })).status, 200);
  const said = await saveAndStart(api, "phone-allowed", { computer: { kind: "phone", provider: "phone-harness" }, tool_settings: { phone: { permission: "allow" } } });
  assert.deepEqual([said.saved, said.refused], [[], []], JSON.stringify(said));
});

test("under --faux, a desktop set to deny saves with the warning, and one allowed with none", async (t) => {
  const api = await server(t, { faux: true });
  const denied = await saveAndStart(api, "faux-desk-denied", { computer: { kind: "desktop", provider: "faux-desktop" }, tool_settings: { desktop: { permission: "deny" } } });
  assert.deepEqual(denied.saved, [["definition.computer", "not_allowed", ALL_DENIED_PHONE.replace("phone", "desktop")]], JSON.stringify(denied));
  const allowed = await saveAndStart(api, "faux-desk-allowed", { computer: { kind: "desktop", provider: "faux-desktop" } });
  assert.deepEqual(allowed.saved, [], JSON.stringify(allowed));
});

// Local Chrome declares "open" and "allow", never "none" (public addresses from this machine, through its egress proxy):
// under none, the operator's word for no network at all, a browser on it is refused at the start in the same words, by
// its own name; under the default list (open) or the operator's own (that list) it is not refused for its network.
for (const boxAllow of ["none", undefined, "pypi.org"]) {
  const refused = boxAllow === "none";
  test(`a Local Chrome browser is ${refused ? "refused at its run's start in words" : "not refused for its network"} where AGENTRUN_BOX_ALLOW is ${boxAllow ?? "unset"}`, async (t) => {
    withEnv(t, boxAllow === undefined ? {} : { AGENTRUN_BOX_ALLOW: boxAllow }, ["AGENTRUN_BOX_ALLOW"]);
    const api = await server(t, {});
    const said = await saveAndStart(api, `local-${boxAllow ?? "unset"}`.replace(/\./g, "-"), { computer: { kind: "browser", provider: "local-chrome" } });
    if (!refused) {
      assert.ok(!said.refused.some((one) => /AGENTRUN_BOX_ALLOW/.test(one[2])), `the run is not refused for its network: ${JSON.stringify(said)}`);
      return;
    }
    assert.deepEqual(said.refused.map((one) => one.slice(0, 2)), [["definition.computer", "not_set_up_here"]], JSON.stringify(said));
    assert.equal(said.refused[0][2], noNetwork("Local Chrome browser"));
    assert.equal(said.started[1], "agent_not_runnable", JSON.stringify(said));
  });
}

test("Mode 1: an e2b sandbox is refused, as a sandbox there needs a bind mount of this machine's folder, which only Docker gives", async (t) => {
  // main's design (resolve-computer.ts): Mode 1 runs a sandbox only on Docker, whose bind mount reaches the run's folder on
  // this machine; a remote sandbox cannot, whatever keys it has.
  const api = await server(t, { archil: false });
  const saved = await api("PUT", "/computers/e2b/keys", { E2B_API_KEY: "fake-test-key" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const said = await saveAndStart(api, "remote-mode1", { computer: { kind: "sandbox", provider: "e2b" } });
  const words = /^Mode 1 runs a sandbox only on Docker: an E2B sandbox can't reach the run's folder on this machine\. Pick Docker for this agent's computer in Settings → Computers, or another kind of computer\.$/;
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
  assert.match(said.started[2], /^No model yet: start Ollama and pull a model with tools, or add a model key in Settings → Model keys[^.]*\.$/, JSON.stringify(said));
});

test("Mode 1: an agent saved with place {sandbox, docker} on a host where Docker does not answer is refused at its run's start (409), in the words Settings → Computers says, and its view says Docker is not ready", async (t) => {
  // The claim would only fail to launch it, later, as computer_unavailable. The start's check asks the server's daemon
  // check (docker-daemon.ts: `docker version`, here the fake that fails) and refuses it now, in the one wording.
  const api = await server(t, { archil: false, docker: false });
  const said = await saveAndStart(api, "docker-down", { place: { mode: "sandbox", box: "docker" } });
  const words = "No Docker on this server: Render and most hosted services run none. A vendor sandbox (Modal, E2B or Agent37) needs Archil turned on in Settings → Workspace.";
  assert.deepEqual(said.saved, [["definition.computer", "not_set_up_here", words]], JSON.stringify(said));
  assert.deepEqual(said.refused, [["definition.computer", "not_set_up_here", words]], JSON.stringify(said));
  assert.deepEqual(said.started.slice(0, 2), [409, "agent_not_runnable"], JSON.stringify(said));
  const view = await api("GET", "/computers");
  const docker = view.body.kinds.find((kind) => kind.kind === "sandbox").providers.find((one) => one.id === "docker");
  assert.deepEqual([docker.ready, docker.why], [false, words], JSON.stringify(docker));
});

test("Mode 1: where Docker answers, GET /v2/computers shows Docker ready for a sandbox and a desktop", async (t) => {
  const api = await server(t, { archil: false, docker: true });
  const view = await api("GET", "/computers");
  for (const kind of ["sandbox", "desktop"]) {
    const docker = view.body.kinds.find((one) => one.kind === kind).providers.find((one) => one.id === "docker");
    assert.deepEqual([docker.ready, docker.why], [true, undefined], `${kind}: ${JSON.stringify(docker)}`);
  }
});

test("Mode 1: a daemon that answers only after the server started is not taken: Docker stays not ready, in the start probe's words on a host, and as no daemon in a container with no socket", async (t) => {
  // The start made no Docker box, so its checks of Docker (a daemon elsewhere, this server's paths, host addresses, the
  // box network) never ran; a daemon that answers now can't stand in for them. The probe's facts are pinned, so the words
  // do not depend on where the suite runs (place-offers.ts containerReason). A container with no socket at the start had
  // no daemon there: this page words that as none (noDockerWords, which names the vendors that fit each kind), never the
  // start's words, which point at this very page.
  const HOST_WORDS = "Docker isn't running on this machine, or this user may not use it (docker version failed: exit 1): start Docker, or add this user to the docker group, then restart AgentRun";
  for (const probeContainer of [{ where: "host" }, { where: "image", exists: () => false }]) {
    const api = await server(t, { archil: false, docker: false, probeContainer });
    const bin = process.env.PATH.split(":")[0];
    await writeFile(join(bin, "docker"), "#!/bin/sh\nif [ \"$1\" = version ]; then echo 27.0.0-fake; exit 0; fi\nexit 0\n", { mode: 0o755 });
    const view = await api("GET", "/computers");
    const whys = {};
    for (const kind of ["sandbox", "desktop"]) {
      const docker = view.body.kinds.find((one) => one.kind === kind).providers.find((one) => one.id === "docker");
      assert.equal(docker.ready, false, `${kind}: ${JSON.stringify(docker)}`);
      whys[kind] = docker.why;
      if (probeContainer.where === "host") assert.equal(docker.why, HOST_WORDS, `${kind}, on a host: ${JSON.stringify(docker)}`);
      else {
        assert.ok(docker.why.startsWith(`${NO_DOCKER_HERE} `), `${kind}, in the image: ${docker.why}`);
        assert.ok(!docker.why.includes("Settings → Computers)"), `${kind}: never a pointer at this page: ${docker.why}`);
      }
    }
    if (probeContainer.where === "image") assert.notEqual(whys.sandbox, whys.desktop, "each kind its own words");
  }
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

test("under --faux, a run's start and its claim answer alike: the faux desktop and a Docker desktop the claim can make are not refused, and a provider it cannot make is refused at the start in the claim's words", async (t) => {
  // The claim's registry is the one the runner composes with under --faux (runner/main.ts runnerComputers, and this
  // suite's in-process runner: --faux's providers beside the computer package's). The start check reads the claim's, so
  // it never lets a run start that its claim would refuse, nor the reverse.
  const api = await server(t, { archil: false, docker: true, faux: true });
  const claimed = computerDepsFrom({ env: {}, store: {}, sealKey: randomBytes(32), faux: fauxComputers() }).computerDeps.kinds;
  const side = { keysOf: async () => ({}), answers: async () => false, launch: async () => { throw new Error("nothing is launched here"); } };
  for (const [id, computer, makes] of [["faux-desk", { kind: "desktop", provider: "faux-desktop" }, true], ["docker-desk", { kind: "desktop", provider: "docker" }, true], ["no-desk", { kind: "desktop", provider: "nowhere" }, false]]) {
    const claim = await resolveComputer(computer, 1, claimed, side);
    assert.equal(!("refused" in claim), makes, `the claim ${makes ? "makes" : "refuses"} ${computer.provider}'s desktop: ${JSON.stringify(claim)}`);
    const said = await saveAndStart(api, id, { computer });
    assert.deepEqual(said.refused.map((one) => one[2]), makes ? [] : [claim.refused], `the start answers as the claim does: ${JSON.stringify(said)}`);
  }
});

// Where a run on the runner has a shell (resolve-computer.ts runShellOf): in Mode 2 with no computer, bash runs on
// Archil's serverless exec (runner-cli-spec.test.mjs binds it there), so the save check lets an agent with no computer
// name bash, and its run's start is not refused for it; the background tools run in a box alone, so they stay refused.
// In Mode 1 with no computer there is no shell at all: bash is refused, 422, in the words it always had.
/** An agent with `setting` and `tools` saved: its answer, and its run's start refused for a tool, by field. */
async function saveWithTools(api, id, setting, tools) {
  const made = await api("POST", "/agents", { definition: { id, version: 1, name: id, instructions: "Answer.", skills: [], tools, ...setting } });
  if (made.status !== 201) return { made };
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Answer." } });
  const onTools = (one) => one.field.startsWith("definition.tools");
  return { made, warned: (made.body.warnings ?? []).filter(onTools), refused: (started.body?.error?.fields ?? []).filter(onTools), started };
}

// The browser tool of an agent whose computer is a browser opens its sessions on that computer (tools.ts
// browserComputer), so its keys are the computer's, saved in Settings → Computers (Local Chrome needs none): the save
// warns of nothing on the tool and the run starts, with no Tool keys entry and no browser key where the server starts.
// With the computer's key not saved, the refusal is the computer's, naming Settings → Computers, never Tool keys. The
// computer registry is the package's (no --faux), and the model key a fake one where the server starts.
for (const [provider, keys] of [["browserbase", { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" }], ["local-chrome", undefined]]) {
  test(`an agent whose computer is a ${provider} browser, with the browser tool and no Tool keys entry, is saved with no warning on the tool and its run starts`, async (t) => {
    withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key" }, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY"]);
    const api = await server(t, { owner: true });
    if (keys) {
      const saved = await api("PUT", `/computers/${provider}/keys`, keys);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
    }
    const said = await saveWithTools(api, `browser-on-${provider}`, { computer: { kind: "browser", provider } }, ["browser", "ask_person"]);
    assert.equal(said.made.status, 201, JSON.stringify(said.made.body));
    assert.deepEqual(said.made.body.warnings, [], JSON.stringify(said.made.body.warnings));
    assert.equal(said.started.status, 202, JSON.stringify(said.started.body));
    // The Screen tab reads the run's browser as that computer, not off for want of a Tool keys entry.
    const screen = await api("GET", `/runs/${said.started.body.run_id}/computer`);
    assert.equal(screen.status, 200, JSON.stringify(screen.body));
    assert.deepEqual([screen.body.state, screen.body.kind], ["none", "browser"], JSON.stringify(screen.body));
  });
}

test("an agent whose computer is a Browserbase browser with no key saved is refused for its computer, naming Settings → Computers, never Tool keys", async (t) => {
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key" }, ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY"]);
  const api = await server(t, {});
  const said = await saveWithTools(api, "browser-unkeyed", { computer: { kind: "browser", provider: "browserbase" } }, ["browser"]);
  assert.equal(said.made.status, 201, JSON.stringify(said.made.body));
  assert.equal(said.started.status, 409, JSON.stringify(said.started.body));
  const fields = said.started.body.error.fields;
  assert.deepEqual(fields.map((one) => one.field), ["definition.computer"], JSON.stringify(fields));
  assert.match(fields[0].message, /Settings → Computers/);
  assert.doesNotMatch(JSON.stringify(said.started.body), /Tool keys/);
});

for (const setting of [{ computer: { kind: "none" } }, { place: { mode: "runner" } }]) {
  test(`Mode 2: an agent with ${JSON.stringify(setting)} and bash is saved and its run is not refused for bash: it runs on Archil's serverless exec`, async (t) => {
    const api = await server(t, { archil: true });
    const said = await saveWithTools(api, `exec-${Object.keys(setting)[0]}`, setting, ["read", "bash"]);
    assert.equal(said.made.status, 201, JSON.stringify(said.made.body));
    assert.deepEqual(said.warned, [], JSON.stringify(said.made.body));
    assert.deepEqual(said.refused, [], JSON.stringify(said.started.body));
    // What is left is the model key this test saves none of.
    assert.deepEqual([said.started.status, said.started.body?.error?.code], [409, "agent_not_runnable"], JSON.stringify(said.started.body));
    assert.doesNotMatch(said.started.body.error.message, /bash/, JSON.stringify(said.started.body));
  });
}

test("Mode 2: a background tool on the runner is still refused, 422: Archil's serverless exec runs bash alone", async (t) => {
  const api = await server(t, { archil: true });
  const said = await saveWithTools(api, "exec-background", { computer: { kind: "none" } }, ["bash", "bash_background"]);
  assert.equal(said.made.status, 422, JSON.stringify(said.made.body));
  assert.deepEqual(said.made.body.error.fields.map((one) => [one.field, one.reason]), [["definition.tools[1]", "not_an_option"]]);
  assert.match(said.made.body.error.fields[0].message, /^bash_background runs only in a box, and this agent's place is the runner, whose shell here runs bash alone \(bash_background needs a sandbox computer\), /);
});

test("Mode 2 with no Docker is exempt from naming a box: a new agent with no place saves on the runner, whose exec is its shell, as before; default_place is the runner, with no default_reason", async (t) => {
  const api = await server(t, { archil: true });
  const { places } = (await api("GET", "/capabilities")).body;
  assert.deepEqual(places.default_place, { mode: "runner" });
  assert.equal("default_reason" in places, false);
  const made = async (id, tools) => api("POST", "/agents", { definition: { id, name: id, instructions: "Answer.", ...(tools ? { tools } : {}) } });
  const plain = await made("no-tools");
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal("place" in plain.body.definition, false);
  assert.deepEqual(plain.body.definition.tools, [], "no box, so not the box's shell tools");
  const shell = await made("exec-bash", ["read", "bash"]);
  assert.equal(shell.status, 201, JSON.stringify(shell.body));
  assert.equal("place" in shell.body.definition, false);
  // A shell tool the exec does not run is refused at the tool, as before, never at its place.
  const background = await made("exec-background", ["bash", "bash_background"]);
  assert.equal(background.status, 422, JSON.stringify(background.body));
  assert.deepEqual(background.body.error.fields.map((one) => [one.field, one.reason]), [["definition.tools[1]", "not_an_option"]]);
  assert.match(background.body.error.fields[0].message, /^bash_background runs only in a box, and this agent names no place, so it runs on the runner, whose shell here runs bash alone /);
  // Word for word as before this change: in Mode 2 new agents do run on the runner, so its words still say so.
  assert.match(background.body.error.fields[0].message, /\(bash_background needs a sandbox computer\), and new agents run on the runner, because the docker box is unavailable here: .+\. Do that, or keep this agent on the runner: name "place": \{"mode": "runner"\} and remove "bash_background" from definition\.tools\.$/);
});

test("Mode 1 with no Docker: an agent with no computer and bash is refused, 422, in the words it always had", async (t) => {
  const api = await server(t, { archil: false, docker: false });
  const said = await saveWithTools(api, "no-shell", { computer: { kind: "none" } }, ["read", "bash"]);
  assert.equal(said.made.status, 422, JSON.stringify(said.made.body));
  assert.deepEqual(said.made.body.error.fields.map((one) => [one.field, one.reason, one.fix]), [["definition.tools[1]", "not_an_option", "Remove \"bash\" from definition.tools."]]);
  assert.equal(said.made.body.error.fields[0].message, "bash runs only in a box, and this agent's place is the runner, which has no shell (a shell needs a sandbox computer), and the docker box is unavailable here: Docker isn't running on this machine, or this user may not use it (docker version failed: exit 1): start Docker, or add this user to the docker group, then restart AgentRun. Do that, or keep this agent on the runner: name \"place\": {\"mode\": \"runner\"} and remove \"bash\" from definition.tools.");
});

test("capabilities show bash available in Mode 2, where a run on the runner has it on Archil's serverless exec; the background tools still want a box, and in Mode 1 bash does too", async (t) => {
  const shellTools = (tools) => tools.filter((tool) => tool.sandbox_only).map((tool) => [tool.name, tool.available, tool.reason?.startsWith("no box is set up on this server") ?? false]);
  const background = ["bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"].map((name) => [name, false, true]);
  const mode1 = await server(t, { archil: false });
  assert.deepEqual(shellTools((await mode1("GET", "/capabilities")).body.tools), [["bash", false, true], ...background]);
  const mode2 = await server(t, { archil: true });
  assert.deepEqual(shellTools((await mode2("GET", "/capabilities")).body.tools), [["bash", true, false], ...background]);
});

test("a template that grants bash applies in Mode 2, its agent on the runner with bash on Archil's serverless exec; in Mode 1 with no Docker its apply is refused, 422", async (t) => {
  const templates = join(await scratch(t), "templates");
  await mkdir(join(templates, "shell-reader"), { recursive: true });
  await writeFile(join(templates, "shell-reader", "agent.md"), "---\nname: shell-reader\nversion: 1.0.0\ndescription: Reads its folder with a shell.\ntools: [read, bash]\n---\nRead.\n");
  const mode2 = await server(t, { archil: true, templates });
  const applied = await mode2("POST", "/templates/shell-reader/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const made = (await mode2("GET", `/agents/${applied.body.agent_id}`)).body.definition;
  // It names no place: it runs where a new agent does, the runner here (no Docker).
  assert.deepEqual([made.place, made.computer, made.tools], [undefined, undefined, ["read", "bash"]], JSON.stringify(made));
  const mode1 = await server(t, { archil: false, templates });
  const refused = await mode1("POST", "/templates/shell-reader/apply", {});
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /^name a box: this server has no Docker box for a new agent\. /);
});

// A template apply whose package names no tools and no computer list makes the agent POST /agents makes of a definition
// that names no tools: where Docker's box is here, the box and its shell tools (beside the MCP tools the apply ticks);
// where it is not and the runner has no shell (Mode 1), the same refusal, 422 at definition.place, never an agent saved
// on the runner; in Mode 2, the runner, as before. A package that names its tools ([] included) or its computer list
// applies as before. An apply's grants are the package's MCP tools alone (templates.ts applyBodyOf), so none brings a
// shell tool in. `agentrun deploy` applies the same way (packages/agentrun deploy.test).
const PLAIN = "---\nname: plain-reader\nversion: 1.0.0\ndescription: Answers.\n---\nAnswer.\n";
/** A templates folder holding `packages`, each name's agent.md. */
async function templatesOf(t, packages) {
  const templates = join(await scratch(t), "templates");
  for (const [name, manifest] of Object.entries(packages)) {
    await mkdir(join(templates, name), { recursive: true });
    await writeFile(join(templates, name, "agent.md"), manifest);
  }
  return templates;
}
/** The fake MCP server saved on `api` as `fake`, the server two-tool-template.mjs's package uses. */
async function fakeSaved(t, api) {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, toolkit: "fake" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}
/** The applied agent's place, computer and tools. */
const madeOf = async (api, applied) => {
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const made = (await api("GET", `/agents/${applied.body.agent_id}`)).body.definition;
  return [made.place, made.computer, made.tools];
};
/** A 422 at definition.place (missing), in the name-a-box words, with no agent made. */
async function refusedForPlace(api, said) {
  assert.equal(said.status, 422, JSON.stringify(said.body));
  assert.deepEqual(said.body.error.fields.map((one) => [one.field, one.reason]), [["definition.place", "missing"]]);
  assert.match(said.body.error.message, /^name a box: this server has no Docker box for a new agent\. Set place to /);
  assert.deepEqual((await api("GET", "/agents")).body.agents, [], "nothing made");
}

test("Mode 1 with no Docker: a template apply of a package that names no tools and no computer is refused as POST /agents refuses that create, 422 at definition.place, nothing made; a grant of bash is still refused at the grant", async (t) => {
  const templates = await templatesOf(t, { "plain-reader": PLAIN });
  const mode1 = await server(t, { archil: false, templates });
  await refusedForPlace(mode1, await mode1("POST", "/templates/plain-reader/apply", {}));
  const granted = await mode1("POST", "/templates/plain-reader/apply", { grants: ["bash"] });
  assert.equal(granted.status, 422, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.error.fields.map((one) => [one.field, one.reason]), [["grants.0", "not_allowed"]]);
});

test("Mode 1 with no Docker: the same apply that ticks the package's MCP tools is refused alike: its grants are no tools it named", async (t) => {
  const templates = join(await scratch(t), "templates");
  twoToolPackage(templates, "two-tools", undefined, undefined, { bare: true });
  const mode1 = await server(t, { archil: false, templates });
  await fakeSaved(t, mode1);
  await refusedForPlace(mode1, await mode1("POST", "/templates/two-tools/apply", { grants: ["mcp:fake/add"] }));
});

test("with Docker answering, the same applies get Docker's box and its shell tools, the ticked MCP tool beside them, as before", async (t) => {
  const templates = await templatesOf(t, { "plain-reader": PLAIN });
  twoToolPackage(templates, "two-tools", undefined, undefined, { bare: true });
  const docker = await server(t, { archil: false, docker: true, templates });
  await fakeSaved(t, docker);
  const BOX = { mode: "sandbox", box: "docker" };
  const [place, , tools] = await madeOf(docker, await docker("POST", "/templates/plain-reader/apply", {}));
  assert.deepEqual([place, tools.includes("bash")], [BOX, true], JSON.stringify(tools));
  const [ticked, , mcp] = await madeOf(docker, await docker("POST", "/templates/two-tools/apply", { grants: ["mcp:fake/add"] }));
  assert.deepEqual([ticked, mcp.includes("bash"), mcp.includes("mcp:fake/add")], [BOX, true, true], JSON.stringify(mcp));
});

test("Mode 2: the same applies keep the runner, as before: no place, no tools, or the ticked MCP tool alone", async (t) => {
  const templates = await templatesOf(t, { "plain-reader": PLAIN });
  twoToolPackage(templates, "two-tools", undefined, undefined, { bare: true });
  const mode2 = await server(t, { archil: true, templates });
  await fakeSaved(t, mode2);
  assert.deepEqual(await madeOf(mode2, await mode2("POST", "/templates/plain-reader/apply", {})), [undefined, undefined, []]);
  assert.deepEqual(await madeOf(mode2, await mode2("POST", "/templates/two-tools/apply", { grants: ["mcp:fake/add"] })), [undefined, undefined, ["mcp:fake/add"]]);
});

test("Mode 1 with no Docker: a package that names its tools ([] included) or its computer list applies as before, on the runner", async (t) => {
  const templates = await templatesOf(t, {
    "no-tools": PLAIN.replace("name: plain-reader", "name: no-tools").replace("---\nAnswer", "tools: []\n---\nAnswer"),
    "file-tools": PLAIN.replace("name: plain-reader", "name: file-tools").replace("---\nAnswer", "tools: [read, write]\n---\nAnswer"),
    "shell-or-none": PLAIN.replace("name: plain-reader", "name: shell-or-none").replace("---\nAnswer", "computer: [shell, none]\n---\nAnswer"),
  });
  const mode1 = await server(t, { archil: false, templates });
  assert.deepEqual(await madeOf(mode1, await mode1("POST", "/templates/no-tools/apply", {})), [undefined, undefined, []]);
  assert.deepEqual(await madeOf(mode1, await mode1("POST", "/templates/file-tools/apply", {})), [undefined, undefined, ["read", "write"]]);
  const fallback = await mode1("POST", "/templates/shell-or-none/apply", {});
  const [place, computer] = await madeOf(mode1, fallback);
  assert.deepEqual([place, computer], [{ mode: "runner" }, { kind: "none" }], JSON.stringify(fallback.body));
  assert.deepEqual(fallback.body.warnings.filter((one) => one.field === "computer").map((one) => one.reason), ["not_set_up_here"], "its list's fallback is said, as before");
});
