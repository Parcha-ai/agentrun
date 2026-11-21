// A revision's skills laid by a run's own process (run-child.ts) on its Mode 2 folder, through the Workspace its runner
// holds and hands over the run's channel (run-child-host.ts `held.archil`): a Workspace's error crosses the channel as a
// WorkspaceError with its code, so layOwnSkills reads a fresh folder's missing .agents/skills/ as NOT_FOUND and lays
// every file. Both sides register the run's errors as run-child.ts and run-child-host.ts do. No key, no network: a fake
// Archil disk.
import assert from "node:assert/strict";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { Channel } from "../dist/runner/run-channel.js";
import { registerRunErrors } from "../dist/runner/run-errors.js";
import { layOwnSkills, openRunWorkspace, runKey, WorkspaceError } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const AGENT = "acme";
const RUN = "01a1d0b9-3e8b-7352-9497-a407e2909f53";
const ROOT = runKey(AGENT, RUN);

/** A claim as archilClaim gives it, over a fake disk. */
const claimOf = (disk) => ({ disk, region: "aws-us-east-1", image: undefined, token: async () => "unused", secrets: new Set(), release() {} });

/** A runner and a run's process over one channel: the runner's `held.archil` opens the run's Mode 2 folder on `disk`. */
function runOver(t, disk) {
  registerRunErrors();
  const [a, b] = duplexPair();
  const runner = new Channel(a);
  const child = new Channel(b);
  t.after(() => {
    child.close();
    runner.close();
  });
  const held = {
    archil: async () => {
      const ws = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claimOf(disk), log: () => {} });
      return { workspace: ws.workspace, revoke: async () => {}, inherit: async () => {}, release: async () => {} };
    },
  };
  runner.expose("held", (method, args) => held[method](...args));
  return child.remote("held");
}

test("a Workspace's error reaches a run's process as a WorkspaceError, its code kept", async (t) => {
  const held = runOver(t, new FakeArchilDisk());
  const { workspace } = await held.archil();
  await assert.rejects(workspace.list(".agents/skills"), (error) => {
    assert.ok(error instanceof WorkspaceError, `a ${error?.constructor?.name} named ${error?.name}: ${error?.message}`);
    assert.equal(error.code, "NOT_FOUND");
    return true;
  });
});

test("a run's process lays its revision's skills on a fresh Mode 2 folder through the runner's Workspace", async (t) => {
  const disk = new FakeArchilDisk();
  const held = runOver(t, disk);
  const { workspace } = await held.archil();
  await layOwnSkills(workspace, { "cite/SKILL.md": "# Cite\n", "cite/reference/sources.md": "Primary first.\n" });
  const text = (key) => new TextDecoder().decode(disk.files.get(`${ROOT}/${key}`));
  assert.equal(text(".agents/skills/cite/SKILL.md"), "# Cite\n");
  assert.equal(text(".agents/skills/cite/reference/sources.md"), "Primary first.\n");
});
