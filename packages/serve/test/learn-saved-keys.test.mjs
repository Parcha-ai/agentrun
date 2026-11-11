// The runner's learning end refuses every key saved on the server, as the server's check did (learning-run.ts refused:
// serverSecrets, which reads the saved keys): a note holding a key saved through the settings API is refused as
// secret_value, though the run was never handed it; and a key the run was handed is refused though a person replaced it
// while the run lived (the claim's keys). The grader is never asked, no git object holds the key, and the run's kept
// learning (learning_proposals) names the problem. (learn-merge's two cases, on the runner path.)
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { keptProposal, LEARN, learner, made, objects, repoOf, sleep, started } from "./learn-support.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";

const SECRET_VALUE = [{ rule: "secret_value", path: "call-monid.md", detail: "it holds a value the host named as secret" }];

/** Run `runId`, completed, and its kept learning once its end-of-run turn is kept. */
async function keptOf(server, runId) {
  await follow(server.api, runId, ["completed"], { deadlineMs: 90_000 });
  for (let i = 0; ; i++) {
    const kept = await keptProposal(server, runId);
    if (kept) return kept;
    assert.ok(i < 1200, "the run's learning is kept");
    await sleep(50);
  }
}

test("a note that holds a key the server saved through its settings API is refused as secret_value, though the run was never handed it: the grader is never asked, no git object holds the key, and nothing the run kept does", { timeout: 120_000 }, async (t) => {
  // Built here, so no scanner reads it as a credential, and no pattern does: only the value check can refuse it.
  const saved = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_CALLS: calls }, ["MONID_API_KEY"]);
  const server = await serve(t, { learning: "on", faux: LEARN });
  const { api, data } = server;
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: saved } })).status, 204);
  await made(api, learner("keeper", { plan: [["call-monid.md", note("Call monid", "Call monid on its saved key", `Call monid with ${saved}.\n`)]] }));
  const runId = await started(api, "keeper");
  const kept = await keptOf(server, runId);
  assert.deepEqual([kept.proposal?.state, kept.proposal?.reason], ["dropped", "checker"], JSON.stringify(kept.proposal));
  assert.deepEqual(kept.proposal.problems, SECRET_VALUE);
  assert.ok(!kept.learningRunId, "no learning run queued");
  assert.equal(existsSync(calls) ? readFileSync(calls, "utf8").trim() : "", "", "the grader was never asked, so its prompt never held the note");
  assert.ok(!objects(repoOf(data, "keeper")).includes(saved), "no git object holds the key");
  assert.ok(!JSON.stringify(kept).includes(saved), "the run's kept learning holds no key");
});

test("a saved key a run was handed is refused in its notes though the person replaced it while the run lived: the check knows what the claim handed, the grader is never asked", { timeout: 150_000 }, async (t) => {
  const handed = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  const replaced = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  const gate = join(await scratch(t), "answer");
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_CALLS: calls }, ["MONID_API_KEY"]);
  const server = await serve(t, { learning: "on", faux: LEARN });
  const { api, data } = server;
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: handed } })).status, 204);
  await made(api, learner("keeper", { tools: ["write", "monid.discover", "monid.inspect", "monid.run"], instructions: `Answer once ${gate} exists.`, plan: [["call-monid.md", note("Call monid", "Call monid on its key", `Call monid with ${handed}.\n`)]] }));
  const runId = await started(api, "keeper");
  for (let i = 0; (await api("GET", `/runs/${runId}`)).body.status !== "working"; i++) {
    assert.ok(i < 1200, "the run works");
    await sleep(50);
  }
  // Replaced while the run lives: its claim holds the key it was handed, and its end-of-run turn writes that one.
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: replaced } })).status, 204);
  writeFileSync(gate, "");
  const kept = await keptOf(server, runId);
  assert.deepEqual([kept.proposal?.state, kept.proposal?.reason], ["dropped", "checker"], JSON.stringify(kept.proposal));
  assert.deepEqual(kept.proposal.problems, SECRET_VALUE);
  assert.equal(existsSync(calls) ? readFileSync(calls, "utf8").trim() : "", "", "the grader was never asked");
  assert.ok(!objects(repoOf(data, "keeper")).includes(handed), "no git object holds the handed key");
});
