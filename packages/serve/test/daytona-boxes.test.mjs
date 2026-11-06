// Daytona boxes for sandbox runs, on a fake Daytona on loopback (fixtures/fake-daytona.mjs): no provider call runs. The
// server makes a run's box with its key, gives it its host list (or no network), seeds it with the run's work/, pulls
// work/ back at each turn's end and once more before the run's end is recorded, then destroys it. The run's process holds no key: its Daytona calls
// go through the server's box relay, which sends on only the calls a run's tools make of that run's own box.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BOX_RELAY_FILE, relayFetch, startBoxRelay } from "../dist/box-relay.js";
import { BOX_ENV, BOX_SYNC_FILE, DEFAULT_BOX_ALLOW, runBox } from "../dist/run-box.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { daytonaSandboxes, tarOf } from "./fixtures/fake-daytona.mjs";
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

/** A server whose Daytona is `fake`, its key planted, with the probe model (fixtures/faux-probe.mjs). */
async function onDaytona(t, fake, extra = {}) {
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url, OPENAI_API_KEY: planted("model") });
  return serve(t, { faux: PROBE, ...extra });
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
  const fake = await daytonaSandboxes(t, { key: KEY, sudoProbe: true });
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

test("a box command that names a sudo by its absolute path is refused whole, never run, and fails the test that sent it", async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY, sudoProbe: true });
  const made = await (await fetch(`${fake.url}/sandbox`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ labels: { "pi-transport": "1" } }) })).json();
  const ran = await fetch(`${fake.toolboxUrl}/${made.id}/process/execute`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ command: "touch ran.txt; /usr/bin/sudo -n true", timeout: 10 }) });
  assert.deepEqual(await ran.json(), { exitCode: 97, result: "the fake refuses a command that names an absolute sudo" });
  assert.ok(!existsSync(join(fake.root, made.id, "ran.txt")), "no part of it ran");
  assert.deepEqual(fake.sudoCalls(), ["refused, by its absolute path: touch ran.txt; /usr/bin/sudo -n true"]);
});

test("a box made when boxes had the run's work/ at /run/agentrun/run/work is copied back from there, its own place, never from /workspace", async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  const { pullRemoteBox } = await import("../dist/run-box.js");
  const { daytonaBoxes } = await import("@parcha/pi-transport/box/daytona");
  const runId = "old-place";
  const made = await (await fetch(`${fake.url}/sandbox`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ labels: { "agentrun.run": runId, "agentrun.box": "run", "pi-transport": "1", "pi-transport.workspace": "/run/agentrun/run/work" } }) })).json();
  mkdirSync(fake.pathOf(made.id, "run/agentrun/run/work"), { recursive: true });
  await writeFile(fake.pathOf(made.id, "run/agentrun/run/work/kept.txt"), "from the old place");
  const dir = await scratch(t);
  mkdirSync(join(dir, "work"));
  await pullRemoteBox(daytonaBoxes({ apiKey: KEY, apiUrl: fake.url }), { id: runId, dir }, BACKGROUND_CONTEXT);
  assert.equal(readFileSync(join(dir, "work", "kept.txt"), "utf8"), "from the old place");
});

