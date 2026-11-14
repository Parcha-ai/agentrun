// The tool-call budget (tool-budget.ts): an agent's `max_tool_calls`, held by the run's gate on pi. Past it, each call is
// refused before it runs in one fixed text that tells the model to answer now, that refusal is not counted, and the
// model's final answer still lands; each conversation of the run counts its own calls; the count is read from the
// journal, so it holds across a claim moved to another runner; no budget changes nothing. Then the setting itself: a
// definition keeps it (an edit too), refuses a bad one, a workflow's and one on another harness; a template's
// `budget.tool_calls` sets it at apply.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { closeOpenSessions, hostTools, MODEL, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, sleep, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import { agent, answerFlow, flowAgent, scratch, serve } from "./support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { fillerTools, suiteTools, MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { TOOL_BUDGET_TEXT } = await import("../dist/tool-budget.js");
const { CODEMODE, TOOLS_CALL } = await import("../dist/runner/meta-tools.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { compiled, PackageError, readPackage } = await import("../dist/templates.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A gate that allows every call, holding each conversation to `toolCalls` (none: no budget). */
const gateOf = (toolCalls) => Object.assign(() => "allow", toolCalls === undefined ? {} : { toolCalls });

/** Every tool result the provider got, in order, by the request that first carried it: its text and whether it is an error. */
function resultsIn(requests) {
  const seen = new Map();
  for (const body of requests) {
    for (const part of (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))) {
      if (part.type !== "tool_result" || seen.has(part.tool_use_id)) continue;
      const blocks = typeof part.content === "string" ? [{ type: "text", text: part.content }] : part.content ?? [];
      seen.set(part.tool_use_id, { text: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""), isError: part.is_error === true });
    }
  }
  return [...seen.values()];
}
const refusals = (results) => results.filter((result) => result.text === TOOL_BUDGET_TEXT && result.isError).length;

/** The run's final answer: the text of the provider's last answer the script gave (`say`). */
const ended = (server) =>
  until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "ended" && row.runner === null && row;
  }, "the run ended", 30_000);

/** One pi run of `script` through the adapter loop under `toolCalls`: the provider's requests and the tools' counts. */
async function budgetedRun(t, script, toolCalls, extraTools = {}) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const { tools, ran } = suiteTools();
  const requests = [];
  const spec = piAdapterSpec({ script, tools: { ...tools, ...extraTools }, hooks: quiet }, { requests });
  const runner = startRunner({ store, createLoop: createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), gate: gateOf(toolCalls) })), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await ended(server);
  return { row, requests, ran, server };
}

test("past its budget each call is refused in the budget's words, the refusal uncounted, and the model's answer lands", async (t) => {
  const script = [{ call: "read" }, { call: "read" }, { call: "read" }, { call: "read" }, { say: "done from what I have" }];
  const w = await budgetedRun(t, script, 2);
  assert.equal(w.ran.read, 2, "two calls ran");
  const results = resultsIn(w.requests);
  assert.deepEqual(results.map((result) => result.text), ["read", "read", TOOL_BUDGET_TEXT, TOOL_BUDGET_TEXT], "the rest are refused in the fixed words");
  assert.equal(refusals(results), 2, "each refusal is an error the model reads");
  assert.equal(w.requests.length, script.length, "the run went on to the model's answer: never ended by the budget");
  assert.equal(w.row.summary, null, `the run ended as answered: ${JSON.stringify(w.row)}`);
});

test("a round that crosses the budget runs its first calls up to it, and the rest of the round is refused", async (t) => {
  const script = [{ call: "read" }, { calls: [{ call: "read" }, { call: "read" }, { call: "read" }] }, { say: "done" }];
  const w = await budgetedRun(t, script, 2);
  assert.equal(w.ran.read, 2);
  assert.equal(refusals(resultsIn(w.requests)), 2);
});

test("no budget changes nothing: every call runs", async (t) => {
  const script = [{ call: "read" }, { call: "read" }, { calls: [{ call: "read" }, { call: "read" }] }, { say: "done" }];
  const w = await budgetedRun(t, script, undefined);
  assert.equal(w.ran.read, 4);
  assert.equal(refusals(resultsIn(w.requests)), 0);
});

// A nested call (one a running tool makes: a codemode script's, tools_call's) counts against the budget as a direct call
// does, and the call that makes it counts as one too. Past the budget it is refused unsent in the budget's words, and a
// script ends at the refusal (meta-tools.ts).
const FIVE_READS = "for (let i = 0; i < 5; i++) await tools.read({}); return 'all five';";
/** The tool_result rows of `tool` on the run's timeline, as a person reads them. */
const resultRows = async (server, tool) => (await runTimeline(server, "run-1", BACKGROUND_CONTEXT)).filter((row) => row.kind === "tool_result" && row.tool_name === tool);

