// A claim whose computer replaced an earlier claim's (computer-for-claim.ts ClaimComputer.replaced: a runner lost, a
// crash, a server's stop), through the spec builders the runner really uses (adapter-run-spec.ts for pi, cli-run-spec.ts
// for a CLI harness): the model's next request carries one plain server message saying so, exactly once (the model
// proxy's note, as the cap's wrap-up is told), and the run's timeline shows it once as the server's; an act at a point of
// the old computer's screen (no state named, nothing looked at yet) is answered in words, and never reaches the computer.
//
// The desktop is --faux's (faux-computers.ts): nothing is rented. The claim's computer is the shared computerForClaim's,
// marked replaced as a later claim's would be (workspace-computer-for-claim.test.mjs covers when a claim is).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readBackOf } from "@parcha/agentrun-computer";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CODEX_STANDIN_ENV, OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { computerDepsFrom, computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const DESKTOP = { kind: "desktop", provider: "faux-desktop" };
const FAUX = fauxComputers();
after(closeOpenSessions);

/** The server message the model is told, exactly (a desktop, Mode 1: no kept run folder), labelled as the server's. */
const NOTE = "AgentRun server note: your computer was replaced. The earlier one is gone, with its screen and refs. Look at the screen again before acting.";
/** Its row on the run's timeline: the server's, labelled once. */
const ROW = "AgentRun: Your computer was replaced. The earlier one is gone, with its screen and refs. Look at the screen again before acting.";
/** Every note of the replaced computer in a request's body (the regex stops at the reminder's closing tag). */
const NOTES = /AgentRun server note: your computer was replaced[^<]*/g;
const STATE_WORDS = "that state is from the replaced computer; observe again";

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const FAUX_DEPS = {
  kinds: FAUX.kinds,
  keyTable: FAUX.keyTable,
  launch: FAUX.launch,
  providers: {},
  spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open" }),
  check: { readBackOf },
};

/** The shared computerForClaim, its computer marked as one that replaced an earlier claim's; each input batch that reaches
 *  the computer (the faux desktop has no ui group: an act is raw input there) is counted in `acts`. */
const replacedClaim = (acts, inner = computerForClaim) => async (claim, store, deps) => {
  const made = await inner(claim, store, deps);
  const client = made.computer.computer.client;
  const call = client.call.bind(client);
  client.call = (method, params, options) => (method === "input.actions" ? acts.push(params) : undefined, call(method, params, options));
  return { ...made, replaced: { kind: "desktop", folderKept: false } };
};

async function storeWith(t, body, launch) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-replaced-computer-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: DESKTOP, ...body } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  return { dir, server, store };
}

/** Until the run is released; its timeline rows' summaries. */
async function ended(opened) {
  const row = await until(async () => {
    const now = await opened.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run is released");
  assert.equal(row.state, "ended", JSON.stringify(row));
  return (await runTimeline(opened.server, RUN, ctx)).map((one) => one.summary);
}

const reminders = (body) => (JSON.stringify(body).match(NOTES) ?? []);
/** The server's rows of the replaced computer, each checked labelled once. */
const serverRows = (said) => {
  assert.ok(!said.some((summary) => summary?.includes("AgentRun server note")), `no row is labelled twice: ${JSON.stringify(said)}`);
  return said.filter((summary) => summary?.startsWith("AgentRun: Your computer"));
};

test("pi: the model's first request on a replaced computer carries the server message once, the timeline shows it once, and an act at a point of the old screen is refused in words before the computer", { timeout: 120_000 }, async (t) => {
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  const opened = await storeWith(t, { tools: ["read"] }, launch);
  const requests = [];
  // A click at a point of the old computer's screen, with no state: the host's default would be the old one's.
  const scripted = scriptedOrigin([{ call: "computer_act", args: { steps: [{ click: [10, 20] }] } }, { say: "done" }], requests);
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scripted };
  const acts = [];
  const deps = { env: {}, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: replacedClaim(acts), computerDeps: FAUX_DEPS };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const said = await ended(opened);
  assert.equal(requests.length, 2, "an act, then the answer");
  assert.deepEqual(requests.map((body) => reminders(body).length), [1, 0], "the first request carries it, the next does not");
  assert.equal(reminders(requests[0])[0], NOTE, "in its exact words");
  assert.deepEqual(serverRows(said), [ROW], "one row of the server's, labelled once");
  assert.ok(JSON.stringify(requests[1]).includes(STATE_WORDS), "the act at a point of the old screen is answered in words");
  assert.deepEqual(acts, [], "no act reached the computer");
});

/** OpenRouter's Chat Completions endpoint for a free model, a stand-in (nothing leaves loopback): a computer_act call,
 *  then an answer; each request's body kept in `bodies`. */
const openRouterFree = (bodies) => async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== "https://openrouter.ai/api/v1/chat/completions") return new Response("not here", { status: 404 });
  bodies.push(JSON.parse(input instanceof Request ? await input.text() : String(init?.body ?? "{}")));
  const chunk = (fields) => `data: ${JSON.stringify({ id: `gen-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: "inclusionai/ling-3.2-flash:free", ...fields })}\n\n`;
  const act = { index: 0, id: "call_1", type: "function", function: { name: "computer_act", arguments: JSON.stringify({ steps: [{ click: [10, 20] }] }) } };
  const said = bodies.length === 1
    ? chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [act] }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    : chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  const usage = chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
  return new Response(`${said}${usage}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
};

