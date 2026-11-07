// Daytona boxes for sandbox runs, on a fake Daytona on loopback (fixtures/fake-daytona.mjs) and a fake Archil disk
// (fixtures/fake-archil.mjs): no provider call and no Archil call runs. The server makes a run's box with its key, gives
// it its host list (or no network), and the box mounts the run's work/ from the disk through its root helper; nothing is
// copied in or out. At the run's end the box syncs and checks the folder in, and is destroyed. The run's process holds no
// key: its Daytona calls go through the server's box relay, which sends on only the calls a run's tools make of that
// run's own box.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BOX_RELAY_FILE, relayFetch, startBoxRelay } from "../dist/box-relay.js";
import { BOX_ENV, runBox } from "../dist/run-box.js";
import { BOX_WORK } from "../dist/place.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { fakeArchil } from "./fixtures/fake-archil.mjs";
import { daytonaSandboxes } from "./fixtures/fake-daytona.mjs";
import { startServe } from "../dist/index.js";
import { client, follow, runDir, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const DAYTONA = { mode: "sandbox", box: "daytona" };
const planted = (name) => `planted-${name}-sentinel`;
const KEY = planted("daytona-key");
const ENV_PROBE = "env; cat /proc/self/environ 2>/dev/null | tr '\\0' '\\n'";

/** Each tool call of run `runId` and its answer, in order, from its released store. */
function answers(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    db.close();
  }
}

