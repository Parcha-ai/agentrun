// A webhook trigger's signing secret never reaches a learned note: a run whose end-of-run turn writes it in a note has
// its learning refused by the checker, with the secret this server holds now (after a rotation, the new one), and any
// `whsec_` secret, this server's or another's, is a secret by its shape. Nothing the checks refuse is kept.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { answerWith, note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, made, repoOf, savedOf, settled, started } from "./learn-support.mjs";
import { runDir, serve, withEnv } from "./support.mjs";
import { fakeSlack, SLACK_BOT_TOKEN } from "./fixtures/fake-slack.mjs";

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
const hooked = { source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "target", input: { content: "Go." }, max_cost_usd: 0.5 } };

/** A run of a learning agent `id` whose end-of-run turn proposes a note holding `held`: its learning, as saved. */
async function proposing(api, data, id, held) {
  await made(api, learner(id, { instructions: `Answer: ${JSON.stringify(answerWith([["hook.md", note("Hook", "The hook's key", `It is ${held}.\n`)]]))}` }));
  const run = await ended(api, await started(api, id));
  settled(run.view, run.rows, "dropped", "checker");
  assert.equal(existsSync(join(runDir(data, run.view.run_id), "learning-proposal.json")), false, "nothing is kept that the checks refuse");
  assert.equal(git(repoOf(data, id), ["rev-list", "--count", "main"]), "1", "nothing merged");
  assert.ok(!JSON.stringify(run.view.learning).includes(held), "the run's learning shows it nowhere");
  return (await savedOf(data, run.view.run_id)).learning.problems.map((p) => p.rule);
}

test("a note holding a webhook trigger's signing secret is refused, by its value and its shape; after a rotation the new secret is refused the same; another server's whsec_ secret is refused by its shape", { timeout: 300_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("target"));
  const created = await api("POST", "/triggers", hooked);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // The value it holds now and another server's, at once (two agents, each its own run); then, rotated, the new value.
  const [leaky, foreign] = await Promise.all([proposing(api, data, "leaky", created.body.signing_secret), proposing(api, data, "foreign", `whsec_${randomBytes(32).toString("base64")}`)]);
  assert.ok(leaky.includes("secret_value"), "the value this server holds");
  assert.ok(foreign.includes("secret_shape"), "a whsec_ secret this server never made");
  const rotated = (await api("POST", `/triggers/${created.body.id}/secret`)).body.signing_secret;
  assert.ok((await proposing(api, data, "rotated", rotated)).includes("secret_value"), "the new value, read as it is now");
});

// So are the Slack app's signing secret and bot token, which have no shape of their own: by their values, as they are
// saved now.
test("a note holding the Slack app's signing secret or bot token is refused by its value, read as the settings are now", { timeout: 300_000 }, async (t) => {
  withEnv(t, SEAL);
  const slack = await fakeSlack(t);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN, sourceApis: { slack: slack.url } });
  const signing = `not-a-secret-${randomBytes(16).toString("hex")}`;
  assert.equal((await api("PUT", "/settings/sources/slack", { signing_secret: signing, bot_token: SLACK_BOT_TOKEN })).status, 200);
  assert.ok((await proposing(api, data, "signing", signing)).includes("secret_value"), "the signing secret");
  assert.ok((await proposing(api, data, "bot", SLACK_BOT_TOKEN)).includes("secret_value"), "the bot token");
  const resaved = `not-a-secret-${randomBytes(16).toString("hex")}`;
  assert.equal((await api("PUT", "/settings/sources/slack", { signing_secret: resaved, bot_token: SLACK_BOT_TOKEN })).status, 200);
  assert.ok((await proposing(api, data, "resaved", resaved)).includes("secret_value"), "the new one, read as it is now");
});
