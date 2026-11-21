// An agent's learning Workspace (workspace/learning-workspace.ts), the one learningWorkspace: its learning folder from
// paths.ts's one agent layout under the server's data directory, in either mode (never on an Archil disk). It is given
// synchronously; the folder is made by the first write, level by level, and a read makes nothing (a folder not made yet
// is NOT_FOUND: no main yet). Learning's grade and merge run as one script through it: written into .agentrun, checked
// with stat, run with exec at the folder's root, its exit code and stdin passed through whole; the server reads the
// snapshot back with read and list.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { agentFolder, agentLearningFolder, learningWorkspace, WorkspaceError } from "../dist/workspace/index.js";

const AGENT = "acme";
const ENV = { PATH: "/usr/bin:/bin" };
const SCRIPT = ".agentrun/learning-0123abcd.sh";
const text = (bytes) => Buffer.from(bytes).toString("utf8");

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const dataDir = () => {
  const data = mkdtempSync(join(tmpdir(), "learning-ws-"));
  roots.push(data);
  return data;
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

test("learning workspace: a script written into .agentrun runs at the folder's root, its exit 3 comes back as 3, and 2 MB of stdin arrives byte for byte", async () => {
  const ws = learningWorkspace({ data: dataDir(), agentId: AGENT }).workspace;
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
});

test("learning workspace: a read makes nothing, and a folder not made yet is NOT_FOUND; the first write makes it from the agent's folder", async () => {
  const data = dataDir();
  const { workspace, end } = learningWorkspace({ data, agentId: AGENT });
  for (const read of [() => workspace.read(".agentrun/snapshot.json"), () => workspace.list(""), () => workspace.stat(".agentrun/snapshot.json"), () => workspace.grep("x")]) {
    await assert.rejects(read(), (error) => error instanceof WorkspaceError && error.code === "NOT_FOUND" && /the learning folder is not made yet/.test(error.message));
  }
  assert.ok(!existsSync(join(data, "disk")), "no read made a level");
  await workspace.write(".agentrun/x.txt", "x");
  assert.ok(existsSync(join(agentLearningFolder(data, AGENT), ".agentrun", "x.txt")), "the write made it");
  assert.equal(agentLearningFolder(data, AGENT), join(agentFolder(data, AGENT), "learning"), "one layout: the agent's folder, then learning");
  assert.equal(text(await workspace.read(".agentrun/x.txt")), "x", "a read after it reads");
  await end();
  assert.ok(existsSync(join(agentLearningFolder(data, AGENT), ".agentrun", "x.txt")), "end() leaves the folder as it is");
});

test("learning workspace: a symbolic link on the way, or at .git, is refused as ESCAPE naming it, and nothing is made through it", async () => {
  const data = dataDir();
  const elsewhere = dataDir();
  mkdirSync(join(data, "disk", "agents"), { recursive: true });
  symlinkSync(elsewhere, agentFolder(data, AGENT));
  const { workspace } = learningWorkspace({ data, agentId: AGENT });
  for (const call of [() => workspace.write("a.txt", "x"), () => workspace.read("a.txt")]) {
    await assert.rejects(call(), (error) => error instanceof WorkspaceError && error.code === "ESCAPE" && /symbolic link/.test(error.message));
  }
  assert.ok(!existsSync(join(elsewhere, "learning")), "nothing made where the link points");

  const data2 = dataDir();
  mkdirSync(agentLearningFolder(data2, AGENT), { recursive: true });
  symlinkSync(elsewhere, join(agentLearningFolder(data2, AGENT), ".git"));
  await assert.rejects(learningWorkspace({ data: data2, agentId: AGENT }).workspace.write("a.txt", "x"), (error) => error instanceof WorkspaceError && error.code === "ESCAPE" && /\.git/.test(error.message));

  const data3 = dataDir();
  mkdirSync(join(data3, "disk", "agents"), { recursive: true });
  writeFileSync(agentFolder(data3, AGENT), "not a folder");
  await assert.rejects(learningWorkspace({ data: data3, agentId: AGENT }).workspace.write("a.txt", "x"), (error) => error instanceof WorkspaceError && error.code === "UNAVAILABLE" && /not a folder/.test(error.message));
});
