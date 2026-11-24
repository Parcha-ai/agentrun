// A serving learned workflow this release's workflow DSL refuses is held, never read as `serving` (runner/promotion.ts
// holdRefused): a promotion whose workflow.json the DSL's own validation refuses (validateWorkflow, no tool list: never
// a host setting) is held at the claim that serves it, once per digest, its reason the DSL's code and path. The run
// still hands back as before, and the agent answers. The hold follows compile once as a check's hold does: the agent's
// next due run asks the one recompile with the refusal in its ask, and a recompile that fails stops. And a shadow audit
// draws only a run the workflow answered (path `workflow`): a handed-back run is never drawn, nor counted as served.
//   (a) a promotion whose workflow.json carries a key the DSL refuses: the first run hands back and writes one hold with
//       the DSL's code; the promotions read says held with that reason; a second, concurrent claim writes no second one;
//   (b) the next due run asks the one recompile, the refusal in its ask; that recompile's failed draft stops it;
//   (c) a handed-back run is not drawn for an audit, and the draw's served count leaves it out;
//   (d) a promoted workflow the DSL accepts still serves: no false hold.
// The agent's runs are real runs of the store on a pi run of the faux gateway; its promotion is a check's record shape.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";
import { schemaProblems } from "./schema-support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { claimPromotion, promotionGate } = await import("../dist/runner/promotion.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { promotionsOf, promotionsShown } = await import("../dist/learn/promote.js");
const { learningWorkspace } = await import("../dist/workspace/index.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");
const { askedForCompile } = await import("../dist/learn/compile.js");
const { secretsShown, seedOf } = await import("../dist/learning.js");
const { readAudits, servingLinesOf } = await import("../dist/learn/audit.js");
const { AUDIT_DEFAULTS } = await import("../dist/learning-setting.js");
const { openapiDocument } = await import("../dist/openapi.js");

const SEAL_KEY = Buffer.alloc(32, 7);
const MODEL = "claude-sonnet-5-5";
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const AGENT_SAYS = JSON.stringify({ answer: 42, sure: true });
const FINAL = ["ended", "failed", "stopped"];

/** The audit's draw as the definition states it (learn/audit.ts auditDrawn). */
const drawn = (runId, k) => Number.parseInt(createHash("sha256").update(`audit:${runId}`).digest("hex").slice(0, 8), 16) % k === 0;

/** The learned workflow: one node answers the question as a number; an escalate hands it back when it is not sure. */
const ACCEPTED = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer", "sure"], properties: { answer: { type: "number" }, sure: { type: "boolean" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question; say whether you are sure.", out: "Answer", as: "answer", tier: "fast" },
    { node: "escalate", label: "unsure", when: { predicate: "field_equals", path: "answer.sure", value: false }, kind: "unsure", stage: "answer", summary: "not sure of {answer.answer}" },
  ] },
};
/** The same workflow as an older release saved it, its first node carrying a key this release's DSL does not take (a
 *  made-up one: the engine knows no key by name). */
const REFUSED = { ...ACCEPTED, root: { ...ACCEPTED.root, steps: [{ ...ACCEPTED.root.steps[0], tidy: { every: 2 } }, ACCEPTED.root.steps[1]] } };
const digestOf = (flow) => workflowDigest({ workflow: JSON.stringify(flow) });
/** The reason a hold of REFUSED gives: the DSL's code at the node's path. */
const REFUSAL = /^this release's workflow DSL refuses it: NODE_KEY_UNKNOWN at \/root\/steps\/0\b/;
/** A compile answer whose draft fails its dry run (its answer's state is never written): no draft lands. */
const BROKEN_DRAFT = `\`\`\`\`workflow answer\n---\ndescription: Answers a question as a number; use when asked\nexample: {"question":"What is six times seven?"}\n---\n${JSON.stringify({ ...ACCEPTED, root: { node: "chain", steps: [{ ...ACCEPTED.root.steps[0], as: "other" }] } })}\n\`\`\`\``;

