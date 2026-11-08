// An agent's learning Workspace (workspace/learning-workspace.ts), the one learningWorkspace: its learning folder from
// paths.ts's one agent layout, on the local disk ({ mode: "local", data }) or the Archil disk at learningKey
// ({ mode: "archil", archil }). It is given synchronously; the local folder is made by the first write, level by level,
// and a read makes nothing (a folder not made yet is NOT_FOUND: no main yet). Learning's grade and merge run as one
// script through it: written into .agentrun, checked with stat, run with exec at the folder's root, its exit code and
// stdin passed through whole; the server reads the snapshot back with read and list. The Archil end() sweeps the
// learning folder's exec spill folder.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentFolder, agentLearningFolder, learningKey, learningWorkspace, WorkspaceError } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const AGENT = "acme";
const ENV = { PATH: "/usr/bin:/bin" };
const SCRIPT = ".agentrun/learning-0123abcd.sh";
const SPILL = `${learningKey(AGENT)}.exec-out`;
const under = (key, folder) => key === folder || key.startsWith(`${folder}/`);
const text = (bytes) => Buffer.from(bytes).toString("utf8");

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const dataDir = () => {
  const data = mkdtempSync(join(tmpdir(), "learning-ws-"));
  roots.push(data);
  return data;
};
/** A claim as archilClaim gives it, over a fake disk. */
const claimOf = (disk) => ({ disk, region: "aws-us-east-1", image: undefined, token: async () => "unused", secrets: new Set(), release() {} });

const BACKENDS = {
  local: (log) => ({ learning: learningWorkspace({ mode: "local", data: dataDir(), agentId: AGENT, log }) }),
  archil: (log) => {
    const disk = new FakeArchilDisk();
    return { learning: learningWorkspace({ mode: "archil", archil: claimOf(disk), agentId: AGENT, log }), disk };
  },
};

// The shape learning's script takes: an op and the main it expects, a fast-import stream on stdin, exit 3 for stale.
const SCRIPT_BODY = [
  "#!/bin/sh",
  "op=$1",
  "old=$2",
  "cat > got.bin",
  "printf '%s %s %s\\n' \"$op\" \"$old\" \"$(wc -c < got.bin | tr -d ' ')\" > seen.txt",
  "exit 3",
  "",
].join("\n");

for (const [name, open] of Object.entries(BACKENDS)) {
  test(`learning workspace (${name}): a script written into .agentrun runs at the folder's root, its exit 3 comes back as 3, and 2 MB of stdin arrives byte for byte`, async () => {
    const { learning, disk } = open(() => {});
    const ws = learning.workspace;
    await ws.write(SCRIPT, SCRIPT_BODY);
    assert.equal((await ws.stat(SCRIPT))?.kind, "file", "the script is there before it runs");
    const stdin = randomBytes(2 * 1024 * 1024);
    const ran = await ws.exec(["sh", SCRIPT, "merge", "abc1234"], { env: ENV, stdin, timeoutMs: 60_000 });
    // No signal ended it: the port says so as an absent or null signal.
    assert.deepEqual([ran.code, ran.timedOut, ran.signal ?? null], [3, false, null]);
    assert.ok(Buffer.from(await ws.read("got.bin")).equals(stdin), "stdin arrived whole");
    assert.equal(text(await ws.read("seen.txt")), `merge abc1234 ${stdin.length}\n`);
    // The server's snapshot reads: read and list, no exec.
    const names = (await ws.list("")).map((entry) => entry.name).sort();
    assert.ok(names.includes("seen.txt") && names.includes(".agentrun"), JSON.stringify(names));
    if (disk) {
      const keys = disk.calls.flatMap((call) => [call.key, call.prefix, call.directory, ...Object.values(call.mounts ?? {})]).filter((key) => typeof key === "string");
      assert.ok(keys.length > 0);
      for (const key of keys) assert.ok(under(key.replace(/\/$/, ""), learningKey(AGENT)) || under(key.replace(/\/$/, ""), SPILL), `${key} is the learning folder or its spill folder`);
    }
  });
}

