// An Archil Workspace in a computer: mountSpec() names exactly the disk, region and run folder (runKey) that the
// computer module's read-back gives back for it, held exclusively under the claim's epoch, so the two compare equal.
// attach() goes through the shared attach path (attach.ts checkReadBack and attachedWorkspace) with the check the claim
// builds, { readBackOf, epoch: claim.epoch }: only that exact read-back is taken, held exclusively and under the claim's
// own epoch. The disk token is never asked for by attach and never in an error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { archilWorkspace, learningKey, openRunWorkspace, runKey, WorkspaceError } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { readBackOf } from "./fixtures/archil-readback.mjs";

const AGENT = "acme";
const RUN = "r1";
const REGION = "aws-us-east-1";
const TOKEN = "fake-test-key-disk-token-0001";
const EPOCH = 7;
/** The check the claim builds: the computer module's read-back, and the claim's epoch. */
const CHECK = { readBackOf, epoch: EPOCH };

const mounted = (disk, extra = {}) => {
  let asked = 0;
  const workspace = archilWorkspace(disk, runKey(AGENT, RUN), { region: REGION, mountToken: async () => { asked++; return TOKEN; }, ...extra });
  return { workspace, asked: () => asked };
};

/** A computer whose read-back is `back` (the computer module's answer for what it mounts at /workspace). */
const computerWith = (back) => {
  const methods = [];
  return {
    id: "computer-1",
    client: { call: async (method) => { methods.push(method); return { ok: false, error: { message: "not used" } }; } },
    readBack: async () => { methods.push("readBack"); return { ok: true, value: back }; },
    methods,
  };
};

test("archil mountSpec: the disk's id, its region, the run's folder as runKey, and the token from its function, asked once", async () => {
  const disk = new FakeArchilDisk();
  const { workspace, asked } = mounted(disk);
  assert.deepEqual(await workspace.mountSpec(), { kind: "archil", disk: disk.id, region: REGION, folder: runKey(AGENT, RUN), token: TOKEN });
  assert.equal(asked(), 1);
});

test("archil mountSpec: the computer module's read-back of it is exactly { disk, region, folder: runKey, exclusive, epoch }", async () => {
  const disk = new FakeArchilDisk();
  const { workspace } = mounted(disk);
  assert.deepEqual(readBackOf(await workspace.mountSpec(), EPOCH), { kind: "archil", disk: disk.id, region: REGION, folder: runKey(AGENT, RUN), exclusive: true, epoch: EPOCH });
});

test("archil mountSpec: with no epoch (or one that is not an epoch) the computer module reads it back as { other }, and attach refuses it", async () => {
  const disk = new FakeArchilDisk();
  const { workspace } = mounted(disk);
  const spec = await workspace.mountSpec();
  for (const epoch of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const back = readBackOf(spec, epoch);
    assert.deepEqual(Object.keys(back), ["other"], String(epoch));
    assert.match(back.other, new RegExp(`^an Archil mount of ${disk.id}:/${runKey(AGENT, RUN)} with no epoch to read it back under \\(an epoch must be a whole number`));
    assert.ok(!back.other.includes(TOKEN));
  }
  const exact = { kind: "archil", disk: disk.id, region: REGION, folder: runKey(AGENT, RUN), exclusive: true, epoch: EPOCH };
  await assert.rejects(workspace.attach(computerWith(exact), { readBackOf }), (error) => error instanceof WorkspaceError && error.code === "REFUSED" && !error.message.includes(TOKEN));
});

test("archil attach: through the shared path, the exact read-back is accepted without asking for the token", async () => {
  const disk = new FakeArchilDisk();
  const { workspace, asked } = mounted(disk);
  const computer = computerWith({ kind: "archil", disk: disk.id, region: REGION, folder: runKey(AGENT, RUN), exclusive: true, epoch: EPOCH });
  const attached = await workspace.attach(computer, CHECK);
  assert.equal(typeof attached.read, "function");
  assert.deepEqual(computer.methods, ["readBack"], "only the read-back was asked for");
  assert.equal(asked(), 0, "attach needs no token: the read-back never holds one");
});