test("codemode under a budget of 2: a script of five reads runs one (the codemode call and its first read are the 2), the second is refused unsent and ends the script, and the timeline says why", async (t) => {
  const w = await budgetedRun(t, [{ call: CODEMODE, args: { script: FIVE_READS } }, { say: "done" }], 2);
  assert.equal(w.ran.read, 1, "one nested read ran: no call past the budget was sent");
  const [said] = resultsIn(w.requests);
  assert.equal(said.isError, true);
  assert.ok(said.text.startsWith(TOOL_BUDGET_TEXT), `refused in the budget's words: ${said.text}`);
  assert.match(said.text, /The script stopped at this refused call, and nothing after it ran\./);
  assert.doesNotMatch(said.text, /all five/);
  const [row] = await resultRows(w.server, CODEMODE);
  assert.ok(row?.tool_result_preview?.includes(TOOL_BUDGET_TEXT), `the codemode row says why: ${JSON.stringify(row)}`);
});

test("tools_call under a budget of 3: the first call and its read are 2, the second tools_call is the 3rd and its read is refused unsent in the budget's words", async (t) => {
  const call = { call: TOOLS_CALL, args: { name: "read", args: {} } };
  const w = await budgetedRun(t, [call, call, { say: "done" }], 3, fillerTools());
  assert.equal(w.ran.read, 1, "one nested read ran");
  const results = resultsIn(w.requests);
  assert.deepEqual(results.map((result) => result.text), ["read", TOOL_BUDGET_TEXT], JSON.stringify(results));
  assert.equal(results[1].isError, true);
});

test("the budget is spent across direct and nested calls alike: a read, then a script (its first read the 3rd call), then a direct read past it", async (t) => {
  const script = [{ call: "read" }, { call: CODEMODE, args: { script: "await tools.read({}); await tools.read({}); await tools.read({}); return 'three';" } }, { call: "read" }, { say: "done" }];
  const w = await budgetedRun(t, script, 3);
  assert.equal(w.ran.read, 2, "the direct read and the script's first: the 1st and 3rd calls");
  const results = resultsIn(w.requests);
  assert.equal(results.length, 3, JSON.stringify(results));
  assert.equal(results[0].text, "read");
  assert.ok(results[1].text.startsWith(TOOL_BUDGET_TEXT), `the script's second read refused: ${results[1].text}`);
  assert.deepEqual(results[2], { text: TOOL_BUDGET_TEXT, isError: true }, "the direct read after the script: the budget is spent");
});

// A native tool that opens a conversation of its own (the way a subagent does: owned by its call's task, on the session's
// model, with the session's read tool), sends it "child task" and answers with its last words.
const CHILD = "child task";
const delegate = defineExtension({
  name: "test-delegate",
  tools: [
    defineTool({
      name: "delegate",
      description: "Hands a task to a conversation of its own.",
      parameters: { type: "object", properties: {} },
      replay: "safe",
      execute: async (_args, api, context) => {
        const parent = await api.agent(context);
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, { model: parent.model, tools: parent.tools.filter((tool) => tool.name === "read"), modelTools: null, instructions: "Follow the script." });
          return created.id;
        }, context);
        const handle = await api.conversation(child, context);
        const settled = await (await handle.submit({ type: "input", content: CHILD, requestId: `delegate:${String(api.taskId)}` }, context)).wait(context);
        const answer = settled.answer === undefined ? undefined : await api.commit((tx) => tx.entry(settled.answer), context);
        const said = answer?.model?.findLast((message) => message.role === "assistant")?.content?.map((part) => part.text ?? "").join("") ?? "";
        return { output: [{ type: "text", text: said }] };
      },
    }),
  ],
});

test("each conversation counts its own calls: a conversation a tool opens has a budget of its own", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const { tools, ran } = suiteTools();
  const requests = { root: [], child: [] };
  const root = scriptedOrigin([{ call: "read" }, { call: "delegate" }, { call: "read" }, { say: "root done" }], requests.root);
  const child = scriptedOrigin([{ call: "read" }, { call: "read" }, { call: "read" }, { say: "child done" }], requests.child);
  const isChild = (init) => JSON.stringify(JSON.parse(String(init.body)).messages?.[0] ?? {}).includes(CHILD);
  const fetch = (url, init) => (isChild(init) ? child(url, init) : root(url, init));
  const loop = createAdapterLoop((_claim, run) => ({
    adapter: piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch, price: () => 0, extensions: [delegate] }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks: quiet,
    gate: gateOf(2),
  }), { restartLimit: MAX_RESTARTS });
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await ended(server);
  // The root: read and delegate ran, its next read refused. The child: its own two reads ran, its third refused.
  assert.deepEqual(resultsIn(requests.root).map((result) => result.text), ["read", "child done", TOOL_BUDGET_TEXT]);
  assert.deepEqual(resultsIn(requests.child).map((result) => result.text), ["read", "read", TOOL_BUDGET_TEXT]);
  assert.equal(ran.read, 3);
});

