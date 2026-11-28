// The end's cut (AdapterRun.endCut) stays in force after RunTools.end returns: the claim's release goes on calling the
// computer after it (SpecHolds' checkout end, the workspace's end), on the same client, and a daemon that died answers
// none of those either. So a call made after the end is still cut when the end's cut comes, never left hanging.
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

test("a computer call made after RunTools.end is still cut by the end's cut", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "end-cut-after-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const computer = fakeComputer(root);
  computer.overrides["process.list"] = () => ({ processes: [], truncated: false, next: 0 });
  // A call honors its signal, as a daemon's client does (DaemonClient.call): it ends when the signal it was given does.
  const answer = computer.client.call.bind(computer.client);
  computer.client.call = (method, params, options) => {
    const signal = options?.signal;
    if (!signal) return answer(method, params);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      answer(method, params).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };
  // The claim's signal, as both specs give it (run.signal): its calls are cut through it (claimCut), the end's by the
  // end's own cut. It never comes here.
  const cut = new AbortController();
  const tools = await runTools(localWorkspace(root), { kind: "sandbox", computer, check: { readBackOf } }, { mode: 1, context: BACKGROUND_CONTEXT, signal: new AbortController().signal, endCut: () => cut.signal });
  await tools.end();
  // The daemon is gone now: a stat after the end is never answered.
  computer.overrides["files.stat"] = () => new Promise(() => {});
  const mark = computer.calls.length;
  const after = tools.workspace.stat("notes.txt").then(() => "answered", (error) => `cut: ${error?.message ?? error}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(computer.calls.slice(mark).map(([method]) => method), ["files.stat"], "the stat after the end reached the computer, and hangs there");
  assert.equal(await Promise.race([after, new Promise((resolve) => setImmediate(resolve, "pending"))]), "pending", "nothing answered it before the cut");
  cut.abort(new Error("the end's cut"));
  const outcome = await Promise.race([after, new Promise((resolve) => setTimeout(resolve, 2_000, "still hanging")).then((v) => v)]);
  assert.match(outcome, /^cut: /, `the call after the end was cut when the end's cut came (${outcome})`);
});
