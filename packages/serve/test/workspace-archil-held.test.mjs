// A folder another client holds (a computer's mount of it takes Archil's write delegation; an exec checks it out) past
// the workspace's wait: the failure says so, in its message and in the path-free words a tool's answer carries, and not
// that the disk is full or read-only.

import assert from "node:assert/strict";
import { test } from "node:test";
import { archilWorkspace, workspaceErrorWords } from "../dist/workspace/index.js";
import { APPEND_MAX } from "../dist/workspace/archil.js";
import { webSave } from "../dist/web-save.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const ROOT = "agents/acme-0123456789abcdef/runs/r1/work";
const QUEUE_MS = 150;
const HELD = /held by another client \(a computer's mount of it, or a command running in it\)/;

/** A workspace over a disk whose run folder a computer's mount holds, the file "a.txt" written before it took hold. */
async function held() {
  const disk = new FakeArchilDisk();
  const workspace = archilWorkspace(disk, ROOT, { queueMs: QUEUE_MS });
  await workspace.write("a.txt", "before");
  await workspace.mkdir("kept");
  const release = disk.delegate(ROOT);
  return { disk, workspace, release };
}

const rejectsHeld = async (call, what) => {
  const started = Date.now();
  const error = await call().then(() => assert.fail(`${what} landed through the hold`), (e) => e);
  assert.equal(error.name, "WorkspaceError", `${what}: ${error}`);
  assert.equal(error.code, "UNAVAILABLE", `${what}: ${error.message}`);
  assert.ok(Date.now() - started >= QUEUE_MS, `${what} waited the queue out first`);
  assert.match(error.message, HELD, what);
  assert.match(error.message, /OperationAborted/, `${what} keeps Archil's own words in the message`);
  const words = workspaceErrorWords(error);
  assert.match(words, /^UNAVAILABLE: /, what);
  assert.match(words, HELD, what);
  assert.match(words, /409 OperationAborted/, `${what}'s words carry Archil's code`);
  assert.doesNotMatch(words, /full or read-only/, what);
  assert.doesNotMatch(words, /acme|agents\/|a\.txt|b\.txt|kept/, `${what}'s words name no path`);
  return error;
};

test("a write, an append, a mkdir and a remove past the wait for a held folder fail UNAVAILABLE in the hold's words", async () => {
  const { workspace } = await held();
  await rejectsHeld(() => workspace.write("b.txt", "x"), "write");
  await rejectsHeld(() => workspace.append("a.txt", "more"), "append");
  await rejectsHeld(() => workspace.mkdir("new"), "mkdir");
  await rejectsHeld(() => workspace.remove("a.txt"), "remove");
});

test("a multi-chunk append that meets a hold keeps the hold's words beside what landed", async () => {
  const { workspace } = await held();
  const error = await rejectsHeld(() => workspace.append("a.txt", "x".repeat(APPEND_MAX + 1)), "append");
  assert.equal(error.path, "a.txt");
});

test("once the hold is let go within the wait, the write lands", async () => {
  const { workspace, release } = await held();
  setTimeout(release, 50);
  await workspace.write("b.txt", "after");
  assert.equal(new TextDecoder().decode(await workspace.read("b.txt")), "after");
});

test("web_save into a held folder answers the hold's words, not a full or read-only disk", async () => {
  const { workspace } = await held();
  const net = {
    lookup: async () => ["93.184.216.34"],
    fetchImpl: async () => new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv" } }),
  };
  const saved = await webSave({ url: "https://cdn.example/t.csv", path: "t.csv" }, workspace, net);
  assert.equal(saved.ok, false, JSON.stringify(saved));
  assert.match(saved.error, /^UNAVAILABLE: /, saved.error);
  assert.match(saved.error, HELD, saved.error);
  assert.doesNotMatch(saved.error, /full or read-only/, saved.error);
});
