// The server's read-only view of a run's folder (workspace/server-run-workspace.ts): serverRunWorkspace(store, runId)
// gives the run's Workspace with no runner claim, so the server answers a run's file routes from it. Mode 1: the run's
// local folder. Mode 2: the run's folder on the server's Archil disk, its key opened from the store's sealed keys with the
// server's seal key. Read, list, stat and grep work. Every write, exec, background call, mount and attach is refused in
// plain words. A link is never followed. null when there is no such run, or its folder is not there yet. Over a real
// store on a temp file, a temp folder, and the Archil fake; nothing leaves this machine.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { saveArchilSettings } from "../dist/archil-settings.js";
import { putSealedKey } from "../dist/server-keys.js";
import { ARCHIL_API_KEY_ROW, runFolder, runKey, serverRunWorkspace } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { queued, storeOn } from "./store-helpers.mjs";

const WORDS = /the server reads a run's files; only its runner writes them/;

/** Every call that changes the folder, runs something, or puts it in a computer: each refused, nothing changed. */
async function everyWriteRefused(workspace) {
  const refused = (promise, what) => assert.rejects(promise, (error) => error.code === "REFUSED" && WORDS.test(error.message), what);
  await refused(workspace.write("new.txt", "x"), "write");
  await refused(workspace.append("notes.md", "x"), "append");
  await refused(workspace.mkdir("made"), "mkdir");
  await refused(workspace.remove("notes.md"), "remove");
  await refused(workspace.remove("", { recursive: true, force: true }), "remove the root");
  await refused(workspace.exec(["true"], { env: {} }), "exec");
  for (const call of ["start", "read", "write", "signal", "wait", "list"]) await refused(workspace.process[call]({}), `process.${call}`);
  await refused(workspace.mountSpec(), "mountSpec");
  await refused(workspace.attach({}, {}), "attach");
  assert.equal(await workspace.stat("new.txt"), undefined, "nothing was written");
  assert.equal(await workspace.stat("made"), undefined, "nothing was made");
  assert.deepEqual(Buffer.from(await workspace.read("notes.md")).toString(), "line one\nneedle here\n", "nothing changed");
}

async function reads(workspace) {
  assert.equal(Buffer.from(await workspace.read("notes.md")).toString(), "line one\nneedle here\n");
  assert.equal(Buffer.from(await workspace.read("notes.md", { offset: 5, length: 3 })).toString(), "one");
  assert.deepEqual((await workspace.list("")).filter((one) => one.name !== "out").map((one) => [one.name, one.kind]), [["docs", "dir"], ["notes.md", "file"]]);
  assert.deepEqual((await workspace.list("docs")).map((one) => one.name), ["a.txt"]);
  assert.equal((await workspace.stat("notes.md")).kind, "file");
  assert.equal(await workspace.stat("missing.txt"), undefined);
  assert.deepEqual((await workspace.grep("needle")).matches.map((one) => [one.path, one.line]), [["notes.md", 2]]);
}

test("Mode 1: the run's local folder, read-only; a link is not followed; null for an unknown run or one with no folder yet", async (t) => {
  const { store, dir } = await storeOn(t);
  await queued(store, "run-1");
  await queued(store, "run-2");
  const folder = runFolder(dir, "agent-1", "run-1");
  mkdirSync(join(folder, "docs"), { recursive: true });
  writeFileSync(join(folder, "notes.md"), "line one\nneedle here\n");
  writeFileSync(join(folder, "docs", "a.txt"), "a");
  writeFileSync(join(dir, "outside-secret"), "not the run's");
  symlinkSync(join(dir, "outside-secret"), join(folder, "out"));
  const options = { data: dir, sealKey: undefined };
  const workspace = await serverRunWorkspace(store, "run-1", options);
  await reads(workspace);
  assert.equal((await workspace.stat("out")).kind, "link");
  await assert.rejects(workspace.read("out"), (error) => error.code === "ESCAPE", "a link is not followed");
  await everyWriteRefused(workspace);
  assert.equal(await serverRunWorkspace(store, "run-404", options), null, "no such run");
  assert.equal(await serverRunWorkspace(store, "run-2", options), null, "a run whose folder is not there yet");
});

