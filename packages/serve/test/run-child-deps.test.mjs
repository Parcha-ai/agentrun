// A run's own process runs its loop on the plane its runner capped and chose its keys by: the start's init carries it
// (run-child-host.ts), and the process's deps hand it on as claimedPlane (run-child-deps.ts childDeps), which
// underServerCeilings takes as it is (claim-plane.test.mjs). Without it the process would read the server's settings a
// second time, and a setting changed between the two reads could leave a tool on a provider whose key it was not handed.
import assert from "node:assert/strict";
import { test } from "node:test";

const { childDeps } = await import("../dist/runner/run-child-deps.js");
const { underServerCeilings } = await import("../dist/runner/harness-loops.js");

const channel = { post: () => {}, call: async () => undefined };
const init = { claim: { runId: "run", epoch: 1 }, data: "/nowhere", signal: new AbortController().signal };
const depsOf = (given) => childDeps(given, {}, {}, {}, channel);

test("a run's process takes the plane its start hands it as its claimed plane, and runs its launch on it; a start with none hands none", async () => {
  const plane = { web_search: "native", model: "anthropic/claude-sonnet-5-5" };
  const deps = depsOf({ ...init, plane });
  assert.deepEqual(deps.claimedPlane, plane, "the start's plane is the claim's");
  // Its launch, kept on Parallel before the runner capped it, runs on the handed plane: no settings are read for it.
  const launch = { plane: { web_search: "parallel" }, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } };
  assert.deepEqual((await underServerCeilings(deps, launch, { kind: "agentic", body: {} })).plane, plane, "the loop's plane is the one handed");
  assert.equal("claimedPlane" in depsOf(init), false, "a start with no plane hands none");
});
