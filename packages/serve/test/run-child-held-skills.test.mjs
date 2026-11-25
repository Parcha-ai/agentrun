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

test("a run with no skill of its own but a desktop computer (a general-expert on prod) lays its kind's skill on a disk an earlier run used", async (t) => {
  const disk = new FakeArchilDisk();
  // An earlier run of the same agent left its own folder, skills and all: the new run's folder is still fresh.
  disk.files.set(`${runKey(AGENT, "01a1d0b9-0000-7000-8000-000000000001")}/.agents/skills/old/SKILL.md`, new TextEncoder().encode("# Old\n"));
  const held = runOver(t, disk);
  const { workspace } = await held.archil();
  assert.deepEqual(await layOwnSkills(workspace, {}, { computer: "desktop" }), ["desktop-computer/SKILL.md"]);
  assert.ok(disk.files.has(`${ROOT}/.agents/skills/desktop-computer/SKILL.md`), "the kind's skill is in the new run's folder");
});

test("a second claim of the run lays nothing again, and keeps what the first laid", async (t) => {
  const disk = new FakeArchilDisk();
  const held = runOver(t, disk);
  const { workspace } = await held.archil();
  await layOwnSkills(workspace, { "cite/SKILL.md": "# Cite\n" });
  disk.files.set(`${ROOT}/.agents/skills/cite/SKILL.md`, new TextEncoder().encode("# Cite, edited by the run\n"));
  const puts = disk.calls.filter((call) => call.op === "putObject").length;
  await layOwnSkills(workspace, { "cite/SKILL.md": "# Cite\n" });
  assert.equal(disk.calls.filter((call) => call.op === "putObject").length, puts, "nothing was put");
  assert.equal(new TextDecoder().decode(disk.files.get(`${ROOT}/.agents/skills/cite/SKILL.md`)), "# Cite, edited by the run\n");
});

test("the lay reads no error's class: a Workspace whose errors lost it on the way (beta.50's channel) still lays a fresh folder's skills", async () => {
  const disk = new FakeArchilDisk();
  const { workspace: real } = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claimOf(disk), log: () => {} });
  // As beta.50's channel gave them: a plain Error named WorkspaceError, its code an own field.
  const classless = (error) => Object.assign(new Error(error.message), { name: error.name, code: error.code, path: error.path });
  const workspace = new Proxy(real, {
    get(target, key) {
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? (...args) => member.apply(target, args).catch((error) => Promise.reject(classless(error))) : member;
    },
  });
  await layOwnSkills(workspace, { "cite/SKILL.md": "# Cite\n" });
  assert.equal(new TextDecoder().decode(disk.files.get(`${ROOT}/.agents/skills/cite/SKILL.md`)), "# Cite\n");
});

test("a lay that fails says it was the lay of the run's skills, with the path, the disk's key and Archil's words", async (t) => {
  const disk = new FakeArchilDisk();
  const held = runOver(t, disk);
  const { workspace } = await held.archil();
  // The listing of .agents/skills/ names its disk key and the disk when nothing is there.
  await assert.rejects(workspace.list(".agents/skills"), (error) => {
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(error.message, `".agents/skills" is not there (list; Archil: nothing under ${ROOT}/.agents/skills/ on disk ${disk.id})`);
    return true;
  });
  const putObject = disk.putObject.bind(disk);
  disk.putObject = async (key, body) => {
    if (key.startsWith(`${ROOT}/.agents/skills/`)) throw Object.assign(new Error("503 SlowDown: try again"), { status: 503 });
    return putObject(key, body);
  };
  await assert.rejects(layOwnSkills(workspace, { "cite/SKILL.md": "# Cite\n" }), (error) => {
    assert.ok(error instanceof WorkspaceError, `a ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, "UNAVAILABLE");
    assert.match(error.message, /^laying the run's skills in \.agents\/skills\/: mkdir "\.agents\/skills": 503 SlowDown: try again$/);
    return true;
  });
});