test("the count holds across a claim moved to another runner: it is read from the journal, never kept in memory", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tool-budget-"));
  // The stores' clock: real time plus `clock.skewMs`, so the killed runner's claim runs out by moving the stores' now past
  // its until, never by waiting on a short real lease.
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const runnerStores = [await openSqliteStore({ dataDir: dir, role: "runner", now }), await openSqliteStore({ dataDir: dir, role: "runner", now })];
  const runners = [];
  const { tools, ran, letSlowGo, slowStarted } = suiteTools();
  t.after(async () => {
    letSlowGo();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const each of runnerStores) await each.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Budget" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const requests = [];
  const script = [{ call: "read" }, { call: "read" }, { call: "slow" }, { call: "read" }, { call: "read" }, { say: "done" }];
  const spec = piAdapterSpec({ script, tools, hooks: quiet }, { requests });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), gate: gateOf(3) }), { restartLimit: MAX_RESTARTS });
  // The first runner on a lease no stall outlasts, lost while its third call (slow) is out by the test's kill alone; the
  // second takes the run once the stores' clock passes the first's claim. On a short real lease a stall could lose the
  // first runner its claim before slow, and the claim it took again would be read here as the property's.
  runners.push(startRunner({ store: runnerStores[0], createLoop: loop, name: "runner-a", ...TIMING }));
  let slowOut = false;
  void slowStarted.then(() => (slowOut = true));
  await until(() => slowOut, "the first runner started slow", 20_000);
  runners[0].kill();
  clock.skewMs += STEADY_LEASE.leaseMs * 2;
  runners.push(startRunner({ store: runnerStores[1], createLoop: loop, name: "runner-b", ...TIMING }));
  await until(async () => (await server.runs.get("run-1")).runner === "runner-b", "the second runner took the run", 10_000);
  letSlowGo();
  for (const deadline = Date.now() + 30_000; ; await sleep(20)) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    assert.ok(Date.now() < deadline, `the run ended: ${JSON.stringify(row)}`);
  }
  assert.equal(ran.read, 2, "no read ran past the budget on the new claim");
  const results = resultsIn(requests);
  assert.deepEqual(results.slice(-2).map((result) => result.text), [TOOL_BUDGET_TEXT, TOOL_BUDGET_TEXT], JSON.stringify(results));
  assert.equal(requests.at(-1).messages.filter((message) => message.role === "assistant").length, script.length - 1, "the model answered last");
});

test("a script run again on another runner after a crash counts each nested call once: none twice, none lost", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tool-budget-nested-"));
  const clock = { skewMs: 0 };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const runnerStores = [await openSqliteStore({ dataDir: dir, role: "runner", now }), await openSqliteStore({ dataDir: dir, role: "runner", now })];
  const runners = [];
  const { tools, ran, letSlowGo, slowStarted } = suiteTools();
  t.after(async () => {
    letSlowGo();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const each of runnerStores) await each.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Budget" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const requests = [];
  // Budget 4: codemode (1), its read (2) and slow (3), cut by the crash; the script's rerun answers the read from its record
  // and ends at slow (its first call run again). Then the direct read is the 4th, and the next is refused: counted twice,
  // that read would be refused too; lost, the next would run.
  const script = [{ call: CODEMODE, args: { script: "await tools.read({}); await tools.slow({}); await tools.read({}); return 'all';" } }, { call: "read" }, { call: "read" }, { say: "done" }];
  const spec = piAdapterSpec({ script, tools, hooks: quiet }, { requests });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), gate: gateOf(4) }), { restartLimit: MAX_RESTARTS });
  runners.push(startRunner({ store: runnerStores[0], createLoop: loop, name: "runner-a", ...TIMING }));
  let slowOut = false;
  void slowStarted.then(() => (slowOut = true));
  await until(() => slowOut, "the first runner started slow", 20_000);
  runners[0].kill();
  clock.skewMs += STEADY_LEASE.leaseMs * 2;
  runners.push(startRunner({ store: runnerStores[1], createLoop: loop, name: "runner-b", ...TIMING }));
  await until(async () => (await server.runs.get("run-1")).runner === "runner-b", "the second runner took the run", 10_000);
  letSlowGo();
  for (const deadline = Date.now() + 30_000; ; await sleep(20)) {
    const row = await server.runs.get("run-1");
    if (row.state === "ended" && row.runner === null) break;
    assert.ok(Date.now() < deadline, `the run ended: ${JSON.stringify(row)}`);
  }
  assert.equal(ran.read, 2, "the script's first read, once, and the first direct read");
  const results = resultsIn(requests);
  assert.deepEqual(results.slice(-2).map((result) => result.text), ["read", TOOL_BUDGET_TEXT], JSON.stringify(results));
});

