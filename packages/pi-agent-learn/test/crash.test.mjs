import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentLearn, collectCandidates } from "../dist/index.js";
import { AGENT, ctx, done, openRun, scratch, toolResults } from "./support.mjs";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "learn-then-die.mjs");

function runChild(store) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, store], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, out, err }));
  });
}

test("a run killed with SIGKILL after learn committed resumes from the same store: the call reruns and the candidate is not duplicated", async () => {
  const root = await scratch();
  const store = path.join(root, "run.sqlite");
  const died = await runChild(store);
  assert.equal(died.signal, "SIGKILL", died.err.slice(-1500));
  assert.equal(died.out, "executed call-0 [noted 1]\n", "the first attempt stored the candidate, then the process died before the result was committed");

  const extension = agentLearn();
  const [tool] = extension.tools;
  const execute = tool.execute;
  const reruns = [];
  const counting = { ...extension, tools: [{ ...tool, execute: async (args, api, context) => { const r = await execute.call(tool, args, api, context); reruns.push({ callId: api.callId, text: r.output[0].text }); return r; } }] };
  let seen;
  const run = await openRun(store, { extension: counting, steps: [(c) => { seen = toolResults(c); return done(); }] });
  try {
    await (await run.harness.root(ctx, { agent: AGENT })).waitForIdle(ctx);
    assert.deepEqual(reruns, [{ callId: "call-0", text: "[noted 1]" }], "the replay-safe call ran again with the same call id and found its candidate");
    assert.deepEqual(seen, [{ isError: false, text: "[noted 1]" }], "the model got the result of the resumed call");
    const candidates = await collectCandidates(run.harness);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].callId, "call-0");
  } finally {
    await run.close();
  }
});
