// RunTools.end lets its end's cut go once the end has finished (AdapterRun.endCut's `done`): the cut's timer is cleared
// then, not left until its bound (the release's, about 35 s at defaults) holding the loop's state, and a later close does
// not set it again. `done` comes once, after the end's last computer call, whether the end finished or threw.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { localWorkspace } from "../dist/workspace/index.js";
import { runTools } from "../dist/workspace/run-tools.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";

async function setup(t, list) {
  const root = await mkdtemp(join(tmpdir(), "end-cut-done-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const computer = fakeComputer(root);
  computer.overrides["process.list"] = list;
  const made = [];
  const endCut = () => {
    const one = { cut: new AbortController(), done: 0, callsAtDone: -1 };
    made.push(one);
    return { signal: one.cut.signal, done: () => { one.done++; one.callsAtDone = computer.calls.length; } };
  };
  const tools = await runTools(localWorkspace(root), { kind: "sandbox", computer, check: { readBackOf } }, { mode: 1, context: BACKGROUND_CONTEXT, endCut });
  return { computer, tools, made };
}

test("RunTools.end lets its cut go once, after its last computer call", async (t) => {
  const { computer, tools, made } = await setup(t, () => ({ processes: [], truncated: false, next: 0 }));
  await tools.end();
  assert.equal(made.length, 1, "the end made one cut");
  assert.ok(computer.calls.some(([method]) => method === "process.list"), "the end asked for its background processes");
  assert.equal(made[0].done, 1, "its cut was let go once");
  assert.equal(made[0].callsAtDone, computer.calls.length, "after the end's last computer call");
});

test("RunTools.end lets its cut go when the end throws too", async (t) => {
  const { tools, made } = await setup(t, () => { throw new Error("the daemon is gone"); });
  await tools.end().catch(() => {});
  assert.equal(made.length, 1, "the end made one cut");
  assert.equal(made[0].done, 1, "its cut was let go once, the end having thrown");
});