test("the API: a definition keeps max_tool_calls, an edit that leaves it out keeps it, 0 clears it; a bad one, a workflow's, and one on another harness are refused", async (t) => {
  const { api } = await serve(t, {});
  const made = await api("POST", "/agents", agent("budgeted", { max_tool_calls: 30 }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api("GET", "/agents/budgeted")).body.definition.max_tool_calls, 30);
  const edited = await api("PUT", "/agents/budgeted/definition", agent("budgeted", { version: 2, instructions: "Now this." }));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await api("GET", "/agents/budgeted")).body.definition.max_tool_calls, 30, "an edit that leaves it out keeps it");
  assert.equal((await api("PUT", "/agents/budgeted/definition", agent("budgeted", { version: 3, max_tool_calls: 0 }))).status, 200);
  assert.equal((await api("GET", "/agents/budgeted")).body.definition.max_tool_calls, undefined, "0 clears it");
  for (const bad of [-1, 1.5, "30", 1_001]) {
    const refused = await api("POST", "/agents", agent("bad", { max_tool_calls: bad }));
    assert.equal(refused.status, 422, JSON.stringify(bad));
    assert.ok(JSON.stringify(refused.body).includes("definition.max_tool_calls"), JSON.stringify(refused.body));
  }
  const flow = await api("POST", "/agents", flowAgent("flow", answerFlow(), { max_tool_calls: 5 }));
  assert.equal(flow.status, 422);
  assert.ok(JSON.stringify(flow.body).includes("definition.max_tool_calls"), JSON.stringify(flow.body));
  // On another harness the budget would hold nothing (its calls, and the calls its tools_call, codemode or Codex's own code
  // mode make, are not counted): the save is refused, never an agent whose runs go without it.
  for (const harness of ["claude-agent", "codex", "opencode"]) {
    const refused = await api("POST", "/agents", agent(`on-${harness}`, { harness, max_tool_calls: 5 }));
    assert.equal(refused.status, 422, `${harness}: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(refused.body.error.fields.map((field) => field.field), ["definition.max_tool_calls"], harness);
  }
});

const REVIEW = new URL("../templates/code-review/", import.meta.url).pathname;

/** The code-review package with its manifest's budget line replaced by `line`, read: the package, or its problems. */
async function packageWith(t, line) {
  const dir = join(await scratch(t), "code-review");
  mkdirSync(dir, { recursive: true });
  cpSync(REVIEW, dir, { recursive: true });
  const manifest = join(dir, "agent.md");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/^budget: .*$/m, line));
  try {
    return { p: readPackage(dir), problems: [] };
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return { problems: error.problems };
  }
}

test("a template's budget.tool_calls is the agent's max_tool_calls at apply; a bad one is refused", async (t) => {
  const { p } = await packageWith(t, "budget: { per_run_usd: 2.00, tool_calls: 30 }");
  assert.deepEqual(p.budget, { per_run_usd: 2, tool_calls: 30 });
  const made = compiled(p, { repo: "acme/widgets" }, { mcp: [], defaultTools: [], grants: [] });
  assert.equal(made.agent.definition.max_tool_calls, 30);
  assert.equal(made.agent.definition.max_cost_usd, 2);
  for (const line of ["budget: { per_run_usd: 2.00, tool_calls: 0 }", "budget: { per_run_usd: 2.00, tool_calls: 2.5 }", "budget: { per_run_usd: 2.00, calls: 3 }"]) {
    const { problems } = await packageWith(t, line);
    assert.ok(problems.some((problem) => /budget is \{per_run_usd\?/.test(problem)), `${line}: ${JSON.stringify(problems)}`);
  }
  // A package with triggers still needs its cap: a tool budget alone is not one.
  const { problems } = await packageWith(t, "budget: { tool_calls: 30 }");
  assert.ok(problems.some((problem) => /budget is required when the package has triggers/.test(problem)), JSON.stringify(problems));
});
