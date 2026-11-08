// An agent's learning Workspace (workspace/learning-workspace.ts): its learning folder from paths.ts's one agent layout,
// on the local disk (Mode 1) or the Archil disk at learningKey (Mode 2). Learning's grade and merge run as one script
// through it: the script is written into .agentrun, listed, and run with exec at the folder's root, its exit code and
// its stdin passed through whole; the server reads the snapshot back with read and list. Mode 2's end() sweeps the
// learning folder's exec spill folder.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
const claimOf = (disk) => ({ disk, settings: { disk: disk.id, region: "aws-us-east-1", s3BaseUrl: "https://s3.green.us-east-1.aws.prod.archil.com" }, token: async () => "unused", secrets: new Set(), release() {} });

const BACKENDS = {
  local: async (log) => ({ learning: await learningWorkspace({ mode: 1, data: dataDir(), agentId: AGENT, log }) }),
  archil: async (log) => {
    const disk = new FakeArchilDisk();
    return { learning: await learningWorkspace({ mode: 2, archil: claimOf(disk), agentId: AGENT, log }), disk };
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
    const { learning, disk } = await open(() => {});
    const ws = learning.workspace;
    await ws.write(SCRIPT, SCRIPT_BODY);
    assert.ok((await ws.list(".agentrun")).some((entry) => entry.name === "learning-0123abcd.sh"), "the script is there before it runs");
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

test("learning workspace (archil): end() sweeps the learning folder's spill folder, once; a sweep that fails is logged, not thrown", async () => {
  const logged = [];
  const { learning, disk } = await BACKENDS.archil((message) => logged.push(message));
  await learning.workspace.write("notes.md", "kept");
  disk.files.set(`${SPILL}/killed.out`, Buffer.from("left"));
  disk.dirs.add(SPILL);
  await learning.end();
  assert.deepEqual([...disk.files.keys()].filter((key) => under(key, SPILL)), [], "swept");
  assert.equal(text(await learning.workspace.read("notes.md")), "kept", "the learning folder untouched");
  const calls = disk.calls.length;
  await learning.end();
  assert.equal(disk.calls.length, calls, "a second end() does nothing");

  const failing = await BACKENDS.archil((message) => logged.push(message));
  failing.disk.listPage = async () => { throw Object.assign(new Error("listing down"), { status: 503 }); };
  await failing.learning.end();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /learning folder's exec spill folder.*listing down/);
});

test("learning workspace (local): the folder is made where absent, from the agent's folder, and end() does nothing", async () => {
  const data = dataDir();
  const learning = await learningWorkspace({ mode: 1, data, agentId: AGENT, log: () => assert.fail("nothing to log") });
  assert.ok(existsSync(agentLearningFolder(data, AGENT)), "made");
  assert.equal(agentLearningFolder(data, AGENT), join(agentFolder(data, AGENT), "learning"), "one layout: the agent's folder, then learning");
  await learning.workspace.write("a.txt", "x");
  await learning.end();
  assert.ok(existsSync(join(agentLearningFolder(data, AGENT), "a.txt")));
});

test("learning workspace (local): a symbolic link on the way to the folder is refused, and nothing is made through it", async () => {
  const data = dataDir();
  const elsewhere = dataDir();
  mkdirSync(join(data, "disk", "agents"), { recursive: true });
  symlinkSync(elsewhere, agentFolder(data, AGENT));
  await assert.rejects(learningWorkspace({ mode: 1, data, agentId: AGENT, log: () => {} }), (error) => error instanceof WorkspaceError && error.code === "REFUSED" && /symbolic link/.test(error.message));
  assert.ok(!existsSync(join(elsewhere, "learning")), "nothing made where the link points");
});

test("learning workspace (archil): no claim is refused in words", async () => {
  await assert.rejects(learningWorkspace({ mode: 2, agentId: AGENT, log: () => {} }), /Archil claim/);
});