const offers = (body, name) => (body?.tools ?? []).some((tool) => tool?.name === name);
const hasResult = (body) => (body?.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((block) => block?.type === "tool_result"));
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => (part?.type === "text" ? part.text : "")).join(""));
const lastUser = (body) => textOf((body?.messages ?? []).findLast((message) => message.role === "user"));
/** A compile turn's first ask (never an attempt the checks sent back). */
const compileAskOf = (body) => (askedForCompile(lastUser(body)) === true ? lastUser(body) : "");
const isRevise = (body) => compileAskOf(body).startsWith("One more turn: revise");

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** An agent of `learning` with `flow` landed as its learned workflow `answer` and promoted by its check, and a runner
 *  claiming every run from its stored launch. The workflow's node submits `submit(requestText)` ({answer: 42, sure:
 *  true} by default); the agent answers AGENT_SAYS; a compile ask is answered with BROKEN_DRAFT, or, `revise: "refuse"`,
 *  a revision ask is refused (no draft of it is recorded). */
async function world(t, { learning = true, flow, submit, revise = "broken" }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-refused-serving-hold-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway({
    call: ({ body }) => (offers(body, "submit") && !hasResult(body) ? { name: "submit", input: { value: submit ? submit(JSON.stringify(body)) : { answer: 42, sure: true } } } : undefined),
    text: ({ body }) => (offers(body, "submit") ? "submitted" : askedForCompile(lastUser(body)) !== false ? BROKEN_DRAFT : AGENT_SAYS),
    refuse: ({ body }) => (revise === "refuse" && isRevise(body) ? { message: "the test answers no revision" } : undefined),
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // No tool that can write (learn/audit.ts auditWriterOf): an agent whose served runs the audit may draw.
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: [], learning } });
  const price = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15) / 1e6;
  const route = { model: MODEL, provider: { api: "anthropic-messages", origin: gw.url, credential: () => `not-a-secret-${"pi"}` }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 8_192, price, fetch: globalThis.fetch };
  const logs = [];
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }), log: (line) => logs.push(line) };
  const seed = await landWorkflows(dir, "agent-1", [{ name: "answer", description: "Answers a question as a number", workflow: flow }]);
  await server.settings.put("learning.promotions.agent-1", { v: 1, items: [{ workflow: "answer", digest: digestOf(flow), at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check: { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 5, agreed: 5, alone: 5, of: [] }, commit: seed }] });
  const specOf = async (claim, run) => adapterRunSpecFromLaunch(readLaunchBody((await store.runs.launch(claim.runId)).body), run, deps, claim);
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop(specOf) });
  const ended = (id) => until(async () => {
    const row = await server.runs.get(id);
    return FINAL.includes(row?.state) && row.runner === null && row;
  }, `run ${id} ended`);
  const launchOf = async (question) => ({ input: { content: `${question}?`, question }, title: question, place: { mode: "runner" }, model: { provider: "anthropic", modelId: MODEL }, learning: startAt((await seedOf(dir, "agent-1")).sha) });
  const shadows = async () => {
    const out = [];
    for (const row of await server.runs.list({ agentId: "agent-1" })) {
      const launch = readLaunchBody((await server.runs.launch(row.id)).body);
      if (launch?.audit) out.push({ row, launch });
    }
    return out;
  };
  const asks = new Map();
  /** Runs `id` on `question`, as the server launches it; then waits for a shadow it started to end too. */
  const start = async (id, question) => {
    const before = gw.requests.length;
    await server.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: await launchOf(question) });
    const row = await ended(id);
    const shadow = (await shadows()).find(({ launch }) => launch.audit.of === id);
    if (shadow) await ended(shadow.row.id);
    asks.set(id, gw.requests.slice(before).map((request) => compileAskOf(request.body)).filter(Boolean));
    return row;
  };
  const audits = async () => {
    const folder = learningWorkspace({ mode: "local", data: dir, agentId: "agent-1" });
    try {
      return await readAudits(folder.workspace);
    } finally {
      await folder.end();
    }
  };
  /** The promotions read as GET /agents/{id}/learning/promotions builds it (no audit rows, the default numbers). A
   *  workflow nothing serves has no champion (null); the route reads a serving one's from the learning folder, which this
   *  read does not, so a serving row here has none and fails the schema: only a read where nothing serves is checked. */
  const read = async () => {
    const records = await promotionsOf(server.settings, "agent-1");
    const same = { text: (text) => text, name: (name) => name };
    const shown = promotionsShown(records, same);
    const lines = servingLinesOf(records, [], AUDIT_DEFAULTS, () => false);
    return { agent: "agent-1", promotions: shown.promotions, serving: shown.serving.map((one, i) => ({ ...one, ...lines[i], audits_off: null, not_auditable: 0, ...(one.digest === null ? { champion: null } : {}) })) };
  };
  return { dir, server, store, logs, seed, start, asks, shadows, audits, read, launchOf };
}