test("demo: a Daytona place runs read, write, edit and bash in the run's box: work/ seeded in, bash's out.txt in the run's files, its network the package registries' domain list, no key in the box, the box destroyed at the end", { timeout: 180_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  withEnv(t, { MONID_API_KEY: MONID_KEY });
  const server = await onDaytona(t, fake, { fauxMonid: FAUX_MONID });
  const { api, data } = server;
  const places = (await api("GET", "/capabilities")).body.places;
  assert.deepEqual(places.boxes.find((b) => b.id === "daytona"), { id: "daytona", available: true, state: "ready", network: "allowlist" });
  assert.deepEqual(places.allow, ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "registry.yarnpkg.com", "github.com", "codeload.github.com"]);
  const made = await api("POST", "/agents", { definition: { id: "remote", name: "remote", instructions: "Probe.", place: DAYTONA, tools: ["read", "write", "edit", "bash", "monid.discover"], tool_settings: { "monid.discover": { permission: "allow" } } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  const input = await upload(server, "brief.txt", "seeded from the run's work/\n");
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
  const [seeded, cwd] = said[0].text.trim().split("\n");
  assert.equal(seeded, "seeded from the run's work/", "the box was seeded with work/");
  assert.match(cwd, /\/workspace$/, "bash starts in the box's work/");
  assert.equal(said[4].text, "edited in the box");
  assert.equal(said[7].text.trim(), "1", "the file monid's answer was filed in is in the box");
  // The box's environment: the fixed one, and no key, token or door token.
  const door = (await readFile(join(data, ".door-token"), "utf8")).trim();
  const runDoor = (await readFile(join(runDir(data, run.run_id), "door-token"), "utf8")).trim();
  for (const [name, value] of Object.entries({ KEY, model: planted("model"), token: server.token, door, runDoor, monid: MONID_KEY })) assert.ok(!said[5].text.includes(value), `${name} reached the box`);
  // The run's files: what the box wrote, pulled back; what it removed, removed.
  assert.deepEqual((await fileList(api, run.run_id)).filter((path) => !path.startsWith("evidence/")), ["note.txt", "out.txt"]);
  assert.equal((await api("GET", `/runs/${run.run_id}/files/out.txt`)).body, "hello from the box\n");
  // The box Daytona was asked for: the default hosts as its domain list, the fixed environment, the run's labels;
  // destroyed at the end.
  const created = fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").map((r) => JSON.parse(r.body));
  assert.equal(created.length, 1);
  assert.equal(created[0].domainAllowList, DEFAULT_BOX_ALLOW.join(","));
  assert.equal(created[0].networkBlockAll, undefined);
  assert.deepEqual(created[0].env, BOX_ENV);
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
  assert.ok(existsSync(join(runDir(data, run.run_id), BOX_SYNC_FILE)), "the pull's mark is kept beside the run");
});

test("demo (claude-agent, codex): the faux harness's bash, write and read run in the run's Daytona box; an absolute path under its cwd is the box's same file; out.txt comes back", { timeout: 240_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
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

test("a turn's end pulls the box's work/ into the run's files while the box lives; the run's end pulls once more, then destroys it", { timeout: 180_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  const { api } = await onDaytona(t, fake);
  assert.equal((await api("POST", "/agents", { definition: { id: "asker", name: "asker", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const plan = [
    { tool: "bash", args: { command: "printf one > turn1.txt" } },
    { tool: "ask_person", args: { question: "Go on?" } },
    { tool: "bash", args: { command: "printf two > turn2.txt; rm turn1.txt" } },
  ];
  const run = await probe(api, "asker", plan);
  await follow(api, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  assert.deepEqual(await fileList(api, run.run_id), ["turn1.txt"], "the turn's end pulled what its box wrote");
  assert.equal(fake.sandboxes.size, 1, "the box lives while the run waits");
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.deepEqual(await fileList(api, run.run_id), ["turn2.txt"], "the last pull brought turn2.txt and removed turn1.txt");
  assert.equal(fake.sandboxes.size, 0);
});

test("a run's end waits for its box's last pull: one that fails is tried again, and the run ends only once its files are in", { timeout: 180_000 }, async (t) => {
  // The seed's listing is the first; the end's pull fails twice, then lands.
  const fake = await daytonaSandboxes(t, { key: KEY, failListings: [2, 3] });
  const { api } = await onDaytona(t, fake, { settleRetryMs: 300 });
  assert.equal((await api("POST", "/agents", { definition: { id: "patient", name: "patient", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "patient", [{ tool: "bash", args: { command: "printf late > out.txt" } }]);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.ok(fake.state.listings >= 4, `the pull was tried until it landed (${fake.state.listings} listings)`);
  assert.deepEqual(await fileList(api, run.run_id), ["out.txt"]);
  assert.equal(fake.sandboxes.size, 0, "the box went only after its pull");
});

test("a pull takes nothing from a lying box but the files it listed: an archive's ../, absolute and linked names write nothing outside work/", { timeout: 180_000 }, async (t) => {
  const outside = await scratch(t);
  const hostile = tarOf([
    { name: "out.txt", type: "file", body: "the listed file" },
    { name: "../escape.txt", type: "file", body: "escaped" },
    { name: `${outside}/absolute.txt`, type: "file", body: "absolute" },
    { name: "link", type: "symlink", target: outside },
    { name: "link/planted.txt", type: "file", body: "through the link" },
    { name: "sub/../../escape2.txt", type: "file", body: "escaped again" },
  ]);
  const fake = await daytonaSandboxes(t, { key: KEY, hostileTar: hostile });
  const { api, data } = await onDaytona(t, fake);
  assert.equal((await api("POST", "/agents", { definition: { id: "liar", name: "liar", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "liar", [{ tool: "bash", args: { command: "printf real > out.txt" } }]);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const dir = runDir(data, run.run_id);
  assert.equal(readFileSync(join(dir, "work", "out.txt"), "utf8"), "the listed file");
  assert.deepEqual(readdirSync(outside), [], "nothing was written outside work/");
  for (const name of ["escape.txt", "escape2.txt"]) assert.equal(existsSync(join(dir, name)), false, `${name} is not beside work/`);
  assert.equal(existsSync(join(dir, "work", "link")), false, "no link was made");
  assert.deepEqual(readdirSync(join(dir, "work")).sort(), ["out.txt"]);
  assert.ok(!lstatSync(join(dir, "work", "out.txt")).isSymbolicLink());
});

test("a pull a box's archive stops (unreadable) is not a whole copy: the run ends, and its box is kept, never destroyed with what it holds", { timeout: 180_000 }, async (t) => {
  // Not a tar at all: the extractor stops at it, having written nothing.
  const fake = await daytonaSandboxes(t, { key: KEY, hostileTar: Buffer.from("this is not an archive ".repeat(64)) });
  const { api, data } = await onDaytona(t, fake);
  assert.equal((await api("POST", "/agents", { definition: { id: "torn", name: "torn", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "torn", [{ tool: "bash", args: { command: "printf kept > out.txt" } }]);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.deepEqual(await fileList(api, run.run_id), [], "nothing came back");
  assert.equal(fake.sandboxes.size, 1, "the box that holds out.txt is kept");
  const [kept] = fake.sandboxes.keys();
  assert.equal(readFileSync(fake.pathOf(kept, "workspace/out.txt"), "utf8"), "kept");
  assert.ok(existsSync(join(runDir(data, run.run_id), BOX_SYNC_FILE)), "the mark of what did come back is kept");
  assert.equal(fake.sandboxes.get(kept).autoStopInterval, 15, "a kept box stops after 15 idle minutes: its disk stays, its compute stops");
  assert.equal(fake.sandboxes.get(kept).autoDeleteInterval, -1, "and is never deleted as it stops (a box is made with auto-delete 0, which would)");
});

test("a kept box that Daytona stopped is woken by the next start, pulled once its copy reads, and destroyed", { timeout: 180_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY, hostileTar: Buffer.from("this is not an archive ".repeat(64)) });
  const data = join(await scratch(t), "agents");
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "woken", name: "woken", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(firstApi, "woken", [{ tool: "bash", args: { command: "printf kept > out.txt" } }]);
  await follow(firstApi, run.run_id, ["completed"], { deadlineMs: 120_000 });
  await first.close();
  assert.equal(fake.sandboxes.size, 1, "kept");
  const [kept] = fake.sandboxes.values();
  // 15 idle minutes later Daytona stops it, as Daytona stops a box: one whose auto-delete is 0 goes with its stop.
  fake.idle(kept.id);
  assert.equal(fake.sandboxes.size, 1, "the kept box survives its idle stop, its files with it");
  assert.equal(kept.state, "stopped");
  fake.state.hostile = false;
  const second = await serve(t, { data, faux: PROBE });
  await until(() => fake.sandboxes.size === 0, "the start's sweep of the kept box");
  assert.deepEqual(await fileList(second.api, run.run_id), ["out.txt"]);
});

test("a run found waiting at a start is pulled then: a turn's end whose pull failed before the server went is brought back", { timeout: 180_000 }, async (t) => {
  // The seed's listing is the first; the first turn's end's pull (the second) fails, and the next server's pull lands.
  const fake = await daytonaSandboxes(t, { key: KEY, failListings: [2] });
  const data = join(await scratch(t), "agents");
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "waiter", name: "waiter", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(firstApi, "waiter", [{ tool: "bash", args: { command: "printf one > turn1.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }]);
  await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  await until(() => fake.state.listings >= 2, "the turn's end's pull");
  assert.deepEqual(await fileList(firstApi, run.run_id), [], "its pull failed");
  await first.close();
  const second = await serve(t, { data, faux: PROBE });
  await follow(second.api, run.run_id, ["input_required"], { deadlineMs: 60_000 });
  await until(async () => (await fileList(second.api, run.run_id)).includes("turn1.txt"), "the start's pull of a waiting run");
  assert.equal(fake.sandboxes.size, 1, "the box lives while the run waits");
});

test("a run's box that Daytona paused while the run waited is started again, never replaced: the next turn runs in the same box", { timeout: 180_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  const data = join(await scratch(t), "agents");
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "sleeper", name: "sleeper", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(firstApi, "sleeper", [{ tool: "bash", args: { command: "printf one > turn1.txt; printf only-in-the-box > box-only.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }, { tool: "bash", args: { command: "cat box-only.txt > turn2.txt" } }]);
  await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  await fileList(firstApi, run.run_id);
  await first.close();
  const [box] = fake.sandboxes.values();
  // An hour on, Daytona paused it (a class that pauses when idle); what only the box holds is still there.
  await writeFile(fake.pathOf(box.id, "workspace/box-only.txt"), "written after the last pull");
  fake.pause(box.id);
  const second = await serve(t, { data, faux: PROBE });
  assert.equal((await second.api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
  await follow(second.api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const created = fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox");
  assert.equal(created.length, 1, "no second box was made");
  assert.equal((await second.api("GET", `/runs/${run.run_id}/files/turn2.txt`)).body, "written after the last pull", "the next turn ran in the same box");
});

test("a run's box caught pausing is waited for and started again, never replaced", { timeout: 180_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  const data = join(await scratch(t), "agents");
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "midway", name: "midway", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(firstApi, "midway", [{ tool: "bash", args: { command: "printf one > turn1.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }, { tool: "bash", args: { command: "cat box-only.txt > turn2.txt" } }]);
  await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  await fileList(firstApi, run.run_id);
  await first.close();
  const [box] = fake.sandboxes.values();
  await writeFile(fake.pathOf(box.id, "workspace/box-only.txt"), "written after the last pull");
  // Caught mid-pause: it settles a few reads on.
  fake.pause(box.id, 3);
  const second = await serve(t, { data, faux: PROBE });
  assert.equal((await second.api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
  await follow(second.api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.equal(fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").length, 1, "no second box was made");
  assert.equal((await second.api("GET", `/runs/${run.run_id}/files/turn2.txt`)).body, "written after the last pull", "the next turn ran in the same box");
});

test("a run's box that Daytona archived (or is archiving) while the run waited is restored, never replaced", { timeout: 240_000 }, async (t) => {
  for (const reads of [0, 3]) {
    const fake = await daytonaSandboxes(t, { key: KEY });
    const data = join(await scratch(t), "agents");
    withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url });
    const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
    const firstApi = client(first.baseUrl, first.token);
    assert.equal((await firstApi("POST", "/agents", { definition: { id: "archived", name: "archived", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
    const run = await probe(firstApi, "archived", [{ tool: "bash", args: { command: "printf one > turn1.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }, { tool: "bash", args: { command: "cat box-only.txt > turn2.txt" } }]);
    await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
    await fileList(firstApi, run.run_id);
    await first.close();
    const [box] = fake.sandboxes.values();
    await writeFile(fake.pathOf(box.id, "workspace/box-only.txt"), "written after the last pull");
    fake.archive(box.id, reads);
    const second = await serve(t, { data, faux: PROBE });
    assert.equal((await second.api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
    await follow(second.api, run.run_id, ["completed"], { deadlineMs: 120_000 });
    assert.equal(fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").length, 1, `${reads}: no second box was made`);
    assert.equal((await second.api("GET", `/runs/${run.run_id}/files/turn2.txt`)).body, "written after the last pull", `${reads}: the next turn ran in the same box`);
    await second.close();
  }
});

test("an agent's edit to a file the host filed and mirrored into the box comes back: queued at the open or sent live", { timeout: 180_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  withEnv(t, { MONID_API_KEY: MONID_KEY });
  const { api, data } = await onDaytona(t, fake, { fauxMonid: FAUX_MONID });
  assert.equal((await api("POST", "/agents", { definition: { id: "editor", name: "editor", instructions: "Probe.", place: DAYTONA, tools: ["bash", "monid.discover"], tool_settings: { "monid.discover": { permission: "allow" } } } })).status, 201);
  const plan = [
    // Filed before any box is open: queued, then sent at the open.
    { tool: "monid_discover", args: { query: "everything at once" } },
    { tool: "bash", args: { command: "true" } },
    // Filed with the box open: sent at once.
    { tool: "monid_discover", args: { query: "everything at once, again" } },
    { tool: "bash", args: { command: "ls evidence/monid/*.json | wc -l; for f in evidence/monid/*.json; do printf edited > \"$f\"; done" } },
  ];
  const run = await probe(api, "editor", plan);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const filed = readdirSync(join(runDir(data, run.run_id), "work", "evidence", "monid"));
  assert.equal(filed.length, 2, filed.join(", "));
  for (const name of filed) assert.equal(readFileSync(join(runDir(data, run.run_id), "work", "evidence", "monid", name), "utf8"), "edited", `the box's edit of ${name} came back`);
});

test("a Daytona that neither keeps a domain list nor blocks a box's network gets no run's tool: the call fails naming why, and no box is left", { timeout: 120_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY, lists: false, blocks: false });
  const { api, data } = await onDaytona(t, fake);
  assert.equal((await api("POST", "/agents", { definition: { id: "open", name: "open", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "open", [{ tool: "bash", args: { command: "printf x > out.txt" } }]);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 90_000 });
  const [said] = answers(data, run.run_id);
  assert.equal(said.error, true);
  assert.match(said.text, /networkBlockAll/);
  assert.ok(!fake.requests.some((r) => r.path.endsWith("/process/execute") && r.body.includes("out.txt")), "no command ran");
  assert.equal(fake.sandboxes.size, 0);
});

/** The bodies of the creates Daytona was asked for. */
const creates = (fake) => fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").map((r) => JSON.parse(r.body));

for (const [daytona, options, code, words] of [
  ["keeps no domain list (a tier 1 or 2 organization)", { lists: false }, "unsupported", /Daytona did not keep this sandbox's domain list/],
  ["refuses a domain list (403)", { refusesLists: 403 }, "unauthorized", /not available for your organization's tier/],
  ["refuses a domain list (400)", { refusesLists: 400 }, "invalid", /not available for your organization's tier/],
]) {
  test(`a Daytona that ${daytona} gets boxes with no network, never open: the run's tool runs, capabilities say why, and the log says Daytona's own words`, { timeout: 120_000 }, async (t) => {
    const fake = await daytonaSandboxes(t, { key: KEY, ...options });
    const lines = [];
    const { api, data } = await onDaytona(t, fake, { log: (line) => lines.push(line) });
    assert.equal((await api("POST", "/agents", { definition: { id: "closed", name: "closed", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
    const first = await probe(api, "closed", [{ tool: "bash", args: { command: "printf x > out.txt" } }]);
    await follow(api, first.run_id, ["completed"], { deadlineMs: 90_000 });
    assert.deepEqual(answers(data, first.run_id).map((a) => a.error), [false]);
    // Asked with the list, then made again blocked; no sandbox with the list is left.
    assert.deepEqual(creates(fake).map((body) => [typeof body.domainAllowList, body.networkBlockAll]), [["string", undefined], ["undefined", true]]);
    assert.equal(fake.sandboxes.size, 0);
    const offer = (await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "daytona");
    assert.equal(offer.network, "none");
    assert.equal(offer.available, true);
    // Available, so `reason` (which says why a box is unavailable) is absent; `network_reason` says why it has no network.
    assert.equal(offer.reason, undefined);
    assert.match(offer.network_reason, new RegExp(`domain list \\(${code}\\).*tier 3 and 4.*AGENTRUN_BOX_ALLOW=none`));
    // places.allow is the server's configured list, still the six; the box's own network and network_reason say it does
    // not apply to Daytona now. The log says why Daytona refused, in its words.
    assert.deepEqual((await api("GET", "/capabilities")).body.places.allow, [...DEFAULT_BOX_ALLOW]);
    assert.deepEqual(Object.keys(offer).sort(), ["available", "id", "network", "network_reason", "state"]);
    const said = lines.filter((line) => line.includes("event=box_network"));
    assert.equal(said.length, 1, said.join("\n"));
    assert.match(said[0], new RegExp(`refused=${code}`));
    assert.match(said[0], words);
    // The next run's box is asked for blocked at once: the server does not try the list again until it starts again.
    const second = await probe(api, "closed", [{ tool: "bash", args: { command: "true" } }]);
    await follow(api, second.run_id, ["completed"], { deadlineMs: 90_000 });
    assert.deepEqual(creates(fake).slice(2).map((body) => [typeof body.domainAllowList, body.networkBlockAll]), [["undefined", true]]);
  });
}

test("a run's box made under a wider list is destroyed and made again under a narrower one after a restart, and kept under the same hosts in another order", { timeout: 240_000 }, async (t) => {
  for (const [later, remade] of [["pypi.org", true], ["GitHub.com, pypi.org", false]]) {
    const fake = await daytonaSandboxes(t, { key: KEY });
    const data = join(await scratch(t), "agents");
    withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url, AGENTRUN_BOX_ALLOW: "pypi.org,github.com" });
    const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
    const firstApi = client(first.baseUrl, first.token);
    assert.equal((await firstApi("POST", "/agents", { definition: { id: "narrowed", name: "narrowed", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
    const run = await probe(firstApi, "narrowed", [{ tool: "bash", args: { command: "printf one > turn1.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }, { tool: "bash", args: { command: "cat turn1.txt > turn2.txt" } }]);
    await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
    await until(async () => (await fileList(firstApi, run.run_id)).includes("turn1.txt"), "the turn's end's pull");
    await first.close();
    const [made] = fake.sandboxes.keys();
    process.env.AGENTRUN_BOX_ALLOW = later;
    const second = await serve(t, { data, faux: PROBE });
    assert.equal((await second.api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
    await follow(second.api, run.run_id, ["completed"], { deadlineMs: 120_000 });
    assert.equal((await second.api("GET", `/runs/${run.run_id}/files/turn2.txt`)).body, "one");
    const lists = creates(fake).map((body) => body.domainAllowList);
    if (remade) {
      assert.deepEqual(lists, ["pypi.org,github.com", "pypi.org"], "made again with the narrower list");
      assert.ok(fake.requests.some((r) => r.method === "DELETE" && r.path.endsWith(`/sandbox/${made}`)), "the wider box was destroyed");
    } else assert.deepEqual(lists, ["pypi.org,github.com"], "the same hosts: the box is kept");
    await second.close();
  }
});

test("a run's box under another list whose files cannot all be copied back is kept and not used: the tool call is refused, and nothing only it holds is lost", { timeout: 240_000 }, async (t) => {
  const failListings = [];
  const fake = await daytonaSandboxes(t, { key: KEY, failListings });
  const data = join(await scratch(t), "agents");
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url, AGENTRUN_BOX_ALLOW: "pypi.org,github.com" });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "unpulled", name: "unpulled", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(firstApi, "unpulled", [{ tool: "bash", args: { command: "printf one > turn1.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }, { tool: "bash", args: { command: "cat box-only.txt > turn2.txt" } }]);
  await follow(firstApi, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  await until(async () => (await fileList(firstApi, run.run_id)).includes("turn1.txt"), "the turn's end's pull");
  await first.close();
  const [made] = fake.sandboxes.keys();
  // Written in the box after its last pull; from now on every copy back fails.
  await writeFile(fake.pathOf(made, "workspace/box-only.txt"), "only in the box");
  for (let n = fake.state.listings + 1; n <= fake.state.listings + 40; n++) failListings.push(n);
  process.env.AGENTRUN_BOX_ALLOW = "pypi.org";
  const second = await serve(t, { data, faux: PROBE });
  assert.equal((await second.api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
  // Read through the API while the run lives: its store is the server's to write.
  const bashes = async () => ((await second.api("GET", `/runs/${run.run_id}/timeline`)).body.rows ?? []).filter((row) => row.kind === "tool_result" && row.tool_name === "bash");
  await until(async () => (await bashes()).length >= 2, "the next turn's bash answer", 120_000);
  const said = (await bashes()).at(-1);
  assert.equal(said.tool_status, "failed", JSON.stringify(said));
  assert.match(said.tool_result_preview, /another host list.*kept/);
  assert.deepEqual(creates(fake).map((body) => body.domainAllowList), ["pypi.org,github.com"], "no box was made in its place");
  assert.ok(!fake.requests.some((r) => r.method === "DELETE" && r.path.endsWith(`/sandbox/${made}`)), "the box was not destroyed");
  // Copies back work again: the run's end brings what only the box held.
  failListings.length = 0;
  await follow(second.api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.equal((await second.api("GET", `/runs/${run.run_id}/files/box-only.txt`)).body, "only in the box");
});

test("AGENTRUN_BOX_ALLOW=none: a Daytona box is made blocked, as before the list, and capabilities say none with no reason", { timeout: 120_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  withEnv(t, { AGENTRUN_BOX_ALLOW: "none" });
  const { api, data } = await onDaytona(t, fake);
  const places = (await api("GET", "/capabilities")).body.places;
  assert.deepEqual(places.boxes.find((b) => b.id === "daytona"), { id: "daytona", available: true, state: "ready", network: "none" });
  assert.deepEqual(places.allow, []);
  assert.equal((await api("POST", "/agents", { definition: { id: "none", name: "none", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "none", [{ tool: "bash", args: { command: "true" } }]);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 90_000 });
  assert.deepEqual(answers(data, run.run_id).map((a) => a.error), [false]);
  assert.deepEqual(creates(fake).map((body) => [body.domainAllowList, body.networkBlockAll]), [[undefined, true]]);
});

test("AGENTRUN_BOX_ALLOW replaces the default list: a Daytona box's domain list is the setting's hosts", { timeout: 120_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  withEnv(t, { AGENTRUN_BOX_ALLOW: "PyPI.org, *.pythonhosted.org,pypi.org" });
  const { api, data } = await onDaytona(t, fake);
  assert.deepEqual((await api("GET", "/capabilities")).body.places.allow, ["pypi.org", "*.pythonhosted.org"]);
  assert.equal((await api("POST", "/agents", { definition: { id: "py", name: "py", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "py", [{ tool: "bash", args: { command: "true" } }]);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 90_000 });
  assert.deepEqual(answers(data, run.run_id).map((a) => a.error), [false]);
  assert.deepEqual(creates(fake).map((body) => [body.domainAllowList, body.networkBlockAll]), [["pypi.org,*.pythonhosted.org", undefined]]);
});

test("a start pulls and destroys the box of a run that ended while its box was left (its delete failed)", { timeout: 180_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY, failDeletes: 1_000 });
  const data = join(await scratch(t), "agents");
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url });
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  const firstApi = client(first.baseUrl, first.token);
  assert.equal((await firstApi("POST", "/agents", { definition: { id: "left", name: "left", instructions: "Probe.", place: DAYTONA, tools: ["bash"] } })).status, 201);
  const run = await probe(firstApi, "left", [{ tool: "bash", args: { command: "printf kept > out.txt" } }]);
  await follow(firstApi, run.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.equal(fake.sandboxes.size, 1, "its delete failed, so its box is left");
  await first.close();
  const [left] = fake.sandboxes.keys();
  // Written in the box after the run's last pull: the sweep's pull keeps it.
  await writeFile(fake.pathOf(left, "workspace/late.txt"), "late");
  fake.state.failDeletes = 0;
  const second = await serve(t, { data, faux: PROBE });
  await until(() => fake.sandboxes.size === 0, "the start's sweep");
  assert.equal(readFileSync(join(runDir(data, run.run_id), "work", "late.txt"), "utf8"), "late");
  assert.deepEqual(await fileList(second.api, run.run_id), ["late.txt", "out.txt"]);
});

test("a file the server files before a run's process opens a box a process before it made is copied in at the open", { timeout: 60_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  // The box a run's earlier process made and the server seeded: its mark names it, so the open does not seed it again.
  const made = { id: "" };
  const relay = await relayFor(t, fake, ["run-again"], async () => ({ id: made.id, made: false }));
  made.id = await relay.make("run-again");
  mkdirSync(fake.pathOf(made.id, "workspace"), { recursive: true });
  const box = runBox({ relay: relay.root }, { id: "run-again", root: relay.root, dir: relay.dirOf("run-again"), place: DAYTONA });
  // The new process's first act: a host tool files a long answer, before any coding call opened the box.
  await box.mirror("evidence/monid/answer.json", '{"whole":"answer"}');
  await box.env(BACKGROUND_CONTEXT);
  await until(() => existsSync(fake.pathOf(made.id, "workspace/evidence/monid/answer.json")), "the filed answer in the box");
  assert.equal(readFileSync(fake.pathOf(made.id, "workspace/evidence/monid/answer.json"), "utf8"), '{"whole":"answer"}');
});

test("a toolbox answer that redirects is refused and never followed with the key: a box holding its toolbox's port cannot send the relay to another run's sandbox", async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
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
  const fake = await daytonaSandboxes(t, { key: KEY });
  const { api, data } = await onDaytona(t, fake);
  assert.equal((await api("POST", "/agents", { definition: { id: "pair", name: "pair", instructions: "Probe.", place: DAYTONA, tools: ["bash", "ask_person"] } })).status, 201);
  const plan = [{ tool: "bash", args: { command: "printf x > out.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }];
  const a = await probe(api, "pair", plan);
  const b = await probe(api, "pair", plan);
  await follow(api, a.run_id, ["input_required"], { deadlineMs: 120_000 });
  await follow(api, b.run_id, ["input_required"], { deadlineMs: 120_000 });
  const boxOf = (id) => [...fake.sandboxes.values()].find((s) => s.labels["agentrun.run"] === id).id;
  // The token run A's process was handed: its own file when it has one, else the server-wide one.
  const own = join(runDir(data, a.run_id), "door-token");
  const tokenA = readFileSync(existsSync(own) ? own : join(data, ".door-token"), "utf8").trim();
  const relayUrl = JSON.parse(readFileSync(join(data, BOX_RELAY_FILE), "utf8")).url;
  const asA = (run) => fetch(`${relayUrl}/runs/${run}/daytona`, { headers: { authorization: `Bearer ${tokenA}`, "x-agentrun-target": `${fake.url}/sandbox/${boxOf(run)}` } });
  // Each turn's end pulls its box, and a read of the files waits for that pull: once both are done, nothing else asks
  // run B's box.
  await fileList(api, a.run_id);
  await fileList(api, b.run_id);
  const before = fake.requests.length;
  const theirs = await asA(b.run_id);
  assert.ok([401, 403, 404].includes(theirs.status), `run A reached run B's box: ${theirs.status}`);
  assert.deepEqual(fake.requests.slice(before).filter((r) => r.path.includes(boxOf(b.run_id))).map((r) => `${r.method} ${r.path}`), [], "run B's box was never asked");
  assert.equal((await asA(a.run_id)).status, 200, "run A's own box answers its own token");
});

test("the relay: the door token only; a run it holds only; only that run's own sandbox, for a read and its toolbox's programs and files; the key goes nowhere else", async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
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
