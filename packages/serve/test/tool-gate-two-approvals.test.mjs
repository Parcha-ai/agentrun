// Two calls in one pi run, each set to ask and answered in turn: an answer restates the run's rows at once (runs.ts
// restate), and the earlier call must still read in order then: its own rows (as any call's, once it ran), its approval row,
// then its resume row with the outcome. The rows an answer restates were rewritten once already (the resume row's text no
// longer starts with the gate's head), so the link from a resume row to its approval can't be read from that text.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, call, cookieOf, FAUX, follow, scratch, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };
const json = { "content-type": "application/json" };
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const NOTE = "not that page twice";

/** The owner's password session on `server`: an answer to an approval, as the console sends it. */
async function owner(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  return async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
}

/** The run's rows as served now, in seq order, with no wait for more. */
async function rowsNow(api, runId) {
  const { status, body } = await api("GET", `/runs/${runId}/timeline?wait_ms=0`);
  assert.equal(status, 200, JSON.stringify(body));
  return [...body.rows].sort((a, b) => a.seq - b.seq);
}

/** One parked call as a person reads it: its own rows say it was held, its approval row follows, then its resume row
 *  (the outcome, matched by `outcome`). */
function readsInOrder(rows, callId, outcome, at) {
  const shown = rows.map((r) => `${r.kind}: ${r.summary}`);
  const own = rows.flatMap((r, i) => ((r.kind === "tool_use" || r.kind === "tool_result") && r.tool_use_id === callId ? [i] : []));
  const ask = rows.findIndex((r) => r.kind === "tool_approval_requested" && r.tool_use_id === callId);
  // Its own outcome: the first after its approval row (two calls' outcomes may read the same).
  const resume = rows.findIndex((r, i) => i > ask && r.origin === "server" && outcome.test(r.summary ?? ""));
  assert.ok(own.length > 0 && ask > Math.max(...own), `${at}: the approval row follows the call's own rows: ${JSON.stringify(shown)}`);
  assert.ok(resume > ask, `${at}: the outcome (the resume row) follows the approval row: ${JSON.stringify(shown)}`);
  // One that ran reads as any call, its result saying how it came to run; one that did not run says only that it was held.
  const ran = /^AgentRun: \S+ ran( once you allowed it|, as its setting allows it)/.exec(rows[resume].summary ?? "");
  if (!ran) return assert.deepEqual(own.map((i) => rows[i].summary), own.map(() => "Held for your approval"), `${at}: the call's own rows say only that it was held: ${JSON.stringify(shown)}`);
  assert.ok(own.every((i) => rows[i].summary !== "Held for your approval"), `${at}: a call that ran is never "held": ${JSON.stringify(shown)}`);
  const result = own.map((i) => rows[i]).find((r) => r.kind === "tool_result");
  assert.ok(result?.summary.endsWith(`(${ran[1] === ", as its setting allows it" ? "ran, as its setting allows it" : "ran once you allowed it"})`), `${at}: its result row says how it came to run: ${JSON.stringify(shown)}`);
}