const decisions = async (server) => (await promotionsOf(server.settings, "agent-1")).map(({ digest, decided }) => [digest, decided]);
const doc = openapiDocument(() => undefined);
const meetsPromotions = (value) => assert.deepEqual(schemaProblems(doc, doc.paths["/agents/{agent_id}/learning/promotions"].get.responses["200"].content["application/json"].schema, value), [], JSON.stringify(value));

test("(a) a promoted workflow the DSL refuses: the run hands back, one hold with the DSL's code is written, and the promotions read says held with that reason", { timeout: 240_000 }, async (t) => {
  const w = await world(t, { flow: REFUSED, revise: "refuse" });
  const digest = digestOf(REFUSED);
  const first = await w.start("run-1", "What is six times seven");
  // The run still hands back as before, and the agent answers it.
  assert.deepEqual([first.state, first.metrics?.path, first.metrics?.workflow_digest], ["ended", "handed_back", digest], JSON.stringify(first.metrics));
  assert.deepEqual(await decisions(w.server), [[digest, "promote"], [digest, "hold"]]);
  const held = (await promotionsOf(w.server.settings, "agent-1")).at(-1);
  assert.match(held.reason, REFUSAL, held.reason);
  assert.ok(held.reason.includes("tidy"), `the DSL's own words name the key: ${held.reason}`);
  assert.deepEqual([held.workflow, held.check, held.audit, held.commit], ["answer", undefined, undefined, w.seed], "a hold by its reason: neither a check's numbers nor an audit's rows");
  // The promotions read: nothing serves, the workflow is held, its record's reason the DSL's.
  const promotions = await w.read();
  meetsPromotions(promotions);
  assert.deepEqual(promotions.serving.map(({ workflow, digest: at, state }) => [workflow, at, state]), [["answer", null, "held"]]);
  assert.match(promotions.promotions.at(-1).reason, REFUSAL);
  // The next run finds the hold: the agent takes it from its first turn, and nothing more is written.
  const second = await w.start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent", JSON.stringify(second.metrics));
  assert.deepEqual(await decisions(w.server), [[digest, "promote"], [digest, "hold"]], "one hold for the digest");
});

test("(a) two claims serving the refused revision at once write one hold between them", { timeout: 120_000 }, async (t) => {
  const w = await world(t, { flow: REFUSED });
  const digest = digestOf(REFUSED);
  const launch = readLaunchBody(await w.launchOf("What is six times seven"));
  const claim = (runId) => promotionGate(claimPromotion({
    store: w.server, agentId: "agent-1", runId, revisionId: "rev-1", launch, context: BACKGROUND_CONTEXT, log: () => {},
    shown: async () => secretsShown([]), folder: () => learningWorkspace({ mode: "local", data: w.dir, agentId: "agent-1" }),
  }));
  const laid = { name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(REFUSED) };
  await Promise.all([claim("claim-a")(laid, digest), claim("claim-b")(laid, digest)]);
  const records = await promotionsOf(w.server.settings, "agent-1");
  assert.deepEqual(records.map(({ digest: at, decided }) => [at, decided]), [[digest, "promote"], [digest, "hold"]], JSON.stringify(records));
  assert.match(records[1].reason, REFUSAL);
  // A later claim finds the hold: nothing serves, nothing is written.
  assert.equal(await claim("claim-c")(laid, digest), undefined);
  assert.equal((await promotionsOf(w.server.settings, "agent-1")).length, 2);
});

