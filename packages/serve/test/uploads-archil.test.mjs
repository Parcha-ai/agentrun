// Uploads in Mode 2 (uploads-archil.ts): kept on the server's own Archil disk under files/<file_id>/, by the same rules
// and words as Mode 1's (uploads.ts), and swept by age: a file older than the retention that no run names is deleted;
// a file a run in the store names, or one a run started with in the last hour (its row may not be written yet), is kept.
// Over the Archil fake (fixtures/archil-fake.mjs), in memory: nothing leaves this process.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { ApiError } from "../dist/errors.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveArchilSettings } from "../dist/archil-settings.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { archilPathProblem, archilUploads, DEFAULT_UPLOAD_RETENTION_MS, MARK_GRACE_MS, uploadRetentionMs, uploadsDiskName, WorkspaceUploads } from "../dist/uploads-archil.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { launchBody, readLaunchBody } from "../dist/run-launch.js";
import { copyFilesInto, filesToCopy } from "../dist/uploads.js";
import { archilWorkspace } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HOUR = 60 * 60_000;
/** A fake Archil account key: the fake control plane takes any. */
const OTHER_ARCHIL = "fake-test-key-archil-unit-02";
const FAKE_ARCHIL = "fake-test-key-archil-unit-01";
const DAY = 24 * HOUR;

function uploadsOn() {
  const disk = new FakeArchilDisk();
  const uploads = new WorkspaceUploads(archilWorkspace(disk, "files"));
  const send = async (path, bytes, type = "application/octet-stream") => (await (await uploads.take(new URLSearchParams({ path }), type, [bytes])).commit()).file;
  return { disk, uploads, send };
}

test("a file sent in one call is kept on the uploads disk at files/<id>/, its bytes byte for byte and its record; listed newest first, read, and deleted", async () => {
  const { disk, uploads, send } = uploadsOn();
  const bytes = randomBytes(300_000);
  const a = await send("docs/plan.bin", bytes);
  const b = await send("notes.md", Buffer.from("# notes\n"), "text/markdown");
  assert.equal(a.status, "ready");
  assert.equal(a.sha256, sha(bytes));
  assert.equal(a.size_bytes, bytes.length);
  assert.deepEqual(Buffer.from(disk.files.get(`files/${a.file_id}/bytes`)), bytes, "the bytes are on the disk as sent");
  assert.deepEqual(JSON.parse(Buffer.from(disk.files.get(`files/${a.file_id}/file.json`)).toString("utf8")), a, "its record beside them");
  assert.deepEqual(await uploads.get(a.file_id), a);
  assert.deepEqual(Buffer.from(await uploads.bytes(a)), bytes);
  assert.deepEqual(await uploads.ids(), [b.file_id, a.file_id], "newest first");
  await uploads.remove(a.file_id);
  assert.equal(await uploads.get(a.file_id), null);
  assert.ok(![...disk.files.keys()].some((key) => key.startsWith(`files/${a.file_id}/`)), "its folder is gone whole");
  await assert.rejects(uploads.remove(a.file_id), (error) => error instanceof ApiError && error.code === "not_found");
});

test("files sent in one millisecond still list newest first: each id sorts after the one before it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
  const { send, uploads } = uploadsOn();
  const sent = [];
  // 64 in one frozen millisecond: random ids would list them in this order by chance once in 64!.
  for (let i = 0; i < 64; i += 1) sent.push((await send(`f${i}.txt`, Buffer.from(String(i)))).file_id);
  assert.deepEqual(await uploads.ids(), [...sent].reverse(), "newest first");
});

test("a reservation and its PUT: pending, then ready with the bytes' hash; a body of another length or hash is a 422 at that field, and nothing changes", async () => {
  const { uploads } = uploadsOn();
  const bytes = Buffer.from("exactly these bytes");
  const { file, upload } = await uploads.reserve({ path: "in.txt", size_bytes: bytes.length });
  assert.equal(file.status, "pending");
  assert.equal(upload.url, `/v2/files/${file.file_id}`);
  await assert.rejects(uploads.receive(file.file_id, [Buffer.from("short")]), (error) => error instanceof ApiError && error.extra.fields?.[0]?.field === "size_bytes");
  assert.equal((await uploads.get(file.file_id)).status, "pending");
  const ready = await uploads.receive(file.file_id, [bytes]);
  assert.equal(ready.status, "ready");
  assert.equal(ready.sha256, sha(bytes));
  assert.deepEqual(await uploads.receive(file.file_id, [bytes]), ready, "the same bytes again change nothing");
  const other = Buffer.from("exactly those bytes");
  await assert.rejects(uploads.receive(file.file_id, [other]), (error) => error instanceof ApiError && error.extra.fields?.[0]?.field === "sha256");
  const named = await uploads.take(new URLSearchParams({ path: "x.txt", sha256: sha(Buffer.from("other")) }), "text/plain", [bytes]).catch((error) => error);
  assert.ok(named instanceof ApiError && named.extra.fields?.[0]?.field === "sha256", "a hash the query names that the bytes do not have");
});

