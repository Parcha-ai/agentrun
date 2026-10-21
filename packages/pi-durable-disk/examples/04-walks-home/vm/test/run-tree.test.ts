// What a stop does to the run's tree on the disk: delete it (the default), or with keep leave it and still release what holds it, so a trained run survives the stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseRun } from "../run-tree.ts";

const delegations = [{ clientId: "c1", inodeId: 11 }, { clientId: "c2", inodeId: 12 }];

test("keep: every delegation on the run is revoked and the tree is not deleted", async () => {
  const revoked: unknown[] = [];
  let deleted = false;
  const disk = { revokeDelegation: async (d: unknown) => void revoked.push(d) };
  const out = await releaseRun(disk as never, "run-a", { keep: true }, { findDelegations: async () => delegations as never, deleteRunTree: async () => ((deleted = true), { objects: 3, revoked: 0 }) });
  assert.deepEqual(revoked, delegations);
  assert.equal(deleted, false);
  assert.deepEqual(out, { id: "run-a", delegationsHeld: 2, kept: true, revoked: 2 });
});

test("keep: a delegation that will not revoke is counted as not revoked, and the others still are", async () => {
  const seen: unknown[] = [];
  const disk = { revokeDelegation: async (d: { clientId: string }) => { seen.push(d); if (d.clientId === "c1") throw new Error("busy"); } };
  const out = await releaseRun(disk as never, "run-a", { keep: true }, { findDelegations: async () => delegations as never, deleteRunTree: async () => ({ objects: 0, revoked: 0 }) });
  assert.equal(seen.length, 2);
  assert.deepEqual({ revoked: out.revoked, held: out.delegationsHeld }, { revoked: 1, held: 2 });
});

test("the default deletes the tree through the package's deleteRunTree and keeps nothing", async () => {
  const out = await releaseRun({} as never, "run-b", { keep: false }, { findDelegations: async () => delegations as never, deleteRunTree: async () => ({ objects: 7, revoked: 2 }) });
  assert.deepEqual(out, { id: "run-b", delegationsHeld: 2, tree: { objects: 7, revoked: 2 } });
});