test("pi: two calls set to ask in one run, the first allowed, the second denied with a note: after the second answer, and at the run's end, the first still reads held, then its approval, then its outcome, and so does the second", { timeout: 150_000 }, async (t) => {
  const server = await serve(t, GATE);
  const { api } = server;
  const answer = await owner(server);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const go = join(await scratch(t), "go");
  // The second call waits for this file after the first result; made now, it follows the first answer at once.
  await writeFile(go, "");
  const ask = `Fetch http://public.example/ again once ${go} exists.`;
  assert.equal((await api("POST", "/agents", agent("twice", { harness: "pi", instructions: ask, tools: ["web_fetch"] }))).status, 201);
  const started = await api("POST", "/agents/twice/runs", { input: { content: ask } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  await follow(api, runId, ["input_required"], { deadlineMs: 55_000 });
  const first = (await api("GET", `/runs/${runId}`)).body.pending;
  assert.deepEqual([first?.kind, first?.tool], ["approval", "web_fetch"], "parked on the first call");
  assert.equal(await answer(runId, first.id, { decision: "allow" }), 204);

  // The second call parks: a pending approval that is not the first one.
  let second;
  const end = Date.now() + 55_000;
  for (;;) {
    const view = (await api("GET", `/runs/${runId}`)).body;
    if (view.status === "input_required" && view.pending?.kind === "approval" && view.pending.id !== first.id) { second = view.pending; break; }
    assert.ok(Date.now() < end, `the second call never parked: ${view.status} ${JSON.stringify(view.pending)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const firstCall = (await rowsNow(api, runId)).find((r) => r.kind === "tool_approval_requested" && r.summary?.includes("web_fetch"))?.tool_use_id;
  assert.ok(firstCall, "the first call's approval row is served");
  readsInOrder(await rowsNow(api, runId), firstCall, /^AgentRun: web_fetch ran once you allowed it/, "with the second call waiting");

  // The second answer restates the rows at once, before the run's process takes it up: read them straight away.
  assert.equal(await answer(runId, second.id, { decision: "deny", note: NOTE }), 204);
  readsInOrder(await rowsNow(api, runId), firstCall, /^AgentRun: web_fetch ran once you allowed it/, "right after the second answer");

  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const done = await rowsNow(api, runId);
  const asks = done.filter((r) => r.kind === "tool_approval_requested").map((r) => r.tool_use_id);
  assert.equal(asks.length, 2, `two approval rows: ${JSON.stringify(done.map((r) => `${r.kind}: ${r.summary}`))}`);
  readsInOrder(done, asks[0], /^AgentRun: web_fetch ran once you allowed it/, "the first call, at the run's end");
  readsInOrder(done, asks[1], new RegExp(`^AgentRun: You declined web_fetch: ${NOTE}$`), "the second call, at the run's end");
});

// One answer with two fetches at once (faux-model.mjs on pi, faux-harness.mjs on the CLIs): the run parks on the first;
// once it is allowed, on the second. The QA walk that found it put web_fetch's setting back to its default (allow) while
// the second waited: the next claim's gate read allow and ran the call without taking the person's allow, and the call
// that ran read "Not run: the run ended while it waited" and "Withdrawn when the run ended". An ask a person was shown
// stands until it is answered, and flipping the tool to allow answers it: the flip itself wakes the run (PUT
// /settings/tools), the call runs, the ask closes reading "Allowed by the tool's setting", and the person is never asked
// again, nor has to answer (a deny set since still refuses it).
for (const harness of ["pi", "claude-agent", "codex"]) {
  for (const putBack of [false, "woken"]) {
    test(`${harness}: two calls set to ask in ONE answer, ${putBack ? "the first allowed, then web_fetch's setting put back to allow while the second waits, which alone ends its wait" : "each allowed in turn"}: at the run's end each reads held, then its approval (asked, or allowed by the setting once it was put back, never withdrawn), then that it ran, its result the fetch's own`, { timeout: 150_000 }, (t) => bothAllowed(t, harness, putBack));
  }
}

// The run's effective permission is its pinned revision's: an agent whose own settings set web_fetch to ask still asks
// once the server's setting is put back to allow, so that flip wakes nothing (no claim: the run's epoch stays), and the
// waiting call runs on the person's own allow, its approval row reading asked.
for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`${harness}: web_fetch's server setting put back to allow while the second call waits, the agent's own setting still ask: the flip wakes nothing, and the call waits for the person's allow`, { timeout: 150_000 }, (t) => bothAllowed(t, harness, "agent-ask"));
}

for (const harness of ["pi"]) {
  test(`${harness}: a settings save that changes only a provider, while a call waits: no run is woken and no journal is read`, { timeout: 150_000 }, (t) => bothAllowed(t, harness, "provider-only"));
}

// The scan itself, over a counting store: a save that turns no tool toward allow lists no run and reads no journal; one that
// does reads only entries (no task, no submission scan) of the parked run.
test("a settings save that turns no tool toward allow reads no journal; one that does reads entries only", async () => {
  const { wakeAnsweredBySetting } = await import("../dist/settings-wake.js");
  const counts = { list: 0, scanEntries: 0, scanConversations: 0, scanTasks: 0, scanSubmissions: 0, wake: 0 };
  const page = (name, items = []) => async () => { counts[name] += 1; return { items }; };
  const journal = {
    scanConversations: page("scanConversations", [{ id: 1 }]),
    scanEntries: page("scanEntries", [{ id: 1, conversationId: 1, kind: "agentrun.ask", data: { callId: "c1", tool: "web_fetch", args: {}, requestedAt: "" } }]),
    scanTasks: page("scanTasks"),
    scanSubmissions: page("scanSubmissions"),
  };
  const store = {
    runs: { list: async () => { counts.list += 1; return [{ id: "r1", revisionId: "v1" }]; }, wake: async () => { counts.wake += 1; return true; } },
    agents: { revision: async () => ({ body: {} }) },
    readJournal: () => journal,
  };
  const read = (settings) => ({ settings, problems: [] });
  assert.deepEqual(await wakeAnsweredBySetting(store, read({ web_fetch: { permission: "ask" }, web_search: { provider: "off" } }), { web_fetch: { permission: "ask" } }), []);
  assert.deepEqual(counts, { list: 0, scanEntries: 0, scanConversations: 0, scanTasks: 0, scanSubmissions: 0, wake: 0 }, "a provider-only save read nothing");
  assert.deepEqual(await wakeAnsweredBySetting(store, read({ web_fetch: { permission: "allow" } }), { web_fetch: { permission: "ask" } }), ["r1"]);
  assert.deepEqual(counts, { list: 1, scanEntries: 1, scanConversations: 1, scanTasks: 0, scanSubmissions: 0, wake: 1 }, "an allow reads the entries alone");
});

// The reviewer's case: an MCP call parks under its exact key's ask with the server wildcard on deny (the deny stands behind the
// ask, so approvals "never" does not lift it). Changing only the wildcard to ask removes that block, so the call reads allow:
// a save that touched a permission must reach the gate, whichever key moved.
test("a save that moves only a server wildcard from deny to ask wakes a run whose exact-key ask waited behind it, approvals never", async () => {
  const { wakeAnsweredBySetting } = await import("../dist/settings-wake.js");
  let woken = 0;
  const page = (items = []) => async () => ({ items });
  const store = {
    runs: { list: async () => [{ id: "r1", revisionId: "v1" }], wake: async () => { woken += 1; return true; } },
    agents: { revision: async () => ({ body: { approvals: "never" } }) },
    readJournal: () => ({
      scanConversations: page([{ id: 1 }]),
      scanEntries: page([{ id: 1, conversationId: 1, kind: "agentrun.ask", data: { callId: "c1", tool: "mcp:fake/add", args: {}, requestedAt: "" } }]),
      scanTasks: page(),
      scanSubmissions: page(),
    }),
  };
  const read = (settings) => ({ settings, problems: [] });
  const before = { "mcp:fake/add": { permission: "ask" }, "mcp:fake/*": { permission: "deny" } };
  assert.deepEqual(await wakeAnsweredBySetting(store, read(before), before), [], "nothing changed: not woken");
  assert.deepEqual(await wakeAnsweredBySetting(store, read({ "mcp:fake/add": { permission: "ask" }, "mcp:fake/*": { permission: "ask" } }), before), ["r1"]);
  assert.equal(woken, 1);
});

// A person's deny already sent wins over the setting: the owner declines the second call, then web_fetch's setting goes
// back to allow, which wakes the run if it is still parked. Whichever claim reads the ask, the stored deny is its answer:
// the call is never run, and its rows say it was declined.
for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`${harness}: a call the person declined, web_fetch's setting put back to allow right after, is never run`, { timeout: 150_000 }, (t) => bothAllowed(t, harness, "declined"));
}

// A deny set on the server while a call waits for its person, then their allow: the deny refuses it, and its rows say so
// (never that the run ended while it waited), its allow kept on the record as the answer the deny overrode.
for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`${harness}: web_fetch set to deny on the server while the second call waits, then the person allows it: refused unrun, its rows saying the tool is now set to deny`, { timeout: 150_000 }, (t) => bothAllowed(t, harness, "denied-since"));
}

async function bothAllowed(t, harness, putBack) {
  const server = await serve(t, { faux: FAUX, harnessTable: fauxTable(fixture("faux-harness.mjs")), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true });
  const { api } = server;
  const answer = await owner(server);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const ask = "Fetch two pages at once and both fail, then stop.";
  const own = putBack === "agent-ask" ? { tool_settings: { web_fetch: { permission: "ask" } } } : {};
  assert.equal((await api("POST", "/agents", agent("both", harness === "pi" ? { tools: ["web_fetch"], ...own } : { harness, instructions: ask, tools: ["web_fetch"], ...own }))).status, 201);
  const started = await api("POST", "/agents/both/runs", { input: { content: ask } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  const pendingOther = async (than, what) => {
    for (const end = Date.now() + 55_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
      const view = (await api("GET", `/runs/${runId}`)).body;
      if (view.status === "input_required" && view.pending?.kind === "approval" && view.pending.id !== than) return view.pending;
      assert.ok(Date.now() < end, `${what}: ${view.status} ${JSON.stringify(view.pending)}`);
    }
  };
  const first = await pendingOther(undefined, "the run never parked on the first call");
  assert.equal(JSON.parse(first.args_preview).url, "http://a.example/", "parked on the first call");
  assert.equal(await answer(runId, first.id, { decision: "allow" }), 204);
  const second = await pendingOther(first.id, "the second call never parked on its own");
  assert.equal(JSON.parse(second.args_preview).url, "http://b.example/", "then on the second");
  const putBackNow = async () => assert.equal((await api("PUT", "/settings/tools", { web_fetch: {} })).status, 200);
  if (putBack === "declined") {
    assert.equal(await answer(runId, second.id, { decision: "deny", note: NOTE }), 204);
    await putBackNow();
  } else if (putBack === "woken") {
    // No answer: the flip alone ends the wait.
    await putBackNow();
  } else if (putBack === "provider-only") {
    // A save that turns no tool toward allow (web_fetch stays ask; only web_search's provider changes) wakes nothing.
    const before = await server.store.runs.get(runId);
    assert.equal(before.state, "parked", "parked on the second call, released");
    assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" }, web_search: { provider: "off" } })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = await server.store.runs.get(runId);
    assert.deepEqual([after.state, after.epoch], ["parked", before.epoch], "nothing woken: still parked, never claimed");
    assert.equal(await answer(runId, second.id, { decision: "allow" }), 204);
  } else if (putBack === "agent-ask") {
    const before = await server.store.runs.get(runId);
    assert.equal(before.state, "parked", "parked on the second call, released");
    await putBackNow();
    // Long past the runner's poll: a wake would have claimed it (its epoch moves at a claim) by now.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = await server.store.runs.get(runId);
    assert.deepEqual([after.state, after.epoch], ["parked", before.epoch], "the flip woke nothing: still parked, never claimed");
    const view = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([view.status, view.pending?.id], ["input_required", second.id], "still waiting on the person");
    assert.equal(await answer(runId, second.id, { decision: "allow" }), 204);
  } else if (putBack === "denied-since") {
    // web_fetch set to deny while the second call waits, then the person allows it: the deny wins.
    assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "deny" } })).status, 200);
    assert.equal(await answer(runId, second.id, { decision: "allow" }), 204);
  } else {
    assert.equal(await answer(runId, second.id, { decision: "allow" }), 204);
  }

  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const done = await rowsNow(api, runId);
  const shown = JSON.stringify(done.map((r) => `${r.kind}: ${r.summary}`));
  if (putBack === "denied-since") {
    const own = done.filter((r) => (r.kind === "tool_use" || r.kind === "tool_result") && r.tool_use_id === second.call_id);
    assert.ok(own.length > 0 && own.every((r) => r.summary === "Not run: its tool is now set to deny on this server"), `its own rows say the deny refused it: ${shown}`);
    assert.equal(own.find((r) => r.kind === "tool_result")?.refused, true, `its result row is marked refused: ${shown}`);
    assert.deepEqual(done.filter((r) => r.kind === "tool_approval_requested" && r.tool_use_id === second.call_id).map((r) => r.summary), [`Denied by the tool's setting on this server: web_fetch {"url":"http://b.example/"}`], `its approval row: ${shown}`);
    assert.ok(done.some((r) => r.kind === "phase" && r.summary === "AgentRun: You allowed web_fetch, but it is now set to deny on this server, so it was not run"), `its outcome names the allow and the deny: ${shown}`);
    assert.ok(!done.some((r) => /ENOTFOUND b\.example/.test(`${r.summary ?? ""} ${r.tool_result_preview ?? ""}`)), `it never ran: ${shown}`);
    assert.ok(!done.some((r) => /^(Not run: the run ended|Withdrawn)/.test(r.summary ?? "")), `never "ended while it waited" or withdrawn: ${shown}`);
    return;
  }
  if (putBack === "declined") {
    assert.ok(!done.some((r) => r.kind === "tool_result" && r.tool_use_id === second.call_id && r.summary !== "Held for your approval"), `the declined call never ran: ${shown}`);
    assert.ok(!done.some((r) => /ENOTFOUND b\.example|as its setting allows it/.test(`${r.summary ?? ""} ${r.tool_result_preview ?? ""}`)), `no row says it ran: ${shown}`);
    assert.ok(done.some((r) => r.kind === "phase" && new RegExp(`^AgentRun: You declined web_fetch: ${NOTE}$`).test(r.summary ?? "")), `its rows say it was declined: ${shown}`);
    return;
  }
  for (const [call, host] of [[first.call_id, "a.example"], [second.call_id, "b.example"]]) {
    const asked = done.filter((r) => r.kind === "tool_approval_requested" && r.tool_use_id === call);
    // The second call waited when the setting went back to allow: the setting answered its ask (the agent's own ask kept
    // it the person's).
    const bySetting = putBack === "woken" && call === second.call_id;
    const head = bySetting ? "Allowed by the tool's setting" : "Asked your approval";
    assert.deepEqual(asked.map((r) => r.summary), [`${head}: web_fetch {"url":"http://${host}/"}`], `${host}: its approval row reads ${head}, never withdrawn: ${shown}`);
    readsInOrder(done, call, bySetting ? /^AgentRun: web_fetch ran, as its setting allows it, and failed$/ : /^AgentRun: web_fetch ran once you allowed it, and failed$/, `${host}, at the run's end`);
    const result = done.find((r) => r.kind === "tool_result" && r.tool_use_id === call);
    assert.match(result?.tool_result_preview ?? "", new RegExp(`ENOTFOUND ${host.replace(".", "\\.")}`), `${host}: its result row is the fetch's own: ${shown}`);
  }
  assert.equal(done.filter((r) => r.kind === "phase" && /^AgentRun: web_fetch ran(?: once you allowed it|, as its setting allows it)/.test(r.summary ?? "")).length, 2, `one outcome row for each call: ${shown}`);
  // Asked once each: no second card for a call the setting answered.
  assert.equal(done.filter((r) => r.kind === "tool_approval_requested").length, 2, `one approval row for each call: ${shown}`);
  assert.ok(!done.some((r) => /^(Not run|Withdrawn)/.test(r.summary ?? "")), `no row says a call that ran was not run or withdrawn: ${shown}`);
}