test("(b) the next due run asks the one recompile with the DSL's refusal in its ask; that recompile's failed draft stops it", { timeout: 300_000 }, async (t) => {
  const w = await world(t, { flow: REFUSED });
  const digest = digestOf(REFUSED);
  const first = await w.start("run-1", "What is six times seven");
  assert.equal(first.metrics?.path, "handed_back", JSON.stringify(first.metrics));
  const [ask, ...more] = w.asks.get("run-1");
  assert.deepEqual(more, [], "one compile ask");
  assert.ok(ask?.startsWith("One more turn: revise your learned workflow `answer`"), ask?.slice(0, 300));
  assert.match(ask, /does not run first: it was held \(this release's workflow DSL refuses it: NODE_KEY_UNKNOWN at \/root\/steps\/0/, ask.slice(0, 1200));
  // Its draft failed its checks: the recompile's attempt, so it stops, and no later run compiles anything.
  const records = await promotionsOf(w.server.settings, "agent-1");
  assert.deepEqual(records.slice(0, 2).map(({ digest: at, decided }) => [at, decided]), [[digest, "promote"], [digest, "hold"]]);
  const failed = records.at(-1);
  assert.equal(records.length, 3, JSON.stringify(records));
  assert.deepEqual([failed.workflow, failed.decided, failed.check?.attempt, failed.check?.stopped], ["answer", "hold", 2, true], JSON.stringify(failed));
  assert.equal((await w.read()).serving[0].state, "stopped");
  const second = await w.start("run-2", "What is seven times six");
  assert.equal(second.metrics?.path, "agent");
  assert.deepEqual(w.asks.get("run-2"), [], "nothing compiles again");
  assert.equal((await promotionsOf(w.server.settings, "agent-1")).length, 3);
});

test("(c) a handed-back run is never drawn for an audit, and the draw's served count leaves it out", { timeout: 240_000 }, async (t) => {
  // Every served run is drawn at first (audit_every 1); once one served run is counted, 1 in 1,000.
  const learning = { audit_every: 1, audit_every_later: 1_000, audit_later_after: 1 };
  const submit = (text) => (text.includes("Hand it back") ? { answer: 42, sure: false } : { answer: 42, sure: true });
  const w = await world(t, { learning, flow: ACCEPTED, submit });
  const back = await w.start("back-1", "Hand it back");
  assert.deepEqual([back.state, back.metrics?.path], ["ended", "handed_back"], JSON.stringify(back.metrics));
  assert.deepEqual(await w.shadows(), [], "a run the workflow handed back is no audit's");
  // The answered run after it: drawn at 1 in 1 when the handed-back run is not counted as served, never at 1 in 1,000.
  const id = ["alone-1", "alone-2", "alone-3", "alone-4"].find((one) => !drawn(one, 1_000));
  assert.ok(id);
  const alone = await w.start(id, "What is six times seven");
  assert.deepEqual([alone.metrics?.path, alone.metrics?.workflow_digest], ["workflow", digestOf(ACCEPTED)], JSON.stringify(alone.metrics));
  assert.deepEqual((await w.shadows()).map(({ launch }) => launch.audit.of), [id], "the answered run alone is audited");
  // A later claim settles its row; the handed-back run has none, started or finished.
  await w.start("later-1", "Hand it back");
  assert.deepEqual((await w.audits()).map((row) => row.run), [id]);
});

test("(d) a promoted workflow the DSL accepts still serves: no hold", { timeout: 180_000 }, async (t) => {
  const w = await world(t, { flow: ACCEPTED });
  const digest = digestOf(ACCEPTED);
  for (const id of ["run-1", "run-2"]) {
    const row = await w.start(id, `What is six times seven, ${id}`);
    assert.deepEqual([row.metrics?.path, row.metrics?.workflow_digest], ["workflow", digest], JSON.stringify(row.metrics));
  }
  assert.deepEqual(await decisions(w.server), [[digest, "promote"]]);
  assert.equal((await w.read()).serving[0].state, "serving");
});
