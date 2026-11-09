// A pi run's own model route for a request the host sends beside pi's (a learned workflow's model node), as the CLI
// harnesses give theirs: pi's session gives port(label), its proxy with a side key minted for the label, pi's model and
// the provider's wire. So run.ledger.models(label), taken at the spec's build, gives the node a model on a pi run, and
// its call goes through pi's one session booking under the run's one cap: booked under its label, and refused before it
// leaves when the cap has no room for it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { closeOpenSessions, hostTools, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { capRun, quiet, SONNET } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
after(closeOpenSessions);

const LABEL = "learned_workflow";
const QUESTION = "The node's question.";
const provider = { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"pi-port"}` };

/** A pi run whose one tool is a learned workflow's model node: it asks `question` through the models the spec took at its
 *  build (run.ledger.models(LABEL)). The provider answers pi by the script and the node by a word of its own; `upstream`:
 *  every body of the node's that reached it. */
function nodeRun(question) {
  const said = [];
  const upstream = [];
  let atBuild;
  const script = [{ call: "node" }, { say: "done" }];
  const pi = scriptedOrigin(script);
  const side = scriptedOrigin([{ say: "the node's answer" }]);
  const fetch = async (url, init) => (String(init?.body ?? "").includes(QUESTION) ? (upstream.push(JSON.parse(String(init.body))), side(url, init)) : pi(url, init));
  const node = {
    name: "node",
    replaySafe: false,
    run: async () => {
      const models = await atBuild;
      if (!models) return (said.push("no models at the spec's build"), "no models");
      const model = models.getModels()[0];
      if (!model) return (said.push("no model on pi's port"), "no model");
      const answer = await models.completeSimple(model, { messages: [{ role: "user", content: question, timestamp: Date.now() }] });
      said.push({ stopReason: answer.stopReason, error: answer.errorMessage });
      return "the node answered";
    },
  };
  const specOf = () => (_claim, run) => {
    atBuild = run.ledger?.models(LABEL);
    return { adapter: piAdapter({ run, model: MODEL, provider, fetch, price: () => 0 }), session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({ node }), context: "fresh" }, input: "Run the node.", hooks: quiet, gate: () => "allow" };
  };
  return { specOf, said, upstream, script, built: () => atBuild };
}

/** The run's root session records, read under a reader's claim. */
async function rootRecords(store) {
  const row = await store.runs.get("run-1");
  const reader = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    return await journalSessions(reader, ctx, store).read("root");
  } finally {
    await reader.close(ctx);
  }
}

test("a learned workflow's model node on a pi run calls through pi's port: its call books on the run's ledger under its label", async (t) => {
  const node = nodeRun(QUESTION);
  const { row, store } = await capRun(t, { script: node.script, specOf: node.specOf, runCap: { capUsd: () => undefined, modelOf: () => SONNET } });
  assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, summary: row.summary, said: node.said })}`);
  assert.deepEqual(node.said, [{ stopReason: "stop", error: undefined }], `the node's call was answered through pi's port: ${JSON.stringify(node.said)}`);
  assert.equal(node.upstream.length, 1, "the node's request reached the provider once");
  const records = await rootRecords(store);
  const mine = records.filter((r) => r.kind === "runner.request" && r.data.host === LABEL);
  assert.equal(mine.length, 1, `one request under its label on pi's session booking: ${JSON.stringify(records.map((r) => [r.kind, r.data]))}`);
  assert.ok(records.some((r) => r.kind === "runner.turn" && r.data.turn === mine[0].data.turn), `and booked: ${JSON.stringify(records.map((r) => [r.kind, r.data]))}`);
});

test("a learned workflow's model call on a pi run past the run's cap is refused before it leaves, in the cap's words", async (t) => {
  // ~400,000 input tokens (one a UTF-8 byte) at Sonnet's $3/M, about $1.2 before its output: past a $1 cap that pi's own
  // small requests fit.
  const node = nodeRun(`${QUESTION} ${"a".repeat(400_000)}`);
  const { store } = await capRun(t, { script: node.script, specOf: node.specOf, runCap: { capUsd: () => 1, modelOf: () => SONNET } });
  assert.notDeepEqual(node.said, ["no model on pi's port"], "the node had a model on pi's port");
  assert.equal(node.upstream.length, 0, "the node's request never reached the provider");
  assert.equal(node.said[0]?.stopReason, "error", `the node's call was refused: ${JSON.stringify(node.said)}`);
  assert.match(node.said[0]?.error ?? "", /spend_cap_reached/, `in the cap's words: ${JSON.stringify(node.said)}`);
  const records = await rootRecords(store);
  assert.equal(records.filter((r) => r.kind === "runner.request" && r.data.host === LABEL).length, 0, `nothing admitted under its label: ${JSON.stringify(records.map((r) => [r.kind, r.data]))}`);
});
