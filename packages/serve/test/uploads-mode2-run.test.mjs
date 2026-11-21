// Uploads in Mode 2 on the runner split's path: a server with its runner apart (--no-runner), and a runner with a data
// directory of its own, sharing only the store. POST /v2/files keeps each file on the server's own uploads disk on
// Archil (agentrun-<server id>-files, made by the first upload), never in the server's data directory. A run started
// with file_ids has them copied into its folder on its agent's disk (work/inputs/<path>) by the server before its row is
// written; its launch says so (files_placed) and names the disk, and the runner, claiming it, finds them there byte for
// byte and reads no upload: it never opens the uploads disk, and its own data directory gets no files folder.
// A copy that fails refuses the start in words, with no run made. Over the Archil fakes (a control plane with no port,
// archil-control-fake.mjs archilControlFetch, and an in-memory disk per disk id, fixtures/archil-fake.mjs): nothing
// leaves this process.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agent, client, FAUX, follow, startInProcessRunner, startServe, whenFree, withEnv, writableTree } from "./support.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { archilControlFetch } from "./archil-control-fake.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { saveArchilSettings, serverIdOf } = await import("../dist/archil-settings.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { runKey } = await import("../dist/workspace/paths.js");
const { uploadsDiskName } = await import("../dist/uploads-archil.js");

const REGION = "aws-us-east-1";
const FAKE_ARCHIL = "fake-test-key-archil-up-0001";
const UNSET = ["AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE", "AGENTRUN_SEAL_KEY", "AGENTRUN_UPLOAD_RETENTION"];

/** A server apart from its runner, in Mode 2, and one runner on a data directory of its own. Each side gets its own maker
 *  of a disk's file API over one set of in-memory disks (by disk id), and the runner's records every disk and key it
 *  touches. */