test("a run's file_ids are checked as Mode 1 checks them: ready, none twice, at most 20, each a file of this store", async () => {
  const { uploads, send } = uploadsOn();
  const a = await send("a.txt", Buffer.from("a"));
  const { file: pending } = await uploads.reserve({ path: "b.txt", size_bytes: 1 });
  assert.deepEqual((await uploads.readyFiles([a.file_id])).map((file) => file.file_id), [a.file_id]);
  const refused = await uploads.readyFiles([a.file_id, pending.file_id, "no-such-file"]).catch((error) => error);
  assert.ok(refused instanceof ApiError);
  assert.deepEqual(refused.extra.fields.map((issue) => [issue.field, issue.reason]), [["file_ids[1]", "invalid"], ["file_ids[2]", "not_an_option"]]);
  await assert.rejects(uploads.readyFiles([a.file_id, a.file_id]), (error) => error instanceof ApiError && error.extra.fields?.[0]?.reason === "duplicate");
});

test("retention deletes only files older than it that no run names: a run in the store, or a run started within the hour, keeps its file", async () => {
  const { disk, uploads, send } = uploadsOn();
  const old = await send("old-unused.txt", Buffer.from("1"));
  const kept = await send("old-named.txt", Buffer.from("2"));
  const orphan = await send("old-named-by-a-gone-run.txt", Buffer.from("3"));
  const starting = await send("old-named-by-a-starting-run.txt", Buffer.from("4"));
  const fresh = await send("new-unused.txt", Buffer.from("5"));
  const retention = 7 * DAY;
  const now = Date.now() + retention + DAY;
  // Marked long ago (beyond the grace) by a run the store has, and by one it no longer has; and just now, by a run whose
  // row is not written yet.
  await uploads.mark([kept.file_id], "run-live", now - 3 * DAY);
  await uploads.mark([orphan.file_id], "run-gone", now - 3 * DAY);
  await uploads.mark([starting.file_id], "run-starting", now - MARK_GRACE_MS / 2);
  // The new one was made just before the sweep: under the retention.
  const freshAt = { ...fresh, created_at: new Date(now - DAY).toISOString() };
  disk.files.set(`files/${fresh.file_id}/file.json`, Buffer.from(`${JSON.stringify(freshAt)}\n`));
  const asked = [];
  const hasRun = async (runId) => {
    asked.push(runId);
    return runId === "run-live";
  };
  const deleted = await uploads.sweep(retention, hasRun, now);
  assert.deepEqual(new Set(deleted), new Set([old.file_id, orphan.file_id]));
  assert.deepEqual(new Set(await uploads.ids()), new Set([kept.file_id, starting.file_id, fresh.file_id]));
  assert.ok(!asked.includes("run-starting"), "a mark within the grace keeps its file without asking the store");
  // Once the starting run's mark is past the grace and the store has no such run, it goes too.
  assert.deepEqual(await uploads.sweep(retention, hasRun, now + MARK_GRACE_MS), [starting.file_id]);
});

test("AGENTRUN_UPLOAD_RETENTION: 7 days unset, a duration with its unit, or off; anything else is refused naming the variable", () => {
  assert.equal(uploadRetentionMs(undefined), DEFAULT_UPLOAD_RETENTION_MS);
  assert.equal(DEFAULT_UPLOAD_RETENTION_MS, 7 * DAY);
  assert.equal(uploadRetentionMs("36h"), 36 * HOUR);
  assert.equal(uploadRetentionMs("90m"), 90 * 60_000);
  assert.equal(uploadRetentionMs("off"), undefined);
  assert.throws(() => uploadRetentionMs("7 days"), /AGENTRUN_UPLOAD_RETENTION/);
  assert.throws(() => uploadRetentionMs("0d"), /AGENTRUN_UPLOAD_RETENTION/);
});

test("the uploads disk is named for the server, never as an agent's; a path whose run copy would pass Archil's key limit is refused at upload", () => {
  assert.equal(uploadsDiskName("0123456789ab"), "agentrun-0123456789ab-files");
  assert.equal(archilPathProblem("docs/plan.md"), undefined);
  assert.match(archilPathProblem(`${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(200)}/${"d".repeat(200)}`), /too long for a run's folder on Archil/);
  assert.match(archilPathProblem("../x"), /starts with \./);
});

test("a launch whose files the server placed says so, read back the same, and its claim copies none; one without copies its files as before", () => {
  const launch = { input: { content: "x" }, title: "x", place: { mode: "runner" }, files: ["f1", "f2"] };
  const placed = { ...launch, filesPlaced: true };
  assert.equal(launchBody(placed).files_placed, true);
  assert.equal(readLaunchBody(launchBody(placed)).filesPlaced, true);
  assert.equal(readLaunchBody(launchBody(launch)).filesPlaced, undefined);
  assert.deepEqual(filesToCopy(readLaunchBody(launchBody(placed))), []);
  assert.deepEqual(filesToCopy(readLaunchBody(launchBody(launch))), ["f1", "f2"]);
});

/** archilUploads over a store in Mode 2 and the Archil fakes: the control plane, and one in-memory disk per id, each
 *  made through `wrap` (a test's proxy) when given. */
async function mode2(t, { wrap = (disk) => disk, placeTimeoutMs } = {}) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "uploads-archil-"));
  const store = await openSqliteStore({ dataDir: dir });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await saveArchilSettings(store, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  const disks = new Map();
  const diskOf = (id) => {
    if (!disks.has(id)) disks.set(id, Object.assign(new FakeArchilDisk(), { id }));
    return disks.get(id);
  };
  const control = archilControlFetch({ region: "aws-us-east-1" });
  const env = { ARCHIL_API_KEY: FAKE_ARCHIL };
  const files = archilUploads({ store, sealKey: undefined, env, control: { baseUrl: control.baseUrl, fetch: control.fetch, makeDisk: ({ disk }) => wrap(diskOf(disk)) }, ...(placeTimeoutMs ? { placeTimeoutMs } : {}) });
  return { files, disks, store, env, control };
}