test("pi on a free route (OpenRouter's ling-3.2-flash:free, the runner's own route, under a cap): the model's first request carries the server message once, in its words, and the timeline shows it once", { timeout: 120_000 }, async (t) => {
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "openrouter", modelId: "inclusionai/ling-3.2-flash:free" }, maxCostUsd: 1 };
  const opened = await storeWith(t, { tools: ["read"] }, launch);
  const bodies = [];
  const route = await routeOf("openrouter/inclusionai/ling-3.2-flash:free", { OPENROUTER_API_KEY: "not-a-secret-openrouter" }, "default", undefined, openRouterFree(bodies));
  assert.deepEqual([route.cost.input, route.cost.output], [0, 0], "a free model");
  const acts = [];
  const deps = { env: {}, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: replacedClaim(acts), computerDeps: FAUX_DEPS };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const said = await ended(opened);
  assert.equal(bodies.length, 2, "an act, then the answer, both to OpenRouter");
  assert.deepEqual(bodies.map((body) => reminders(body)), [[NOTE], []], "the first request carries it in its words, the next does not");
  assert.deepEqual(serverRows(said), [ROW], "one row of the server's, labelled once");
  assert.ok(JSON.stringify(bodies[1]).includes(STATE_WORDS), "the act at a point of the old screen is answered in words");
  assert.deepEqual(acts, [], "no act reached the computer");
});

test("a CLI harness (opencode): its first main-model request carries the server message once, and the timeline shows it once", { timeout: 120_000 }, async (t) => {
  const launch = { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "opencode", model: { provider: "openai", modelId: "gpt-6.1-sol" } };
  const opened = await storeWith(t, { harness: "opencode", tools: ["read"] }, launch);
  const bodies = [];
  const gw = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method === "POST") bodies.push(text);
    const events = [
      { type: "response.output_text.delta", item_id: "m_0", output_index: 0, content_index: 0, delta: "Done." },
      { type: "response.completed", response: { id: "resp_0", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => gw.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gw.close(resolve)));
  const env = { AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gw.address().port}`, AGENT_MODEL_API_KEY: "not-a-secret", [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }), PATH: process.env.PATH };
  const deps = { env, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: replacedClaim([]), computerDeps: FAUX_DEPS };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "opencode" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const said = await ended(opened);
  assert.ok(bodies.length >= 1, "a request was sent");
  assert.deepEqual(bodies.map((body) => (body.match(NOTES) ?? []).length), [1, ...bodies.slice(1).map(() => 0)], "the first request carries it, no later one");
  assert.deepEqual(serverRows(said), [ROW], "one row of the server's, labelled once");
});

test("a CLI harness (codex): its first main-model request carries the server message once, the timeline shows it once, and its computer_act at a point of the old screen is refused in words before the computer", { timeout: 120_000 }, async (t) => {
  const was = process.env.AGENTRUN_CODEX_STANDIN;
  process.env.AGENTRUN_CODEX_STANDIN = "1";
  t.after(() => (was === undefined ? delete process.env.AGENTRUN_CODEX_STANDIN : (process.env.AGENTRUN_CODEX_STANDIN = was)));
  const bodies = [];
  const gw = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method === "POST") bodies.push(text);
    const events = [{ type: "response.output_text.delta", delta: "Codex answered." }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => gw.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gw.close(resolve)));
  const launch = { input: { content: `call computer_act ${JSON.stringify({ steps: [{ click: [10, 20] }] })}` }, title: "t", place: { mode: "runner" }, harness: "codex", model: { provider: "openai", modelId: "gpt-test" } };
  const opened = await storeWith(t, { harness: "codex", tools: ["read"] }, launch);
  const standIn = join(opened.dir, "codex-stand-in.mjs");
  await copyStandIn(standIn);
  const env = {
    [CODEX_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gw.address().port}`,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: "not-a-secret",
    AGENT_MODEL_PRICE: "1,2,0.5",
  };
  const acts = [];
  const composed = computerDepsFrom({ env: {}, store: opened.store, sealKey: SEAL_KEY, faux: fauxComputers() });
  const deps = { env, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: replacedClaim(acts, composed.computerForClaim), computerDeps: composed.computerDeps };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "codex" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  const said = await ended(opened);
  assert.ok(bodies.length >= 1, "a request was sent");
  assert.deepEqual(bodies.map((body) => (body.match(NOTES) ?? []).length), [1, ...bodies.slice(1).map(() => 0)], "the first request carries it, no later one");
  assert.deepEqual(serverRows(said), [ROW], "one row of the server's, labelled once");
  assert.ok(JSON.stringify(await runTimeline(opened.server, RUN, ctx)).includes(STATE_WORDS), "the act is answered in words");
  assert.deepEqual(acts, [], "no act reached the computer");
});