const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const ARCHIL_NAMES = ["AGENTRUN_ARCHIL_DISK", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_TOKEN", "AGENTRUN_ARCHIL_GID"];

/** A fake Daytona whose boxes ship the Archil helper, over a fake disk at a new data directory's disk/ (`fake.data`). */
async function archilDaytona(t, options) {
  const data = join(await scratch(t), "agents");
  const disk = await fakeArchil(t, { data });
  const fake = await daytonaSandboxes(t, { ...options, archil: disk });
  return Object.assign(fake, { data, disk });
}

/** The settings of `fake`'s Daytona and disk, and the start options that read its mount table. */
const daytonaEnv = (fake) => ({ AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url, ...fake.disk.env });

/** A server on `fake`'s data directory, Daytona and disk, its key planted, with the probe model (fixtures/faux-probe.mjs). */
async function onDaytona(t, fake, extra = {}) {
  withEnv(t, { ...daytonaEnv(fake), OPENAI_API_KEY: planted("model") }, ARCHIL_NAMES);
  return serve(t, { faux: PROBE, data: fake.data, archilMounts: fake.disk.serverMounts, ...extra });
}

async function probe(api, agent, plan) {
  const run = await api("POST", `/agents/${agent}/runs`, { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body;
}

/** A file reserved and sent with the server's token: its ready File. */
async function upload(server, path, text) {
  const bytes = Buffer.from(text);
  const made = await server.api("POST", "/files", { path, size_bytes: bytes.length });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // upload.url starts at the server's root (or is whole): resolved against the server's address, never the /v2 base.
  const sent = await fetch(new URL(made.body.upload.url, server.url), { method: "PUT", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/octet-stream" }, body: bytes });
  const answer = await sent.text();
  assert.equal(sent.status, 200, answer);
  return JSON.parse(answer).file_id ?? made.body.file_id;
}

/** A relay over `fake` in a scratch data root for the runs `ids`; `as(id)` is the fetch that run's process makes with the
 *  token it was handed, and `make(id)` a sandbox with that run's label, made as the server makes them. */
async function relayFor(t, fake, ids, ensure = async () => ({ id: "", made: true })) {
  const root = await scratch(t);
  const dirOf = (id) => join(root, "runs", id);
  // Each run's own door token, in its directory, as a run's launch makes it.
  const tokens = Object.fromEntries(ids.map((id) => [id, `door-token-of-${id}`]));
  for (const id of ids) {
    mkdirSync(dirOf(id), { recursive: true });
    await writeFile(join(dirOf(id), "door-token"), `${tokens[id]}\n`);
  }
  const relay = await startBoxRelay({ root, tokenOf: (id) => tokens[id], apiUrl: fake.url, apiKey: KEY, serves: (id) => ids.includes(id), ensure: (id) => ensure(id) });
  t.after(() => relay.close());
  const make = async (run) => (await (await fetch(`${fake.url}/sandbox`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ labels: { "agentrun.run": run, "agentrun.box": "run", "pi-transport": "1", "pi-transport.workspace": "/workspace" } }) })).json()).id;
  return { root, relay, make, tokens, as: (id) => relayFetch(root, dirOf(id), id), dirOf };
}

const fileList = async (api, runId) => (await api("GET", `/runs/${runId}/files`)).body.files.map((file) => file.path).sort();

// The fake runs each box command in a real shell of this machine: a sudo one asks for must meet the fixtures' stand-in
// (sudo-stand-in.mjs), first on its PATH, never this machine's sudo. Every other test here fails if one was asked for.
test("a box command's sudo meets the stand-in, never this machine's: a workspace its user may not make is refused, and the sudo it asked for is noted, not run", { skip: process.getuid?.() === 0 && "root makes any directory with no sudo" }, async (t) => {
  const fake = await archilDaytona(t, { key: KEY, sudoProbe: true });
  const parent = join(fake.root, "read-only");
  mkdirSync(parent);
  chmodSync(parent, 0o555);
  t.after(() => existsSync(parent) && chmodSync(parent, 0o755));
  const { daytonaBoxes } = await import("@parcha/pi-transport/box/daytona");
  const workspace = join(parent, "work");
  const made = await daytonaBoxes({ apiKey: KEY, apiUrl: fake.url }).create({ maxLifetimeMs: 60_000, workspace }, BACKGROUND_CONTEXT);
  assert.equal(made.ok, false, "a workspace that cannot be made fails the create");
  assert.deepEqual(fake.sudoCalls(), [`-n mkdir -p -- ${workspace}`], "the sudo it asked for went to the stand-in");
  assert.ok(!existsSync(workspace), "and nothing made it");
});

test("a box command that names a sudo by its absolute path, quoted or not, is refused whole, never run, and fails the test that sent it (a sudo that does not exist, so nothing real could run)", async (t) => {
  const fake = await archilDaytona(t, { key: KEY, sudoProbe: true });
  const made = await (await fetch(`${fake.url}/sandbox`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ labels: { "pi-transport": "1" } }) })).json();
  const ran = await fetch(`${fake.toolboxUrl}/${made.id}/process/execute`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ command: 'touch ran.txt; "/nonexistent/bin/sudo" -n true', timeout: 10 }) });
  assert.deepEqual(await ran.json(), { exitCode: 97, result: "the fake refuses a command that names an absolute sudo" });
  assert.ok(!existsSync(join(fake.root, made.id, "ran.txt")), "no part of it ran");
  assert.deepEqual(fake.sudoCalls(), ['refused, by its absolute path: touch ran.txt; "/nonexistent/bin/sudo" -n true']);
});

test("the absolute-sudo guard reads a command as a shell would: a quoted, chained or bare absolute sudo is refused; the stand-in's own files and a word that merely contains sudo are not", async (t) => {
  const { sudoStandIn } = await import("./fixtures/sudo-stand-in.mjs");
  const { refuses } = sudoStandIn(await scratch(t));
  for (const command of ['"/usr/bin/sudo" -n true', "'/usr/bin/sudo' -n true", "true;/usr/bin/sudo -n true", "x && /usr/bin/sudo", "/usr/bin/sudo", "env /usr/local/bin/sudo -n id", "(/usr/bin/sudo -n id)"]) assert.equal(refuses(command), true, command);
  for (const command of ["sudo -n mkdir -p -- /x", "command -v sudo", "cat /tmp/a/sudo.calls", "ls /tmp/a/sudo-bin", "/opt/pseudo/bin/x", "printf %s /tmp/sudoers.d"]) assert.equal(refuses(command), false, command);
});

