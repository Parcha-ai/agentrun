// The runner's learning end refuses every key saved on the server (learning-end.ts refused: the store's sealed secrets,
// which hold the saved keys): an owner's correction holding a key saved through the settings API is refused as
// secret_value, though the run was never handed it; and a key the run was handed is refused though a person replaced it
// while the run lived (the claim's keys). No learning row holds the key, and the run's kept learning (learning_proposals)
// names the problem and holds none of it.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { ended, keptProposal, LEARN, learner, learningText, made, sleep, started } from "./learn-support.mjs";
import { scratch, serve, withEnv } from "./support.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const SECRET_VALUE = (problems) => problems?.some((problem) => problem.rule === "secret_value" && problem.path === "corrections.md");

test("a correction that holds a key the server saved through its settings API is refused as secret_value, though the run was never handed it: no learning row holds the key, and nothing the run kept does", { timeout: 120_000 }, async (t) => {
  // Built here, so no scanner reads it as a credential, and no pattern does: only the value check can refuse it.
  const saved = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, ["MONID_API_KEY"]);
  const server = await serve(t, { learning: "on", faux: LEARN });
  const { api } = server;
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: saved } })).status, 204);
  await made(api, learner("keeper"));
  const runId = await started(api, "keeper");
  await ended(api, runId);
  const graded = await api("PUT", `/runs/${runId}/grade`, { correct: false, label: `Call monid with ${saved}.` });
  assert.deepEqual([graded.status, graded.body.feedback], [200, "correction"], JSON.stringify(graded.body));
  await ended(api, runId);
  const kept = await keptProposal(server, runId);
  assert.deepEqual([kept.proposal?.state, kept.proposal?.reason], ["dropped", "checker"], JSON.stringify(kept.proposal));
  assert.ok(SECRET_VALUE(kept.proposal.problems), JSON.stringify(kept.proposal.problems));
  assert.ok(!(await learningText(server, "keeper")).includes(saved), "no learning row holds the key");
  assert.ok(!JSON.stringify(kept).includes(saved), "the run's kept learning holds no key");
});

test("a saved key a run was handed is refused in its owner's message though the person replaced it while the run lived: the check knows what the claim handed", { timeout: 150_000 }, async (t) => {
  const handed = ["not-a-secret", "monid", randomBytes(6).toString("hex")].join("-");
  // The replacement is faux monid's own key, which it takes at the PUT's check as it takes the handed one by its digest.
  const replaced = MONID_KEY;
  const gate = join(await scratch(t), "answer");
  // The grant is pinned at the save against faux monid's listing, on the saved key (its digest is the one faux accepts).
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_MONID_ACCEPTS: createHash("sha256").update(handed).digest("hex") }, ["MONID_API_KEY"]);
  const server = await serve(t, { learning: "on", faux: LEARN, fauxMonid: FAUX_MONID });
  const { api } = server;
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: handed } })).status, 204);
  await made(api, learner("keeper", { tools: ["monid:faux/person/enrich"], instructions: `Answer once ${gate} exists.` }));
  const runId = await started(api, "keeper");
  for (let i = 0; (await api("GET", `/runs/${runId}`)).body.status !== "working"; i++) {
    assert.ok(i < 1200, "the run works");
    await sleep(50);
  }
  // Replaced while the run lives: its claim holds the key it was handed. The owner's message, sent in the same round,
  // is its correction, and holds that key.
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: replaced } })).status, 204);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: `Call monid with ${handed}.` })).status, 202);
  writeFileSync(gate, "");
  await ended(api, runId);
  const kept = await keptProposal(server, runId);
  assert.deepEqual([kept.proposal?.state, kept.proposal?.reason], ["dropped", "checker"], JSON.stringify(kept.proposal));
  assert.ok(SECRET_VALUE(kept.proposal.problems), JSON.stringify(kept.proposal.problems));
  assert.ok(!(await learningText(server, "keeper")).includes(handed), "no learning row holds the handed key");
});