const SETTINGS = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example" };

async function mode2(t, { saveKey = true } = {}) {
  const { store, dir } = await storeOn(t);
  await queued(store, "run-1");
  await queued(store, "run-2");
  await saveArchilSettings(store, SETTINGS);
  const sealKey = randomBytes(32);
  if (saveKey) await putSealedKey(store, sealKey, ARCHIL_API_KEY_ROW, "fake-archil-account-key");
  const disk = new FakeArchilDisk();
  const made = [];
  const root = runKey("agent-1", "run-1");
  disk.files.set(`${root}/notes.md`, Buffer.from("line one\nneedle here\n"));
  disk.files.set(`${root}/docs/a.txt`, Buffer.from("a"));
  for (const one of [root, `${root}/docs`]) disk.dirs.add(one);
  disk.files.set("outside/secret", Buffer.from("not the run's"));
  disk.links.set(`${root}/out`, "../../../../../outside/secret");
  const options = { data: dir, sealKey, makeDisk: (given) => { made.push(given); return disk; } };
  return { store, disk, made, options };
}

test("Mode 2: the run's folder on the server's Archil disk, its key opened from the sealed keys, read-only; a link is not followed", async (t) => {
  const { store, disk, made, options } = await mode2(t);
  const workspace = await serverRunWorkspace(store, "run-1", options);
  await reads(workspace);
  assert.deepEqual(made.map((one) => [one.disk, one.region, one.s3BaseUrl, one.key()]), [[SETTINGS.diskId, SETTINGS.region, SETTINGS.s3Url, "fake-archil-account-key"]], "the disk from the settings, with the sealed key");
  // Archil's file API can't tell a link from a file (archil.ts's named limit): it lists as a file, and its read fails.
  assert.equal((await workspace.stat("out")).kind, "file");
  await assert.rejects(workspace.read("out"), (error) => error.code === "UNAVAILABLE" && !error.message.includes("not the run's"), "a link is not followed");
  const writes = disk.calls.length;
  await everyWriteRefused(workspace);
  assert.deepEqual(disk.calls.slice(writes).filter((call) => !["getRange", "listPage", "grep", "head", "stat"].includes(call.op)).map((call) => call.op), [], "no call that changes the disk was made");
  assert.equal(disk.calls.some((call) => call.op === "exec"), false, "no exec");
  assert.equal(await serverRunWorkspace(store, "run-404", options), null, "no such run");
  assert.equal(await serverRunWorkspace(store, "run-2", options), null, "a run whose folder is not there yet");
  disk.dirs.add(runKey("agent-1", "run-2"));
  assert.deepEqual(await (await serverRunWorkspace(store, "run-2", options)).list(""), [], "an empty folder that is there is a folder");
});

test("Mode 2 with no saved account key, or no seal key: refused in words naming what to save, never a value", async (t) => {
  const { store, options } = await mode2(t, { saveKey: false });
  await assert.rejects(serverRunWorkspace(store, "run-1", options), (error) => error.code === "UNAVAILABLE" && error.message.includes(ARCHIL_API_KEY_ROW));
  await assert.rejects(serverRunWorkspace(store, "run-1", { ...options, sealKey: undefined }), (error) => error.code === "UNAVAILABLE" && /seal key/.test(error.message));
});

test("Mode 2: an ARCHIL_API_KEY in the server's environment is the account key, over a saved one (the one resolver)", async (t) => {
  const { store, made, options } = await mode2(t);
  const workspace = await serverRunWorkspace(store, "run-1", { ...options, env: { ARCHIL_API_KEY: "archil-env-key-0002" } });
  assert.equal(Buffer.from(await workspace.read("notes.md")).toString(), "line one\nneedle here\n");
  assert.equal(made.at(-1).key(), "archil-env-key-0002");
  const unsaved = await mode2(t, { saveKey: false });
  assert.notEqual(await serverRunWorkspace(unsaved.store, "run-1", { ...unsaved.options, sealKey: undefined, env: { ARCHIL_API_KEY: "archil-env-key-0002" } }), null, "no saved key and no seal key needed");
});