test("a run whose Daytona box the server replaces (one made when boxes had work/ at /run/agentrun/run/work) is told once that its box was replaced, on its next box tool's answer", { timeout: 120_000 }, async (t) => {
  const fake = await archilDaytona(t, { key: KEY });
  const server = await onDaytona(t, fake);
  const { api, data } = server;
  assert.equal((await api("POST", "/agents", { definition: { id: "remote", name: "remote", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const go = join(await scratch(t), "go");
  const started = await api("POST", "/agents/remote/runs", { input: { content: JSON.stringify({ probe: [{ wait: go }, { tool: "bash", args: { command: "printf one > one.txt" } }, { tool: "bash", args: { command: "printf two > two.txt" } }] }) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // The run's box as an older server made it: no network, its work/ at the old place.
  const old = await (await fetch(`${fake.url}/sandbox`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ labels: { "agentrun.run": runId, "agentrun.box": "run", "pi-transport": "1", "pi-transport.workspace": "/run/agentrun/run/work" }, networkBlockAll: true }) })).json();
  mkdirSync(fake.pathOf(old.id, "run/agentrun/run/work"), { recursive: true });
  await writeFile(go, "");
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  const said = answers(data, runId);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), [["bash", false], ["bash", false]], JSON.stringify(said));
  assert.ok(said[0].text.startsWith("this run's box was replaced after a restart: /workspace is kept; packages installed outside it and /tmp are gone; reinstall what you need"), said[0].text);
  assert.ok(!said[1].text.includes("box was replaced"), "told once");
  assert.ok(!fake.sandboxes.has(old.id) || fake.sandboxes.get(old.id).state !== "started", "the old box is gone");
});

test("demo: a Daytona place runs read, write, edit and bash in the run's box: work/ mounted from the disk, bash's out.txt in the run's files, its network the package registries' domain list, no key in the box, the box destroyed at the end", { timeout: 180_000 }, async (t) => {
  const fake = await archilDaytona(t, { key: KEY });
  withEnv(t, { MONID_API_KEY: MONID_KEY });
  const server = await onDaytona(t, fake, { fauxMonid: FAUX_MONID });
  const { api, data } = server;
  const places = (await api("GET", "/capabilities")).body.places;
  assert.deepEqual(places.boxes.find((b) => b.id === "daytona"), { id: "daytona", available: true, state: "ready", network: "none", network_reason: "remote boxes on an Archil disk: tools have no network yet; enforced by an in-box firewall" });
  assert.deepEqual(places.allow, ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "registry.yarnpkg.com", "github.com", "codeload.github.com"]);
  const made = await api("POST", "/agents", { definition: { id: "remote", name: "remote", instructions: "Probe.", place: DAYTONA, tools: ["read", "write", "edit", "bash", "monid.discover"], tool_settings: { "monid.discover": { permission: "allow" } } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  const input = await upload(server, "brief.txt", "in the run's work/ on the disk\n");
  const plan = [
    { tool: "bash", args: { command: "cat inputs/brief.txt; pwd" } },
    { tool: "bash", args: { command: "printf 'hello from the box\\n' > out.txt" } },
    { tool: "write", args: { path: "note.txt", content: "written in the box" } },
    { tool: "edit", args: { path: "note.txt", edits: [{ oldText: "written", newText: "edited" }] } },
    { tool: "read", args: { path: "note.txt" } },
    { tool: "bash", args: { command: ENV_PROBE } },
    // A host tool files its whole answer in work/ (monid's, over its cut): the box gets the file too, to read.
    { tool: "monid_discover", args: { query: "everything at once" } },
    { tool: "bash", args: { command: "ls evidence/monid | wc -l" } },
    { tool: "bash", args: { command: "rm inputs/brief.txt" } },
  ];
  const started = await api("POST", "/agents/remote/runs", { input: { content: JSON.stringify({ probe: plan }) }, file_ids: [input] });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = started.body;
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const said = answers(data, run.run_id);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  const [mounted, cwd] = said[0].text.trim().split("\n");
  assert.equal(mounted, "in the run's work/ on the disk", "the box mounted the run's work/");
  assert.match(cwd, /\/workspace$/, "bash starts in the box's work/");
  assert.equal(said[4].text, "edited in the box");
  assert.equal(said[7].text.trim(), "1", "the file monid's answer was filed in is in the box");
  // The box's environment: the fixed one, and no key, token or door token.
  const door = (await readFile(join(data, ".door-token"), "utf8")).trim();
  const runDoor = (await readFile(join(runDir(data, run.run_id), "door-token"), "utf8")).trim();
  for (const [name, value] of Object.entries({ KEY, model: planted("model"), token: server.token, door, runDoor, monid: MONID_KEY })) assert.ok(!said[5].text.includes(value), `${name} reached the box`);
  // The run's files: what the box wrote; what it removed, removed. The box worked in the folder itself.
  assert.deepEqual((await fileList(api, run.run_id)).filter((path) => !path.startsWith("evidence/")), ["note.txt", "out.txt"]);
  assert.equal((await api("GET", `/runs/${run.run_id}/files/out.txt`)).body, "hello from the box\n");
  // The box Daytona was asked for: the default hosts as its domain list, the fixed environment, the run's labels;
  // destroyed at the end.
  const created = fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").map((r) => JSON.parse(r.body));
  assert.equal(created.length, 1);
  // Its provider network open, which the box's own firewall closes to its tools (the helper's netlock).
  assert.equal(created[0].domainAllowList, undefined);
  assert.equal(created[0].networkBlockAll, undefined);
  assert.deepEqual(created[0].env, BOX_ENV);
  // From the snapshot the setting names, which ships the archil client, the helper and the tool user.
  assert.equal(created[0].snapshot, "agentrun-archil-box");
  // What the host tools filed (monid's answer) went in as the tool user, by a program of its own, never an upload as
  // the box's own user; and the run's end ended its background processes as the tool user too.
  const executed = fake.requests.filter((r) => r.path.endsWith("/process/execute")).map((r) => JSON.parse(r.body).command);
  assert.deepEqual(fake.requests.filter((r) => r.path.endsWith("/files/upload-v2") && r.query.includes("evidence")).map((r) => r.query), []);
  assert.ok(executed.some((c) => c.includes("agentrun-tool") && c.includes("evidence/monid")), "the answer written as the tool user");
  assert.ok(executed.some((c) => c.includes("agentrun-tool") && c.includes("agentrun-background")), "background ended as the tool user");
  assert.equal(created[0].labels["agentrun.run"], run.run_id);
  assert.equal(fake.sandboxes.size, 0, "the box is destroyed");
  // Every provider call that reached Daytona came with the server's key: the run's process, which has none, reached it
  // only through the relay.
  const provider = fake.requests.filter((r) => r.source === "pi-transport");
  assert.ok(provider.length > 0);
  assert.deepEqual(provider.filter((r) => r.authorization !== `Bearer ${KEY}`).map((r) => `${r.method} ${r.path}`), []);
  assert.ok(fake.requests.some((r) => r.path.endsWith("/process/execute")));
  const log = readFileSync(join(runDir(data, run.run_id), "process.log"), "utf8");
  assert.ok(!log.includes(KEY), "the key is in no line of the run's process");
  // Nothing copied: the box mounted the run's folder, and synced and checked it in at the end.
  assert.deepEqual(fake.disk.calls().map((c) => c.verb).filter((verb) => verb !== "sync"), ["mount", "checkin"]);
});

test("demo (claude-agent, codex): the faux harness's bash, write and read run in the run's Daytona box; an absolute path under its cwd is the box's same file; out.txt comes back", { timeout: 240_000 }, async (t) => {
  const fake = await archilDaytona(t, { key: KEY });
  const { api, data } = await onDaytona(t, fake, { fauxHarness: FAUX_HARNESS });
  withEnv(t, { AGENTRUN_TEST_DATA: realpathSync(data) });
  for (const harness of ["claude-agent", "codex"]) {
    const calls = [
      { call: "bash", args: { command: "printf hi > out.txt" } },
      { call: "write", args: { path: "{work}/abs.txt", content: "absolute" } },
      { call: "read", args: { path: "abs.txt" } },
      { call: "read", args: { path: "{work}/../serve.json" } },
    ];
    const id = `remote-${harness}`;
    assert.equal((await api("POST", "/agents", { definition: { id, name: id, harness, instructions: `Box calls: ${JSON.stringify(calls)}`, place: DAYTONA, tools: ["read", "write", "bash"] } })).status, 201);
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: "go" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
    const said = answers(data, run.body.run_id);
    assert.deepEqual(said.map((a) => [a.tool, a.error]), [["bash", false], ["write", false], ["read", false], ["read", true]], `${harness}: ${JSON.stringify(said)}`);
    assert.equal(said[2].text, "absolute");
    assert.match(said[3].text, /outside the workspace/);
    assert.deepEqual(await fileList(api, run.body.run_id), ["abs.txt", "out.txt"], harness);
    assert.equal((await api("GET", `/runs/${run.body.run_id}/files/out.txt`)).body, "hi");
  }
  assert.equal(fake.sandboxes.size, 0, "each run's box is destroyed at its end");
});

test("a run's box that Daytona paused while the run waited is started again, never replaced: the next turn runs in the same box", { timeout: 180_000 }, async (t) => {
  const fake = await archilDaytona(t, { key: KEY });
  const data = fake.data;
  withEnv(t, { ...daytonaEnv(fake) });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s", archilMounts: fake.disk.serverMounts });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "sleeper", name: "sleeper", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(firstApi, "sleeper", [{ tool: "bash", args: { command: "printf one > turn1.txt; printf only-in-the-box > box-only.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }, { tool: "bash", args: { command: "cat box-only.txt > turn2.txt" } }]);
  await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  await fileList(firstApi, run.run_id);
  await first.close();
  const [box] = fake.sandboxes.values();
  // An hour on, Daytona paused it (a class that pauses when idle); what only the box holds is still there.
  await writeFile(fake.pathOf(box.id, "workspace/box-only.txt"), "written after the last turn");
  fake.pause(box.id);
  const second = await serve(t, { data, faux: PROBE, archilMounts: fake.disk.serverMounts });
  assert.equal((await second.api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
  await follow(second.api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const created = fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox");
  assert.equal(created.length, 1, "no second box was made");
  assert.equal((await second.api("GET", `/runs/${run.run_id}/files/turn2.txt`)).body, "written after the last turn", "the next turn ran in the same box");
});

test("a run's box caught pausing is waited for and started again, never replaced", { timeout: 180_000 }, async (t) => {
  const fake = await archilDaytona(t, { key: KEY });
  const data = fake.data;
  withEnv(t, { ...daytonaEnv(fake) });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s", archilMounts: fake.disk.serverMounts });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "midway", name: "midway", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(firstApi, "midway", [{ tool: "bash", args: { command: "printf one > turn1.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }, { tool: "bash", args: { command: "cat box-only.txt > turn2.txt" } }]);
  await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  await fileList(firstApi, run.run_id);
  await first.close();
  const [box] = fake.sandboxes.values();
  await writeFile(fake.pathOf(box.id, "workspace/box-only.txt"), "written after the last turn");
  // Caught mid-pause: it settles a few reads on.
  fake.pause(box.id, 3);
  const second = await serve(t, { data, faux: PROBE, archilMounts: fake.disk.serverMounts });
  assert.equal((await second.api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
  await follow(second.api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.equal(fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").length, 1, "no second box was made");
  assert.equal((await second.api("GET", `/runs/${run.run_id}/files/turn2.txt`)).body, "written after the last turn", "the next turn ran in the same box");
});

test("a run's box that Daytona archived (or is archiving) while the run waited is restored, never replaced", { timeout: 240_000 }, async (t) => {
  for (const reads of [0, 3]) {
    const fake = await archilDaytona(t, { key: KEY });
    const data = fake.data;
    withEnv(t, { ...daytonaEnv(fake) });
    const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s", archilMounts: fake.disk.serverMounts });
    const firstApi = client(first.baseUrl, first.token);
    assert.equal((await firstApi("POST", "/agents", { definition: { id: "archived", name: "archived", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
    const run = await probe(firstApi, "archived", [{ tool: "bash", args: { command: "printf one > turn1.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }, { tool: "bash", args: { command: "cat box-only.txt > turn2.txt" } }]);
    await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
    await fileList(firstApi, run.run_id);
    await first.close();
    const [box] = fake.sandboxes.values();
    await writeFile(fake.pathOf(box.id, "workspace/box-only.txt"), "written after the last turn");
    fake.archive(box.id, reads);
    const second = await serve(t, { data, faux: PROBE, archilMounts: fake.disk.serverMounts });
    assert.equal((await second.api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
    await follow(second.api, run.run_id, ["completed"], { deadlineMs: 120_000 });
    assert.equal(fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").length, 1, `${reads}: no second box was made`);
    assert.equal((await second.api("GET", `/runs/${run.run_id}/files/turn2.txt`)).body, "written after the last turn", `${reads}: the next turn ran in the same box`);
    await second.close();
  }
});

test("a start has the box of a run that ended while its box was left (its delete failed) let go of the run's folder, then destroys it", { timeout: 180_000 }, async (t) => {
  const fake = await archilDaytona(t, { key: KEY, failDeletes: 1_000 });
  const data = fake.data;
  withEnv(t, { ...daytonaEnv(fake) });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s", archilMounts: fake.disk.serverMounts });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "left", name: "left", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(firstApi, "left", [{ tool: "bash", args: { command: "printf kept > out.txt" } }]);
  await follow(firstApi, run.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.equal(fake.sandboxes.size, 1, "its delete failed, so its box is left");
  await first.close();
  const [left] = fake.sandboxes.keys();
  // Written in the box after the run's end: it is on the disk, in the run's folder.
  await writeFile(fake.pathOf(left, "workspace/late.txt"), "late");
  fake.state.failDeletes = 0;
  const before = fake.disk.calls().length;
  const second = await serve(t, { data, faux: PROBE, archilMounts: fake.disk.serverMounts });
  await until(() => fake.sandboxes.size === 0, "the start's sweep");
  assert.deepEqual(fake.disk.calls().slice(before).map((c) => [c.verb, c.box]), [["sync", left], ["checkin", left]], "the sweep let the folder go before the box went");
  assert.equal(readFileSync(join(runDir(data, run.run_id), "work", "late.txt"), "utf8"), "late");
  assert.deepEqual(await fileList(second.api, run.run_id), ["late.txt", "out.txt"]);
});

test("a toolbox answer that redirects is refused and never followed with the key: a box holding its toolbox's port cannot send the relay to another run's sandbox", async (t) => {
  const fake = await archilDaytona(t, { key: KEY });
  const relay = await relayFor(t, fake, ["run-mine", "run-other"]);
  const mine = await relay.make("run-mine");
  const other = await relay.make("run-other");
  mkdirSync(fake.pathOf(other, "workspace"), { recursive: true });
  await writeFile(fake.pathOf(other, "workspace/secret.txt"), "the other run's secret");
  for (const status of [302, 303]) {
    fake.state.redirect = { from: `/toolbox/${mine}/files/download`, status, location: `/toolbox/${other}/files/download?path=/workspace/secret.txt` };
    const before = fake.requests.length;
    const sent = await relay.as("run-mine")(`${fake.toolboxUrl}/${mine}/files/download?path=/workspace/out.txt`, { headers: { authorization: "Bearer relayed-by-the-server" } });
    const text = await sent.text();
    assert.notEqual(sent.status, 200, `${status}: ${text}`);
    assert.ok(!text.includes("the other run's secret"), `${status}: the other run's file came back`);
    assert.match(text, /redirect/, `${status}: the refusal says why`);
    assert.deepEqual(fake.requests.slice(before).filter((r) => r.path.includes(other)).map((r) => `${r.method} ${r.path}`), [], `${status}: the other run's sandbox was never asked`);
  }
});

test("a run's relay call takes only that run's own token: run A's process, with the token it was handed, cannot reach run B's box", { timeout: 180_000 }, async (t) => {
  const fake = await archilDaytona(t, { key: KEY });
  const { api, data } = await onDaytona(t, fake);
  assert.equal((await api("POST", "/agents", { definition: { id: "pair", name: "pair", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const plan = [{ tool: "bash", args: { command: "printf x > out.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }];
  const a = await probe(api, "pair", plan);
  const b = await probe(api, "pair", plan);
  await follow(api, a.run_id, ["input_required"], { deadlineMs: 120_000 });
  await follow(api, b.run_id, ["input_required"], { deadlineMs: 120_000 });
  const boxOf = (id) => [...fake.sandboxes.values()].find((s) => s.labels["agentrun.run"] === id).id;
  const [boxA, boxB] = [boxOf(a.run_id), boxOf(b.run_id)];
  // The token each run's process was handed: its own file when it has one, else the server-wide one.
  const tokenOf = (id) => {
    const own = join(runDir(data, id), "door-token");
    return readFileSync(existsSync(own) ? own : join(data, ".door-token"), "utf8").trim();
  };
  const [tokenA, tokenB] = [tokenOf(a.run_id), tokenOf(b.run_id)];
  const relayUrl = JSON.parse(readFileSync(join(data, BOX_RELAY_FILE), "utf8")).url;
  const relayed = (token, run, target) => fetch(`${relayUrl}/runs/${run}/daytona`, { headers: { authorization: `Bearer ${token}`, "x-agentrun-target": target } });
  // A read of a sandbox, and a toolbox read of a file only run A's calls name: what reaches Daytona from run A carries
  // that name, and no call of run B's does.
  // In the box's work/ (BOX_WORK), a path the fake maps into each sandbox's own directory, never one of this machine's.
  const mark = `${BOX_WORK}/run-a-only-${randomUUID()}.txt`;
  const read = (box) => `${fake.url}/sandbox/${box}`;
  const marked = (box) => `${fake.toolboxUrl}/${box}/files/download?path=${encodeURIComponent(mark)}`;
  const carriesMark = (box) => (r) => r.path.includes(box) && new URLSearchParams(r.query).get("path") === mark;
  // The file is in both boxes, so a call that reached either would be answered.
  for (const box of [boxA, boxB]) {
    mkdirSync(dirname(fake.pathOf(box, mark.slice(1))), { recursive: true });
    await writeFile(fake.pathOf(box, mark.slice(1)), "only run A names this file");
  }
  await fileList(api, a.run_id);
  await fileList(api, b.run_id);
  const before = fake.requests.length;
  // Run B goes on using its own box meanwhile, as a late call of its own at its turn's end does.
  const bItself = relayed(tokenB, b.run_id, read(boxB));
  // Run A, with its token: on run B's relay path, and on its own path naming run B's box.
  for (const [run, target] of [[b.run_id, read(boxB)], [b.run_id, marked(boxB)], [a.run_id, read(boxB)], [a.run_id, marked(boxB)]]) {
    const theirs = await relayed(tokenA, run, target);
    // A read that reached run B's box would answer 200: the box is there.
    assert.ok([401, 403, 404].includes(theirs.status), `run A reached run B's box (${run === a.run_id ? "its own path" : "run B's path"}, ${target}): ${theirs.status}`);
  }
  assert.equal((await bItself).status, 200, "run B's own call reaches its own box");
  assert.deepEqual(fake.requests.slice(before).filter(carriesMark(boxB)).map((r) => `${r.method} ${r.path}${r.query}`), [], "run B's box was never asked by run A");
  // The name is seen when a call is sent on: run A's own box, asked the same way, gets it.
  assert.equal((await relayed(tokenA, a.run_id, read(boxA))).status, 200, "run A's own box answers its own token");
  await relayed(tokenA, a.run_id, marked(boxA));
  assert.equal(fake.requests.slice(before).filter(carriesMark(boxA)).length, 1, "run A's marked call reaches its own box");
});

test("the relay: the door token only; a run it holds only; only that run's own sandbox, for a read and its toolbox's programs and files; the key goes nowhere else", async (t) => {
  const fake = await archilDaytona(t, { key: KEY });
  const mine = { id: "", run: "run-mine" };
  const held = await relayFor(t, fake, ["run-mine", "run-other"], async () => ({ id: mine.id, made: true }));
  const { root, relay } = held;
  assert.deepEqual(JSON.parse(readFileSync(join(root, BOX_RELAY_FILE), "utf8")), { url: relay.url });
  // Two sandboxes, one per run, made with the key as the server makes them.
  const make = async (run) => (await (await fetch(`${fake.url}/sandbox`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ labels: { "agentrun.run": run, "pi-transport": "1" } }) })).json()).id;
  mine.id = await make("run-mine");
  const other = await make("run-other");
  // Another host on loopback, which a call may name: the key must never reach it.
  const elsewhere = [];
  const decoy = createServer((req, res) => (elsewhere.push(req.headers.authorization), res.end("{}")));
  await new Promise((resolve) => decoy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => decoy.close(resolve)));
  const decoyUrl = `http://127.0.0.1:${decoy.address().port}`;

  const relayed = held.as("run-mine");
  const call = async (method, target, body) => {
    const sent = await relayed(target, { method, headers: { authorization: "Bearer relayed-by-the-server", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: sent.status, body: await sent.json().catch(() => null) };
  };
  const before = fake.requests.length;
  assert.equal((await call("GET", `${fake.url}/sandbox/${mine.id}`)).status, 200);
  assert.equal((await call("GET", `${fake.url}/sandbox/${mine.id}/toolbox-proxy-url`)).status, 200);
  const ran = await call("POST", `${fake.toolboxUrl}/${mine.id}/process/execute`, { command: "printf ok", timeout: 5 });
  assert.deepEqual([ran.status, ran.body.result], [200, "ok"]);
  // Refused: whatever is not a run's tool calls on its own box.
  const refusals = [
    ["POST", `${fake.url}/sandbox`, { labels: { "agentrun.run": "run-mine" } }],
    ["GET", `${fake.url}/sandbox?labels=%7B%7D`],
    ["DELETE", `${fake.url}/sandbox/${mine.id}`],
    ["POST", `${fake.url}/sandbox/${mine.id}/stop`],
    ["GET", `${fake.url}/sandbox/${mine.id}/../../organizations`],
    ["POST", `${decoyUrl}/toolbox/${mine.id}/process/execute`, { command: "true", timeout: 5 }],
    ["GET", `${decoyUrl}/api/sandbox/${mine.id}`],
    ["GET", `${fake.toolboxUrl}/${mine.id}/process/execute`],
  ];
  for (const [method, target, body] of refusals) assert.equal((await call(method, target, body)).status, 403, `${method} ${target}`);
  // Another run's sandbox is not there for this run.
  assert.equal((await call("GET", `${fake.url}/sandbox/${other}`)).status, 404);
  assert.equal((await call("POST", `${fake.toolboxUrl}/${other}/process/execute`, { command: "true", timeout: 5 })).status, 404);
  assert.equal(fake.sandboxes.size, 2, "nothing was created or deleted through the relay");
  // (Anything on this machine may connect to the decoy's port: only a call with the key would be the relay's.)
  assert.ok(!elsewhere.includes(`Bearer ${KEY}`), "the key reached no other host");
  // What reached Daytona came with the key, never with the door token or the run's placeholder.
  assert.deepEqual([...new Set(fake.requests.slice(before).filter((r) => r.source === "pi-transport").map((r) => r.authorization))], [`Bearer ${KEY}`]);
  // The run's own door token is the only way in: no token, another run's token, or a run the server does not hold.
  const bare = await fetch(`${relay.url}/runs/run-mine/daytona`, { headers: { "x-agentrun-target": `${fake.url}/sandbox/${mine.id}` } });
  assert.equal(bare.status, 401);
  const borrowed = await fetch(`${relay.url}/runs/run-mine/daytona`, { headers: { authorization: `Bearer ${held.tokens["run-other"]}`, "x-agentrun-target": `${fake.url}/sandbox/${mine.id}` } });
  assert.equal(borrowed.status, 401);
  mkdirSync(held.dirOf("run-stranger"), { recursive: true });
  await writeFile(join(held.dirOf("run-stranger"), "door-token"), "a-token-the-server-never-made\n");
  const stranger = await relayFetch(root, held.dirOf("run-stranger"), "run-stranger")(`${fake.url}/sandbox/${mine.id}`, {});
  assert.equal(stranger.status, 401);
});
