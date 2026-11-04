// Daytona boxes for sandbox runs, on a fake Daytona on loopback (fixtures/fake-daytona.mjs): no provider call runs. The
// server makes a run's box with its key, closes its network, seeds it with the run's work/, pulls work/ back at each turn's
// end and once more before the run's end is recorded, then destroys it. The run's process holds no key: its Daytona calls
// go through the server's box relay, which sends on only the calls a run's tools make of that run's own box.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BOX_RELAY_FILE, relayFetch, startBoxRelay } from "../dist/box-relay.js";
import { BOX_ENV, BOX_SYNC_FILE, runBox } from "../dist/run-box.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { daytonaSandboxes, tarOf } from "./fixtures/fake-daytona.mjs";
import { startServe } from "../dist/index.js";
import { client, follow, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const DAYTONA = { mode: "sandbox", box: "daytona" };
const planted = (name) => `planted-${name}-sentinel`;
const KEY = planted("daytona-key");
const ENV_PROBE = "env; cat /proc/self/environ 2>/dev/null | tr '\\0' '\\n'";

/** Each tool call of run `runId` and its answer, in order, from its released store. */
function answers(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
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

const fileList = async (api, runId) => (await api("GET", `/runs/${runId}/files`)).body.files.map((file) => file.path).sort();

test("demo: a Daytona place runs read, write, edit and bash in the run's box: work/ seeded in, bash's out.txt in the run's files, the network closed, no key in the box, the box destroyed at the end", { timeout: 180_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  withEnv(t, { MONID_API_KEY: MONID_KEY });
  const server = await onDaytona(t, fake, { fauxMonid: FAUX_MONID });
  const { api, data } = server;
  assert.deepEqual((await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "daytona"), { id: "daytona", available: true });
  const made = await api("POST", "/agents", { definition: { id: "remote", name: "remote", instructions: "Probe.", place: DAYTONA, tools: ["read", "write", "edit", "bash", "monid.discover"] } });
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
  assert.match(cwd, /\/run\/agentrun\/run\/work$/, "bash starts in the box's work/");
  assert.equal(said[4].text, "edited in the box");
  assert.equal(said[7].text.trim(), "1", "the file monid's answer was filed in is in the box");
  // The box's environment: the fixed one, and no key, token or door token.
  const door = (await readFile(join(data, ".door-token"), "utf8")).trim();
  for (const [name, value] of Object.entries({ KEY, model: planted("model"), token: server.token, door, monid: MONID_KEY })) assert.ok(!said[5].text.includes(value), `${name} reached the box`);
  // The run's files: what the box wrote, pulled back; what it removed, removed.
  assert.deepEqual((await fileList(api, run.run_id)).filter((path) => !path.startsWith("evidence/")), ["note.txt", "out.txt"]);
  assert.equal((await api("GET", `/runs/${run.run_id}/files/out.txt`)).body, "hello from the box\n");
  // The box Daytona was asked for: network blocked, the fixed environment, the run's labels; destroyed at the end.
  const created = fake.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").map((r) => JSON.parse(r.body));
  assert.equal(created.length, 1);
  assert.equal(created[0].networkBlockAll, true);
  assert.deepEqual(created[0].env, BOX_ENV);
  assert.equal(created[0].labels["agentrun.run"], run.run_id);
  assert.equal(fake.sandboxes.size, 0, "the box is destroyed");
  // Every provider call that reached Daytona came with the server's key: the run's process, which has none, reached it
  // only through the relay.
  const provider = fake.requests.filter((r) => r.source === "pi-transport");
  assert.ok(provider.length > 0);
  assert.deepEqual(provider.filter((r) => r.authorization !== `Bearer ${KEY}`).map((r) => `${r.method} ${r.path}`), []);
  assert.ok(fake.requests.some((r) => r.path.endsWith("/process/execute")));
  const log = readFileSync(join(data, "runs", run.run_id, "process.log"), "utf8");
  assert.ok(!log.includes(KEY), "the key is in no line of the run's process");
  assert.ok(existsSync(join(data, "runs", run.run_id, BOX_SYNC_FILE)), "the pull's mark is kept beside the run");
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
  const runDir = join(data, "runs", run.run_id);
  assert.equal(readFileSync(join(runDir, "work", "out.txt"), "utf8"), "the listed file");
  assert.deepEqual(readdirSync(outside), [], "nothing was written outside work/");
  for (const name of ["escape.txt", "escape2.txt"]) assert.equal(existsSync(join(runDir, name)), false, `${name} is not beside work/`);
  assert.equal(existsSync(join(runDir, "work", "link")), false, "no link was made");
  assert.deepEqual(readdirSync(join(runDir, "work")).sort(), ["out.txt"]);
  assert.ok(!lstatSync(join(runDir, "work", "out.txt")).isSymbolicLink());
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
  assert.equal(readFileSync(fake.pathOf(kept, "run/agentrun/run/work/out.txt"), "utf8"), "kept");
  assert.ok(existsSync(join(data, "runs", run.run_id, BOX_SYNC_FILE)), "the mark of what did come back is kept");
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

test("a Daytona that does not block a box's network gets no run's tool: the call fails naming why, and no box is left", { timeout: 120_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY, blocks: false });
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
  await writeFile(fake.pathOf(left, "run/agentrun/run/work/late.txt"), "late");
  fake.state.failDeletes = 0;
  const second = await serve(t, { data, faux: PROBE });
  await until(() => fake.sandboxes.size === 0, "the start's sweep");
  assert.equal(readFileSync(join(data, "runs", run.run_id, "work", "late.txt"), "utf8"), "late");
  assert.deepEqual(await fileList(second.api, run.run_id), ["late.txt", "out.txt"]);
});

test("a file the server files before a run's process opens a box a process before it made is copied in at the open", { timeout: 60_000 }, async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  const root = await scratch(t);
  await writeFile(join(root, ".door-token"), "door-token-of-the-test\n");
  // The box a run's earlier process made and the server seeded: its mark names it, so the open does not seed it again.
  const made = await (await fetch(`${fake.url}/sandbox`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ labels: { "agentrun.run": "run-again", "agentrun.box": "run", "pi-transport": "1", "pi-transport.workspace": "/run/agentrun/run/work" } }) })).json();
  mkdirSync(fake.pathOf(made.id, "run/agentrun/run/work"), { recursive: true });
  const relay = await startBoxRelay({ root, token: "door-token-of-the-test", apiUrl: fake.url, apiKey: KEY, serves: (id) => id === "run-again", ensure: async () => ({ id: made.id, made: false }) });
  t.after(() => relay.close());
  const runDir = join(root, "runs", "run-again");
  const box = runBox({ relay: root }, { id: "run-again", root, dir: runDir, place: DAYTONA });
  // The new process's first act: a host tool files a long answer, before any coding call opened the box.
  await box.mirror("evidence/monid/answer.json", '{"whole":"answer"}');
  await box.env(BACKGROUND_CONTEXT);
  await until(() => existsSync(fake.pathOf(made.id, "run/agentrun/run/work/evidence/monid/answer.json")), "the filed answer in the box");
  assert.equal(readFileSync(fake.pathOf(made.id, "run/agentrun/run/work/evidence/monid/answer.json"), "utf8"), '{"whole":"answer"}');
});

test("the relay: the door token only; a run it holds only; only that run's own sandbox, for a read and its toolbox's programs and files; the key goes nowhere else", async (t) => {
  const fake = await daytonaSandboxes(t, { key: KEY });
  const root = await scratch(t);
  await writeFile(join(root, ".door-token"), "door-token-of-the-test\n");
  const mine = { id: "", run: "run-mine" };
  const relay = await startBoxRelay({ root, token: "door-token-of-the-test", apiUrl: fake.url, apiKey: KEY, serves: (id) => id === "run-mine" || id === "run-other", ensure: async () => ({ id: mine.id, made: true }) });
  t.after(() => relay.close());
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

  const relayed = relayFetch(root, "run-mine");
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
  // The door token is the only way in, and a run the server does not hold has no relay.
  const bare = await fetch(`${relay.url}/runs/run-mine/daytona`, { headers: { "x-agentrun-target": `${fake.url}/sandbox/${mine.id}` } });
  assert.equal(bare.status, 401);
  const stranger = await relayFetch(root, "run-stranger")(`${fake.url}/sandbox/${mine.id}`, {});
  assert.equal(stranger.status, 404);
});