async function split(t) {
  withEnv(t, { ARCHIL_API_KEY: FAKE_ARCHIL }, ["ARCHIL_API_KEY", ...UNSET]);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "uploads-mode2-"));
  const data = join(dir, "server");
  const runnerData = join(dir, "runner");
  mkdirSync(runnerData);
  const disks = new Map();
  const diskOf = (id) => {
    let disk = disks.get(id);
    if (!disk) {
      disk = new FakeArchilDisk();
      disk.id = id;
      disks.set(id, disk);
    }
    return disk;
  };
  const control = archilControlFetch({ region: REGION });
  const runnerTouched = [];
  /** The runner's view of a disk: each call it makes recorded with the disk's id and the key or prefix it names. */
  const runnerDisk = ({ disk: id }) => {
    const disk = diskOf(id);
    return new Proxy(disk, {
      get(target, name) {
        const value = Reflect.get(target, name, target);
        if (typeof value !== "function") return value;
        return (...args) => {
          runnerTouched.push({ disk: id, op: name, key: typeof args[0] === "string" ? args[0] : (args[0]?.directory ?? JSON.stringify(args[0])) });
          return value.apply(target, args);
        };
      },
    });
  };
  const server = await startServe({ data, port: 0, faux: FAUX, runnerApart: true, mcpLoopback: true, drainTimeout: "5s", archilControl: { baseUrl: control.baseUrl, fetch: control.fetch, makeDisk: ({ disk }) => diskOf(disk) } });
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.();
    await store.close().catch(() => {});
    await server.close();
    await writableTree(dir).then(() => rm(dir, { recursive: true, force: true }));
  });
  await saveArchilSettings(store, { region: REGION, s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  runner = await startInProcessRunner(data, { faux: FAUX, mcpOwn: server.own, ownData: runnerData, archil: { makeDisk: runnerDisk, control: { baseUrl: control.baseUrl, fetch: control.fetch } } });
  const api = client(server.baseUrl, server.token);
  /** POST /v2/files?path=<path> with `bytes` as the body: the answer's file. */
  const upload = async (path, bytes) => {
    const response = await fetch(`${server.baseUrl}/files?path=${encodeURIComponent(path)}`, { method: "POST", body: bytes, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/octet-stream" } });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body.file;
  };
  return { api, baseUrl: server.baseUrl, token: server.token, data, runnerData, disks, control, store, runnerTouched, upload, serverId: await serverIdOf(store) };
}

test("Mode 2: a run with file_ids on a runner with its own data finds its files in work/inputs/ byte for byte, placed by the server at its start; the runner reads no upload", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl, token, data, runnerData, disks, control, store, runnerTouched, upload, serverId } = await split(t);
  const plan = Buffer.from("# Plan\n\nStep one.\n");
  const blob = randomBytes(2 * 1024 * 1024 + 17);
  const a = await upload("docs/plan.md", plan);
  const b = await upload("data/blob.bin", blob);
  // The uploads: on the server's own disk, made by the first upload and named for the server; none in its data directory.
  const made = control.requests.filter((one) => one.method === "POST" && one.path === "/api/disks").map((one) => one.body.name);
  assert.deepEqual(made, [uploadsDiskName(serverId)], "the first upload made the uploads disk; the second found it");
  const uploadsDisk = [...control.disks.values()].find((disk) => disk.name === uploadsDiskName(serverId));
  assert.deepEqual(Buffer.from(disks.get(uploadsDisk.id).files.get(`files/${b.file_id}/bytes`)), blob);
  assert.ok(!existsSync(join(data, "files")), "the server keeps no upload in its data directory");
  const listed = await api("GET", "/files");
  assert.deepEqual(listed.body.files.map((file) => file.file_id), [b.file_id, a.file_id], "the list reads the uploads disk");

  const saved = await whenFree(() => api("POST", "/agents", agent("mode2-files", { tools: ["read"] })));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const before = runnerTouched.length;
  const started = await whenFree(() => api("POST", "/agents/mode2-files/runs", { input: { content: "Read your inputs." }, file_ids: [a.file_id, b.file_id] }));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  // The launch says the files are placed, and names the agent's disk the server placed them on.
  const launch = readLaunchBody((await store.runs.launch(runId)).body);
  assert.equal(launch.filesPlaced, true);
  assert.deepEqual(launch.files, [a.file_id, b.file_id]);
  assert.equal(launch.archilDisk?.kind, "agent");
  const runDisk = disks.get(launch.archilDisk.diskId);
  assert.ok(runDisk, "the run's folder is on its agent's disk");
  assert.notEqual(launch.archilDisk.diskId, uploadsDisk.id);

  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run));
  // The run's folder holds each file at work/inputs/<path>, byte for byte, and its message beside them.
  const key = runKey("mode2-files", runId);
  assert.deepEqual(Buffer.from(runDisk.files.get(`${key}/inputs/docs/plan.md`)), plan);
  assert.deepEqual(Buffer.from(runDisk.files.get(`${key}/inputs/data/blob.bin`)), blob);
  assert.equal(Buffer.from(runDisk.files.get(`${key}/inputs/message.md`)).toString("utf8"), "Read your inputs.");
  // The server reads them back from the run's folder as any run's file.
  const read = await fetch(`${baseUrl}/runs/${runId}/files/inputs/data/blob.bin`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(read.status, 200);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), blob);
  // The runner read no upload: it never opened the uploads disk, and wrote no files folder of its own.
  const runnerCalls = runnerTouched.slice(before);
  assert.ok(runnerCalls.length > 0, "the runner worked on the run's folder");
  assert.deepEqual(runnerCalls.filter((call) => call.disk === uploadsDisk.id), [], `the runner never touched the uploads disk: ${JSON.stringify(runnerCalls.filter((call) => call.disk === uploadsDisk.id))}`);
  assert.deepEqual(runnerCalls.filter((call) => /(^|\/)inputs\/(docs|data)\//.test(call.key) && call.op !== "getRange" && call.op !== "listPage"), [], "nor wrote a file of the run's inputs");
  assert.ok(!existsSync(join(runnerData, "files")), "the runner's data directory has no files folder");
  // A file deleted after the start does not touch the run's copy.
  assert.equal((await api("DELETE", `/files/${a.file_id}`)).status, 204);
  assert.deepEqual(Buffer.from(runDisk.files.get(`${key}/inputs/docs/plan.md`)), plan);
});

