// A run's Workspace for the runner's claim (workspace/run-workspace.ts): Mode 2 opens the run's folder on the claim's
// Archil disk and sweeps its exec spill folder when the run starts and when it ends; what a cleanup leaves, or a sweep
// that fails, goes to the run's log and never fails the run. Mode 1 opens the run's local folder and its end does nothing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openRunWorkspace, runFolder, runKey } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const AGENT = "acme";
const RUN = "r1";
const WORK = runKey(AGENT, RUN);
const OUT = `${WORK.slice(0, -"/work".length)}/exec-out`;
const ENV = { PATH: "/usr/bin:/bin" };
const under = (key, folder) => key === folder || key.startsWith(`${folder}/`);
const text = (bytes) => Buffer.from(bytes).toString("utf8");

/** A claim as archilClaim gives it, over a fake disk: no key, no call leaves the process. */
const claimOf = (disk) => ({ disk, region: "aws-us-east-1", image: undefined, token: async () => "unused", secrets: new Set(), release() {} });

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test("run workspace (Mode 2): opening sweeps what a killed exec left in the spill folder, and leaves the run's folder alone", async () => {
  const disk = new FakeArchilDisk();
  disk.files.set(`${WORK}/notes.md`, Buffer.from("kept"));
  disk.files.set(`${OUT}/old.out`, Buffer.from("left"));
  disk.files.set(`${OUT}/old.err`, Buffer.from("left"));
  disk.dirs.add(OUT);
  const logged = [];
  const run = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claimOf(disk), log: (message) => logged.push(message) });
  assert.deepEqual([...disk.files.keys()].filter((key) => under(key, OUT)), [], "the leftovers are gone");
  assert.equal(text(await run.workspace.read("notes.md")), "kept", "the workspace is the run's folder, untouched");
  assert.deepEqual(logged, []);
});

test("run workspace (Mode 2): end() sweeps the spill folder, once", async () => {
  const disk = new FakeArchilDisk();
  const run = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claimOf(disk), log: () => {} });
  await run.workspace.exec(["bash", "-c", "echo hi; mkdir -p /mnt/archil/out/d"], { env: ENV, timeoutMs: 10_000 });
  disk.files.set(`${OUT}/killed.out`, Buffer.from("left"));
  await run.end();
  assert.deepEqual([...disk.files.keys(), ...disk.dirs].filter((key) => under(key, OUT) && key !== OUT), [], "files and folders swept");
  const calls = disk.calls.length;
  await run.end();
  assert.equal(disk.calls.length, calls, "a second end() does nothing");
});

test("run workspace (Mode 2): a cleanup that leaves files goes to the run's log once, and the exec's result stands", async () => {
  const disk = new FakeArchilDisk();
  const logged = [];
  const run = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claimOf(disk), log: (message) => logged.push(message) });
  const deleteObjects = disk.deleteObjects.bind(disk);
  disk.deleteObjects = async (keys) => keys.map((key) => ({ key, code: "InternalError", message: "try later" }));
  const ran = await run.workspace.exec(["bash", "-c", "echo fine"], { env: ENV, timeoutMs: 10_000 });
  assert.equal(text(ran.stdout), "fine\n");
  assert.equal(logged.length, 1, "reported once");
  assert.match(logged[0], /stayed after its cleanup/);
  disk.deleteObjects = deleteObjects;
  await run.end();
  assert.deepEqual([...disk.files.keys()].filter((key) => under(key, OUT)), [], "the end's sweep took them");
});

test("run workspace (Mode 2): a sweep that fails is logged, never thrown, at the start and at the end", async () => {
  const disk = new FakeArchilDisk();
  const logged = [];
  const listPage = disk.listPage.bind(disk);
  disk.listPage = async (prefix, options) => {
    if (under(prefix.replace(/\/$/, ""), OUT)) throw Object.assign(new Error("listing down"), { status: 503 });
    return listPage(prefix, options);
  };
  const run = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claimOf(disk), log: (message) => logged.push(message) });
  await run.end();
  assert.equal(logged.length, 2, "one line at the start, one at the end");
  for (const line of logged) assert.match(line, /exec spill folder.*listing down/);
});

test("run workspace (Mode 2): the image and the mount's region come from the claim", async () => {
  const disk = new FakeArchilDisk();
  const image = { baseImage: `docker.io/library/debian@sha256:${"9e".repeat(32)}` };
  const claim = { ...claimOf(disk), image };
  const run = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claim, log: () => {} });
  await run.workspace.exec(["true"], { env: ENV, timeoutMs: 10_000 });
  assert.deepEqual(disk.calls.filter((call) => call.op === "exec").map((call) => call.image), [image]);
});

test("run workspace (Mode 2): no claim is refused in words", async () => {
  await assert.rejects(openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, log: () => {} }), /Archil claim/);
});

test("run workspace (Mode 1): the run's local folder, and end() does nothing", async () => {
  const data = mkdtempSync(join(tmpdir(), "run-ws-"));
  roots.push(data);
  const folder = runFolder(data, AGENT, RUN);
  mkdirSync(join(folder, ".agentrun", "output"), { recursive: true });
  writeFileSync(join(folder, ".agentrun", "output", "x"), "kept");
  const logged = [];
  const run = await openRunWorkspace({ mode: 1, data, agentId: AGENT, runId: RUN, log: (message) => logged.push(message) });
  await run.workspace.write("a.txt", "hello");
  assert.ok(existsSync(join(folder, "a.txt")), "the workspace is the run's folder");
  await run.end();
  assert.ok(existsSync(join(folder, ".agentrun", "output", "x")), "Mode 1's end leaves the folder as it is");
  assert.deepEqual(logged, []);
});