test("learning workspace (local): a read makes nothing, and a folder not made yet is NOT_FOUND; the first write makes it from the agent's folder", async () => {
  const data = dataDir();
  const { workspace, end } = learningWorkspace({ mode: "local", data, agentId: AGENT });
  for (const read of [() => workspace.read(".agentrun/snapshot.json"), () => workspace.list(""), () => workspace.stat(".agentrun/snapshot.json"), () => workspace.grep("x")]) {
    await assert.rejects(read(), (error) => error instanceof WorkspaceError && error.code === "NOT_FOUND" && /the learning folder is not made yet/.test(error.message));
  }
  assert.ok(!existsSync(join(data, "disk")), "no read made a level");
  await workspace.write(".agentrun/x.txt", "x");
  assert.ok(existsSync(join(agentLearningFolder(data, AGENT), ".agentrun", "x.txt")), "the write made it");
  assert.equal(agentLearningFolder(data, AGENT), join(agentFolder(data, AGENT), "learning"), "one layout: the agent's folder, then learning");
  assert.equal(text(await workspace.read(".agentrun/x.txt")), "x", "a read after it reads");
  await end();
  assert.ok(existsSync(join(agentLearningFolder(data, AGENT), ".agentrun", "x.txt")), "the local end() leaves the folder as it is");
});

test("learning workspace (local): a symbolic link on the way, or at .git, is refused as ESCAPE naming it, and nothing is made through it", async () => {
  const data = dataDir();
  const elsewhere = dataDir();
  mkdirSync(join(data, "disk", "agents"), { recursive: true });
  symlinkSync(elsewhere, agentFolder(data, AGENT));
  const { workspace } = learningWorkspace({ mode: "local", data, agentId: AGENT });
  for (const call of [() => workspace.write("a.txt", "x"), () => workspace.read("a.txt")]) {
    await assert.rejects(call(), (error) => error instanceof WorkspaceError && error.code === "ESCAPE" && /symbolic link/.test(error.message));
  }
  assert.ok(!existsSync(join(elsewhere, "learning")), "nothing made where the link points");

  const data2 = dataDir();
  mkdirSync(agentLearningFolder(data2, AGENT), { recursive: true });
  symlinkSync(elsewhere, join(agentLearningFolder(data2, AGENT), ".git"));
  await assert.rejects(learningWorkspace({ mode: "local", data: data2, agentId: AGENT }).workspace.write("a.txt", "x"), (error) => error instanceof WorkspaceError && error.code === "ESCAPE" && /\.git/.test(error.message));

  const data3 = dataDir();
  mkdirSync(join(data3, "disk", "agents"), { recursive: true });
  writeFileSync(agentFolder(data3, AGENT), "not a folder");
  await assert.rejects(learningWorkspace({ mode: "local", data: data3, agentId: AGENT }).workspace.write("a.txt", "x"), (error) => error instanceof WorkspaceError && error.code === "UNAVAILABLE" && /not a folder/.test(error.message));
});

test("learning workspace (archil): end() sweeps the learning folder's spill folder, once; a sweep that fails is logged, not thrown", async () => {
  const logged = [];
  const { learning, disk } = BACKENDS.archil((message) => logged.push(message));
  await learning.workspace.write("notes.md", "kept");
  disk.files.set(`${SPILL}/killed.out`, Buffer.from("left"));
  disk.dirs.add(SPILL);
  await learning.end();
  assert.deepEqual([...disk.files.keys()].filter((key) => under(key, SPILL)), [], "swept");
  assert.equal(text(await learning.workspace.read("notes.md")), "kept", "the learning folder untouched");
  const calls = disk.calls.length;
  await learning.end();
  assert.equal(disk.calls.length, calls, "a second end() does nothing");

  const failing = BACKENDS.archil((message) => logged.push(message));
  failing.disk.listPage = async () => { throw Object.assign(new Error("listing down"), { status: 503 }); };
  await failing.learning.end();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /learning folder's exec spill folder.*listing down/);
});

test("learning workspace (archil): no claim is refused in words", () => {
  assert.throws(() => learningWorkspace({ mode: "archil", agentId: AGENT }), /Archil claim/);
});