test("Mode 2: a start whose files can't be copied into the run's folder is refused in words, with no run made and nothing left in its folder", { timeout: 60_000 }, async (t) => {
  const { api, disks, upload } = await split(t);
  const a = await upload("a.txt", Buffer.from("a"));
  const saved = await whenFree(() => api("POST", "/agents", agent("mode2-refused", { tools: ["read"] })));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  // Every write to a run's folder fails, as a disk Archil refuses would.
  const runsBefore = (await api("GET", "/runs?agent=mode2-refused")).body.runs.length;
  const originalPut = FakeArchilDisk.prototype.putObject;
  FakeArchilDisk.prototype.putObject = async function (key, body) {
    if (key.includes("/runs/") && key.includes("/work/inputs/")) {
      const error = new Error("Archil refused the write (a test's)");
      error.status = 500;
      throw error;
    }
    return originalPut.call(this, key, body);
  };
  t.after(() => void (FakeArchilDisk.prototype.putObject = originalPut));
  const started = await api("POST", "/agents/mode2-refused/runs", { input: { content: "Go." }, file_ids: [a.file_id] });
  assert.equal(started.status, 424, JSON.stringify(started.body));
  assert.match(started.body.error.message, /The run's files could not be copied into its folder on Archil, so it was not started/);
  assert.equal((await api("GET", "/runs?agent=mode2-refused")).body.runs.length, runsBefore, "no run was made");
  for (const disk of disks.values()) assert.ok(![...disk.files.keys()].some((key) => key.includes("/work/inputs/")), "nothing is left in a run's inputs");
  // With the disk writing again, the same start is made: the refusal was the copy's alone.
  FakeArchilDisk.prototype.putObject = originalPut;
  const again = await whenFree(() => api("POST", "/agents/mode2-refused/runs", { input: { content: "Go." }, file_ids: [a.file_id] }));
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal((await api("GET", "/runs?agent=mode2-refused")).body.runs.length, runsBefore + 1);
});

test("Mode 2: two first starts of one inline agent at once place their files together, both under the agent the store keeps, and both runs complete", { timeout: 120_000 }, async (t) => {
  const { api, disks, store, upload } = await split(t);
  const a = await upload("a.txt", Buffer.from("first"));
  const b = await upload("b.txt", Buffer.from("second"));
  // Each run's first input write waits until the other run's has begun too (or 5 s): starts that took turns would not
  // overlap, and the first would wait out the 5 s alone.
  const placing = new Set();
  let both;
  const overlapped = new Promise((resolve) => (both = resolve));
  let waitedAlone = false;
  const originalPut = FakeArchilDisk.prototype.putObject;
  FakeArchilDisk.prototype.putObject = async function (key, bytes) {
    const run = /\/runs\/([^/]+)\/work\/inputs\//.exec(key)?.[1];
    if (run !== undefined && !placing.has(run)) {
      placing.add(run);
      if (placing.size === 2) both();
      else await Promise.race([overlapped, new Promise((resolve) => setTimeout(() => resolve((waitedAlone = true)), 5_000))]);
    }
    return originalPut.call(this, key, bytes);
  };
  t.after(() => void (FakeArchilDisk.prototype.putObject = originalPut));
  const body = (content, fileId) => ({ external: { source: "host", kind: "expert", id: "inline-race", version: 1 }, definition: { name: "Race", description: "Answers.", instructions: "Answer.", skills: [], tools: ["read"] }, input: { content }, file_ids: [fileId] });
  const [one, two] = await Promise.all([api("POST", "/runs", body("One.", a.file_id)), api("POST", "/runs", body("Two.", b.file_id))]);
  assert.equal(one.status, 202, JSON.stringify(one.body));
  assert.equal(two.status, 202, JSON.stringify(two.body));
  const rows = await Promise.all([one, two].map(async (started) => store.runs.get(started.body.run_id)));
  assert.equal(rows[0].agentId, rows[1].agentId, "one agent for the reference");
  assert.equal(waitedAlone, false, "the two starts placed their files at the same time; neither waited for the other");
  for (const [started, file, text] of [[one, "a.txt", "first"], [two, "b.txt", "second"]]) {
    const runId = started.body.run_id;
    const launch = readLaunchBody((await store.runs.launch(runId)).body);
    const placedAt = Buffer.from(disks.get(launch.archilDisk.diskId).files.get(`${runKey(rows[0].agentId, runId)}/inputs/${file}`) ?? "").toString("utf8");
    assert.equal(placedAt, text, "placed under the agent the run is written with");
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  }
});

test("Mode 2: starts at once share the server's copy slots: at most PLACE_CONCURRENCY files are copied into run folders at a time, across every start, and each start's files all land", { timeout: 120_000 }, async (t) => {
  // Archil's S3 gateway resets HTTP/2 streams (NGHTTP2_ENHANCE_YOUR_CALM) when 3 or more 10 MiB writes are in flight on
  // the server's one connection to it, measured live: the limit is the server's, not each start's.
  const { api, disks, store, upload } = await split(t);
  const { PLACE_CONCURRENCY } = await import("../dist/uploads-archil.js");
  assert.equal(PLACE_CONCURRENCY, 2);
  const ids = { one: [], two: [] };
  for (const [run, list] of Object.entries(ids)) for (let i = 0; i < 5; i++) list.push((await upload(`${run}/f${i}.txt`, Buffer.from(`${run} ${i}`))).file_id);
  const saved = await whenFree(() => api("POST", "/agents", agent("mode2-slots", { tools: ["read"] })));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  let inFlight = 0;
  let most = 0;
  const originalPut = FakeArchilDisk.prototype.putObject;
  FakeArchilDisk.prototype.putObject = async function (key, bytes) {
    if (!/\/runs\/[^/]+\/work\/inputs\/(one|two)\//.test(key)) return originalPut.call(this, key, bytes);
    most = Math.max(most, ++inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return await originalPut.call(this, key, bytes);
    } finally {
      inFlight--;
    }
  };
  t.after(() => void (FakeArchilDisk.prototype.putObject = originalPut));
  const [one, two] = await Promise.all(["one", "two"].map((run) => api("POST", "/agents/mode2-slots/runs", { input: { content: `Run ${run}.` }, file_ids: ids[run] })));
  assert.equal(one.status, 202, JSON.stringify(one.body));
  assert.equal(two.status, 202, JSON.stringify(two.body));
  assert.equal(most, PLACE_CONCURRENCY, `at most ${PLACE_CONCURRENCY} copies in flight across both starts, and that many used: ${most}`);
  for (const [run, started] of [["one", one], ["two", two]]) {
    const runId = started.body.run_id;
    const launch = readLaunchBody((await store.runs.launch(runId)).body);
    for (let i = 0; i < 5; i++) assert.equal(Buffer.from(disks.get(launch.archilDisk.diskId).files.get(`${runKey("mode2-slots", runId)}/inputs/${run}/f${i}.txt`) ?? "").toString("utf8"), `${run} ${i}`);
  }
});

test("Mode 2 retention: a run deleted (its tombstone kept) no longer keeps its uploads, while a run that is there still does", { timeout: 120_000 }, async (t) => {
  const { api, disks, control, store, upload, serverId } = await split(t);
  const { runKeepsUploads, WorkspaceUploads, UPLOADS_KEY, MARK_GRACE_MS } = await import("../dist/uploads-archil.js");
  const { archilWorkspace } = await import("../dist/workspace/archil.js");
  const gone = await upload("gone.txt", Buffer.from("gone"));
  const kept = await upload("kept.txt", Buffer.from("kept"));
  const saved = await whenFree(() => api("POST", "/agents", agent("mode2-retain", { tools: ["read"] })));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const runs = {};
  for (const [name, file] of [["gone", gone], ["kept", kept]]) {
    const started = await whenFree(() => api("POST", "/agents/mode2-retain/runs", { input: { content: "Go." }, file_ids: [file.file_id] }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    runs[name] = started.body.run_id;
    await follow(api, runs[name], ["completed", "failed"], { deadlineMs: 90_000 });
  }
  assert.equal((await api("DELETE", `/runs/${runs.gone}`)).status, 204);
  assert.ok((await store.runs.get(runs.gone))?.purgedAt, "the deleted run's tombstone is in the store");
  const keeps = runKeepsUploads(store);
  assert.equal(await keeps(runs.gone), false, "a deleted run keeps no upload");
  assert.equal(await keeps(runs.kept), true, "a run that is there keeps its uploads");
  assert.equal(await keeps("01a1fb00-0000-7000-8000-000000000000"), false, "nor does a run the store never had");
  // The sweep, past the retention and the marks' grace, deletes the deleted run's upload and keeps the other.
  const uploadsDisk = [...control.disks.values()].find((disk) => disk.name === `agentrun-${serverId}-files`);
  const sweeper = new WorkspaceUploads(archilWorkspace(disks.get(uploadsDisk.id), UPLOADS_KEY));
  const removed = await sweeper.sweep(1, keeps, Date.now() + MARK_GRACE_MS + 60_000);
  assert.deepEqual(removed, [gone.file_id]);
});