test("archil attach: a read-back of another folder, region or disk, or a mount it never makes, is refused without the token", async () => {
  const disk = new FakeArchilDisk();
  const { workspace } = mounted(disk);
  const exact = { kind: "archil", disk: disk.id, region: REGION, folder: runKey(AGENT, RUN), exclusive: true, epoch: EPOCH };
  const cases = [
    { ...exact, folder: `/${runKey(AGENT, RUN)}` },
    { ...exact, folder: learningKey(AGENT) },
    { ...exact, folder: runKey(AGENT, "r2") },
    { ...exact, region: "aws-us-west-2" },
    { ...exact, disk: "dsk-0000000000000002" },
    { other: "a mount the computer module never makes" },
  ];
  for (const back of cases) {
    await assert.rejects(
      workspace.attach(computerWith(back), CHECK),
      (error) => error instanceof WorkspaceError && error.code === "REFUSED" && !error.message.includes(TOKEN),
      JSON.stringify(back),
    );
  }
});

test("archil attach: a read-back not held exclusively, under any other epoch than the claim's, or with no hold or epoch, is refused in words without the token", async () => {
  const disk = new FakeArchilDisk();
  const { workspace } = mounted(disk);
  const exact = { kind: "archil", disk: disk.id, region: REGION, folder: runKey(AGENT, RUN), exclusive: true, epoch: EPOCH };
  const { exclusive: _exclusive, epoch: _epoch, ...bare } = exact;
  const cases = [
    [{ ...exact, exclusive: false }, /not exclusive/],
    [{ ...exact, epoch: EPOCH - 1 }, new RegExp(`under epoch ${EPOCH - 1}`)],
    [{ ...exact, epoch: EPOCH + 1 }, new RegExp(`under epoch ${EPOCH + 1}`)],
    [bare, new RegExp(`not ${disk.id}:/${runKey(AGENT, RUN)} in ${REGION}, exclusive under epoch ${EPOCH}`)],
  ];
  for (const [back, words] of cases) {
    await assert.rejects(
      workspace.attach(computerWith(back), CHECK),
      (error) => error instanceof WorkspaceError && error.code === "REFUSED" && words.test(error.message) && !error.message.includes(TOKEN),
      JSON.stringify(back),
    );
  }
});

test("archil mountSpec and attach: a workspace made without a region or a token function is refused in words", async () => {
  const disk = new FakeArchilDisk();
  for (const options of [{}, { region: REGION }, { mountToken: async () => TOKEN }]) {
    const workspace = archilWorkspace(disk, runKey(AGENT, RUN), options);
    await assert.rejects(workspace.mountSpec(), (error) => error instanceof WorkspaceError && error.code === "REFUSED" && /region and its disk token/.test(error.message));
    await assert.rejects(workspace.attach(computerWith({ other: "x" }), CHECK), (error) => error instanceof WorkspaceError && error.code === "REFUSED");
  }
});

test("archil mountSpec through the run's Workspace: the region from the claim and the run's minted mount credential; none kept, none minted, no mount", async () => {
  const disk = new FakeArchilDisk();
  const claim = { disk, region: REGION, image: undefined, secrets: new Set(), release() {} };
  const run = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claim, mountToken: async () => TOKEN, log: () => {} });
  assert.deepEqual(await run.workspace.mountSpec(), { kind: "archil", disk: disk.id, region: REGION, folder: runKey(AGENT, RUN), token: TOKEN });
  const unminted = await openRunWorkspace({ mode: 2, agentId: AGENT, runId: RUN, archil: claim, log: () => {} });
  await assert.rejects(unminted.workspace.mountSpec(), (error) => error instanceof WorkspaceError && error.code === "REFUSED");
});