test("two PUTs of one file in two requests take turns on the uploads disk: one makes it ready, the other's different bytes are a 422", async (t) => {
  const { files, disks } = await mode2(t);
  const { file } = await (await files.here(true)).reserve({ path: "race.txt", size_bytes: 5 });
  const [first, second] = [await files.here(false), await files.here(false)];
  const disk = [...disks.values()][0];
  let release;
  disk.hold = new Promise((resolve) => (release = resolve));
  const one = first.receive(file.file_id, [Buffer.from("aaaaa")]);
  const two = second.receive(file.file_id, [Buffer.from("bbbbb")]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  disk.hold = undefined;
  release();
  const [a, b] = await Promise.allSettled([one, two]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal(b.reason.extra.fields?.[0]?.field, "sha256");
  const kept = await first.get(file.file_id);
  assert.equal(kept.sha256, sha(Buffer.from("aaaaa")));
  assert.deepEqual(Buffer.from(await first.bytes(kept)), Buffer.from("aaaaa"), "the record's hash is its bytes'");
});

test("a placement past its deadline answers then, and what it wrote is removed only once the read it waited on has settled", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let slowId;
  const wrap = (disk) => new Proxy(disk, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      if (name === "getRange") return async (key, range) => {
        if (slowId !== undefined && key === `files/${slowId}/bytes`) await gate;
        return value.call(target, key, range);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { files, disks } = await mode2(t, { wrap, placeTimeoutMs: 300 });
  const uploads = await files.here(true);
  const ids = [];
  for (const name of ["fast.txt", "slow.bin"]) ids.push((await (await uploads.take(new URLSearchParams({ path: name }), "text/plain", [Buffer.from(name)])).commit()).file.file_id);
  slowId = ids[1];
  const launch = { input: { content: "x" }, title: "x", place: { mode: "runner" }, files: ids };
  const at = Date.now();
  await assert.rejects(files.place("run-late", "agent-late", launch), (error) => error instanceof ApiError && error.code === "upstream_failed" && /took longer than 0.3 s/.test(error.message));
  assert.ok(Date.now() - at < 2_000, "answered by the deadline, not by the stuck read");
  const runFiles = () => [...disks.values()].flatMap((disk) => [...disk.files.keys()]).filter((key) => key.includes("/runs/run-late/work/"));
  release();
  for (let i = 0; i < 100 && runFiles().length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(runFiles(), [], "nothing the late copy wrote is left");
});

test("a copy that fails waits for every file already started before it answers", async () => {
  const disk = new FakeArchilDisk();
  const ws = archilWorkspace(disk, "run/work");
  let slowDone = false;
  const file = (id, path) => ({ file_id: id, path, size_bytes: 1, content_type: "text/plain", sha256: null, status: "ready", created_at: new Date().toISOString(), expires_at: null });
  const read = async (f) => {
    if (f.file_id === "bad") throw new Error("read failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    slowDone = true;
    return Buffer.from("slow");
  };
  await assert.rejects(copyFilesInto(ws, [file("slow", "slow.txt"), file("bad", "bad.txt"), file("never", "never.txt")], read, { concurrency: 2 }), /read failed/);
  assert.ok(slowDone, "the slow file had settled before the copy answered");
  assert.ok(disk.files.has("run/work/inputs/slow.txt"), "its write landed before the answer, so a cleanup after sees it");
  assert.ok(!disk.files.has("run/work/inputs/never.txt"), "no file was started after the failure");
});

test("a key of another Archil account in the same region finds that account's uploads disk again, never the old account's cached one", async (t) => {
  const { files, env, control } = await mode2(t);
  await files.here(true);
  const lookups = (key) => control.requests.filter((one) => one.method === "GET" && one.path === "/api/disks" && one.authorization === `Bearer ${key}`).length;
  assert.equal(lookups(FAKE_ARCHIL), 1, "the first upload looked the disk up with the key it had");
  await files.here(false);
  assert.equal(lookups(FAKE_ARCHIL), 1, "the same key reads the disk it found");
  env.ARCHIL_API_KEY = OTHER_ARCHIL;
  await files.here(true);
  assert.equal(lookups(OTHER_ARCHIL), 1, "the other account's key looks its own uploads disk up");
});
