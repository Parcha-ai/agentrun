// openedAtUse: a run's Workspace opened at its first use, once, and let go at its release, with an open held by hand so a
// use, the release and the open's end can be put in any order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openedAtUse } from "../dist/workspace/run-workspace.js";

/** An open you resolve or fail by hand, counting how often it was asked and how often what it opened was ended. */
function heldOpen() {
  const seen = { opens: 0, ends: 0, writes: [] };
  const pending = [];
  const open = () => {
    seen.opens += 1;
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  const workspace = { write: async (path) => void seen.writes.push(path) };
  const resolveNext = () => pending.shift().resolve({ workspace, end: async () => void (seen.ends += 1) });
  const failNext = () => pending.shift().reject(new Error("the open failed"));
  return { seen, open, resolveNext, failNext };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("openedAtUse: a use whose open is still running at the release gets nothing to write to, and what it opened is ended once", async () => {
  const held = heldOpen();
  const run = openedAtUse(held.open);
  const use = run.workspace().then((ws) => ws.write("evidence/mcp/fal/a.txt"));
  await tick();
  const released = run.end();
  held.resolveNext();
  await released;
  await assert.rejects(use, { name: "WorkspaceError", code: "UNAVAILABLE" });
  assert.equal(held.seen.ends, 1, "ended once, at the release");
  assert.deepEqual(held.seen.writes, [], "the use writes nothing");
});

test("openedAtUse: a use after the release opens nothing and is refused", async () => {
  const held = heldOpen();
  const run = openedAtUse(held.open);
  await run.end();
  const use = run.workspace();
  assert.equal(held.seen.opens, 0, "nothing opened after the release");
  await assert.rejects(use, { name: "WorkspaceError", code: "UNAVAILABLE" });
});

test("openedAtUse: a use after the release of an opened Workspace is refused, and the Workspace is not ended again", async () => {
  const held = heldOpen();
  const run = openedAtUse(held.open);
  const first = run.workspace();
  held.resolveNext();
  await first;
  await run.end();
  await run.end();
  await assert.rejects(run.workspace(), { name: "WorkspaceError", code: "UNAVAILABLE" });
  assert.equal(held.seen.opens, 1);
  assert.equal(held.seen.ends, 1, "two releases end it once");
});

test("openedAtUse: nothing is opened before the first use, then once for every use; a release with no open ends nothing", async () => {
  const held = heldOpen();
  const run = openedAtUse(held.open);
  assert.equal(held.seen.opens, 0);
  const uses = [run.workspace(), run.workspace()];
  held.resolveNext();
  const [a, b] = await Promise.all(uses);
  assert.equal(a, b);
  assert.equal(await run.workspace(), a);
  assert.equal(held.seen.opens, 1, "one open for three uses");
  const idle = heldOpen();
  await openedAtUse(idle.open).end();
  assert.deepEqual([idle.seen.opens, idle.seen.ends], [0, 0]);
});

test("openedAtUse: an open that failed fails its uses, is tried again at the next use, and leaves nothing to end", async () => {
  const held = heldOpen();
  const run = openedAtUse(held.open);
  const first = run.workspace();
  held.failNext();
  await assert.rejects(first, /the open failed/);
  const second = run.workspace();
  held.resolveNext();
  await second;
  assert.equal(held.seen.opens, 2);
  const failed = heldOpen();
  const other = openedAtUse(failed.open);
  const use = other.workspace();
  const released = other.end();
  failed.failNext();
  await released;
  await assert.rejects(use);
  assert.equal(failed.seen.ends, 0, "a failed open has nothing to end");
});
