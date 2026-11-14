// tools_search, tools_call and codemode (runner/meta-tools.ts): host tools over the run's own tools, offered on every
// harness. The search answers only tools the run may call (never one set to deny, never the three themselves); tools_call
// and a script's calls are each a call of their own, asked about at the gate as the tool they call, so a deny refuses the
// inner call in the gate's words and it never runs; a paid call made through them books once, under its own nested call
// id, on the run's one ledger, and the cap holds it as it holds the model's own. The script's sandbox has the tools and
// nothing else of the run. The model is a scripted origin and every tool local: nothing leaves this process.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cap, capRun } from "./adapter-pi-cap-support.mjs";
import { claudeAgentSpec, closeOpenSessions as closeClaude } from "./conformance-claude-agent.mjs";
import { closeOpenSessions as closeCodex, codexSpec } from "./conformance-codex.mjs";
import { closeOpenSessions as closeOpenCode, openCodeSpec } from "./conformance-opencode.mjs";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import { runnerGate, verdictOf } from "./gate-support.mjs";

const { CODEMODE, META_TOOLS, metaTools, refusedName, searchTools, TOOLS_CALL, TOOLS_SEARCH } = await import("../dist/runner/meta-tools.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { fillerTools, MAX_RESTARTS, suiteTools } = await import("../dist/runner/conformance/harness.js");
const { deniedText } = await import("../dist/refusal-words.js");
const { paidRequest, parallelSearchFee } = await import("../dist/paid-calls.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(async () => {
  for (const close of [closeOpenSessions, closeClaude, closeCodex, closeOpenCode]) await close();
});

const tool = (name, description, properties = {}) => ({ name, description, inputSchema: { type: "object", properties }, replay: "never", call: async () => ({ text: `${name} ran` }) });
const TOOLS = [
  tool("write_file", "Write text to a file in the workspace, replacing what it held.", { path: { description: "The file's path." } }),
  tool("web_search", "Search the web and answer the pages that match, with their links."),
  tool("send_email", "Send an email to an address."),
  tool("read_file", "Read a file of the workspace."),
];

test("tools_search answers only the run's tools it may call: a tool set to deny and the three themselves are never found", async () => {
  const denied = new Set(["send_email"]);
  const granted = async (name) => !denied.has(name);
  const all = [...TOOLS, tool(TOOLS_CALL, "Call a tool by name: send email, write file."), tool(CODEMODE, "Run a script that sends an email.")];
  const found = await searchTools("send an email", all, granted, 25);
  const names = found.map((one) => one.name);
  assert.ok(!names.includes("send_email"), `a denied tool is never found: ${JSON.stringify(names)}`);
  assert.ok(names.every((name) => !META_TOOLS.has(name)), `nor tools_call or codemode: ${JSON.stringify(names)}`);
  const write = await searchTools("write a file", TOOLS, granted);
  assert.equal(write[0]?.name, "write_file", `ranked by what a tool does (pi-durable's BM25): ${JSON.stringify(write.map((one) => one.name))}`);
  assert.deepEqual(write[0].input_schema, TOOLS[0].inputSchema, "with its input schema");
  const [search] = metaTools({ tools: () => all, granted, codemode: true, discovery: { search: true, call: true } });
  assert.equal(search.name, TOOLS_SEARCH);
  const answer = await search.call({ query: "email" }, { signal: new AbortController().signal });
  assert.doesNotMatch(answer.text, /send_email/, `the tool's own answer holds no denied tool: ${answer.text}`);
});

test("tools_call refuses, in words, a call of itself, of the other two, and of a name the run has no tool by: nothing runs", async () => {
  for (const name of [TOOLS_CALL, CODEMODE, TOOLS_SEARCH, "mcp__hands__codemode"]) assert.match(refusedName(TOOLS_CALL, name, TOOLS), /are called by the model itself, never through each other\. Nothing was run\./, name);
  assert.match(refusedName(TOOLS_CALL, "no_such_tool", TOOLS), /this run has no tool by that name.*Nothing was run\./);
  assert.equal(refusedName(TOOLS_CALL, "mcp__hands__write_file", TOOLS), undefined, "a harness's name for a run's tool is that tool");
  const calls = [];
  const nested = { call: async (name, args, key) => (calls.push([name, key]), { text: "ran", fresh: true }), memo: async (_key, value) => value };
  const [, call] = metaTools({ tools: () => TOOLS, granted: async () => true, codemode: true, discovery: { search: true, call: true } });
  const refused = await call.call({ name: CODEMODE, args: {} }, { signal: new AbortController().signal, nested });
  assert.equal(refused.isError, true);
  assert.deepEqual(calls, [], "nothing was called");
  const ran = await call.call({ name: "hands_write_file", args: { path: "a" } }, { signal: new AbortController().signal, nested });
  assert.equal(ran.text, "ran");
  assert.deepEqual(calls, [["write_file", "call"]], "called nested, by the tool's own name, under the key `call`");
  const without = await call.call({ name: "write_file" }, { signal: new AbortController().signal });
  assert.match(without.text, /no way to call the run's tools/, "a harness that gives no nested calls refuses it, never runs it bare");
});

test("a codemode script sees the run's tools and nothing else of the run: no process, require, fetch, environment or timers", async () => {
  const nested = { call: async () => ({ text: "ran", fresh: true }), memo: async (_key, value) => value };
  const [, , codemode] = metaTools({ tools: () => TOOLS, granted: async () => true, codemode: true, discovery: { search: true, call: true } });
  const script = "return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.env, typeof tools.write_file, ALL_TOOLS.map((one) => one.name).includes('tools_call')];";
  const answer = await codemode.call({ script }, { signal: new AbortController().signal, nested });
  assert.equal(answer.isError, undefined, answer.text);
  assert.deepEqual(answer.structured, ["undefined", "undefined", "undefined", "undefined", "undefined", "function", false], answer.text);
});

test("a script reads a nested call's value: its structured value, else its one text part parsed when that is a JSON object or array, else its text", async () => {
  // As Composio answers through MCP: one text part holding a JSON object.
  const answers = {
    write_file: { text: JSON.stringify({ default_branch: "main", stars: 0 }) },
    web_search: { text: '[{"url":"https://example.test"}]' },
    send_email: { text: "sent", structured: { id: "m-1" } },
    read_file: { text: '"just a string"' },
  };
  const nested = { call: async (name) => ({ ...answers[name], fresh: true }), memo: async (_key, value) => value };
  const [, , codemode] = metaTools({ tools: () => TOOLS, granted: async () => true, codemode: true, discovery: { search: true, call: true } });
  const script = "const r = await tools.write_file({});\nconst s = await tools.web_search({});\nconst m = await tools.send_email({});\nconst f = await tools.read_file({});\nreturn [`${r.default_branch} branch, ${r.stars} stars`, s[0].url, m.id, f, typeof (await tools.write_file({}))];";
  const answer = await codemode.call({ script }, { signal: new AbortController().signal, nested });
  assert.equal(answer.isError, undefined, answer.text);
  assert.deepEqual(answer.structured, ["main branch, 0 stars", "https://example.test", "m-1", '"just a string"', "object"], answer.text);
  const [, call] = metaTools({ tools: () => TOOLS, granted: async () => true, codemode: true, discovery: { search: true, call: true } });
  const direct = await call.call({ name: "write_file", args: {} }, { signal: new AbortController().signal, nested });
  assert.equal(direct.text, answers.write_file.text, "the text the model reads is the call's text, unchanged");
});

/** A pi run of `script` over the suite's tools, its gate `gate(call)`: what each suite tool ran, and the last tool result. */
async function gatedRun(t, script, gate) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const { tools, ran } = suiteTools();
  const requests = [];
  const spec = piAdapterSpec({ script, tools: { ...tools, ...fillerTools() }, hooks: quiet }, { requests });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), gate }));
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended", 30_000);
  return { ran, said: lastResult(requests) };
}

/** The text of the newest tool result the provider got. */
function lastResult(requests) {
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  const content = results.at(-1)?.content;
  return { text: typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), isError: results.at(-1)?.is_error === true };
}

const denyEffect = (call) => (call.tool === "effect" ? "deny" : "allow");

test("tools_call is held to the setting of the tool it calls: effect set to deny refuses the call in the gate's words, and it never runs", async (t) => {
  const { ran, said } = await gatedRun(t, [{ call: TOOLS_CALL, args: { name: "effect", args: {} } }, { say: "done" }], denyEffect);
  assert.equal(ran.effect, 0, "effect never ran");
  assert.equal(said.isError, true);
  assert.equal(said.text, deniedText("effect", undefined, "server", "no"), "refused in the gate's words for effect");
});

test("a codemode script's call of a tool set to deny ends the script in the gate's words: the calls before it ran, none after it", async (t) => {
  const script = "await tools.read({}); await tools.effect({}); await tools.read({}); return 'all done';";
  const { ran, said } = await gatedRun(t, [{ call: CODEMODE, args: { script } }, { say: "done" }], denyEffect);
  assert.deepEqual([ran.read, ran.effect], [1, 0], `read ran once, effect never: ${JSON.stringify(ran)}`);
  assert.equal(said.isError, true);
  assert.ok(said.text.startsWith(deniedText("effect", undefined, "server", "no")), said.text);
  assert.match(said.text, /The script stopped at this refused call, and nothing after it ran\./);
  assert.match(said.text, /1\. read completed/);
  assert.doesNotMatch(said.text, /all done/);
});

/** Each paid runner.request in run-1's records (its model "paid:<name>"), every session read. */
async function paidRequestsOf(store) {
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
  const { journalSessions } = await import("../dist/runner/sessions.js");
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    const out = [];
    for (const key of await sessions.keys()) {
      for (const record of await sessions.read(key)) if (record.kind === "runner.request" && String(record.data?.model ?? "").startsWith("paid:")) out.push(record.data);
    }
    return out;
  } finally {
    await harness.close(ctx);
  }
}

/** The harnesses a paid call through the three is booked on, each its suite subject's spec (Codex: no codemode).
 *  `afterTurn`: the subject's model requests come in its script's order, so the request after the call is asked with
 *  the call's spend (claude-agent's stand-in CLI times its own requests: only its booking is read). */
const HARNESSES = [
  { name: "pi", specOf: piAdapterSpec, codemode: true, discovery: true, afterTurn: true },
  { name: "claude-agent", specOf: claudeAgentSpec, codemode: true, discovery: false, afterTurn: false },
  { name: "opencode", specOf: openCodeSpec, codemode: true, discovery: true, afterTurn: true },
  { name: "codex", specOf: codexSpec, codemode: false, discovery: true, afterTurn: true },
];

/** An uncapped `harness` run of `script` whose tool `search` makes one paid Parallel search answered 200: the spend each
 *  model request was asked with, how many searches were sent, and the paid requests on the run's records. */
async function paidRun(t, script, harness = HARNESSES[0]) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-meta-paid-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Paid" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  let sent = 0;
  const search = { name: "search", replaySafe: false, run: async () => `searched (${(await paidRequest(parallelSearchFee(10), async () => (sent++, new Response("{}", { status: 200 })))).status})` };
  const asked = [];
  const spec = harness.specOf({ script, tools: { search, ...fillerTools() }, hooks: quiet });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), runCap: { capUsd: () => undefined, modelOf: () => undefined, judged: (request) => void asked.push(request.spentUsd) } }), { restartLimit: MAX_RESTARTS });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  await until(async () => {
    const row = await server.runs.get("run-1");
    return row.state === "ended" && row.runner === null && row;
  }, "the run ended", 30_000);
  return { asked, sent, requests: await paidRequestsOf(store) };
}

for (const harness of HARNESSES) {
  if (harness.discovery) test(`${harness.name}: a paid call made through tools_call books once, under its own nested call id, as the model's direct call books`, async (t) => {
    const { asked, sent, requests } = await paidRun(t, [{ call: TOOLS_CALL, args: { name: "search", args: {} } }, { say: "done" }], harness);
    assert.equal(sent, 1, "sent once");
    assert.equal(requests.length, 1, `one paid request on the run's records: ${JSON.stringify(requests)}`);
    assert.match(requests[0].call, /\/call$/, `booked under the nested call's id: ${requests[0].call}`);
    if (harness.afterTurn) assert.ok(Math.abs(asked.at(-1) - 0.001) < 1e-12, `the next request is asked with its $0.001: ${JSON.stringify(asked)}`);
  });

  if (!harness.codemode) continue;
  test(`${harness.name}: a codemode script's two paid calls book once each, each under its own nested call id: the run's spend is both`, async (t) => {
    const { asked, sent, requests } = await paidRun(t, [{ call: CODEMODE, args: { script: "await tools.search({}); await tools.search({}); return 'two';" } }, { say: "done" }], harness);
    assert.equal(sent, 2, "each call sent once");
    assert.equal(requests.length, 2, `two paid requests: ${JSON.stringify(requests)}`);
    const ids = requests.map((request) => request.call);
    assert.ok(ids.every((id) => /\/s\d+$/.test(id)) && new Set(ids).size === 2, `each under its own nested id: ${JSON.stringify(ids)}`);
    if (harness.afterTurn) assert.ok(Math.abs(asked.at(-1) - 0.002) < 1e-12, `the next request is asked with both: ${JSON.stringify(asked)}`);
  });
}

test("under a cap with room for one paid search, a script's second search is refused unsent and the run parks: the cap never overspends", async (t) => {
  const capUsd = 0.0015;
  const FREE = { id: "claude-sonnet-5-5", api: "anthropic-messages", price: { input: 0, output: 0 }, outputCeiling: 8_192 };
  let sent = 0;
  const said = [];
  const script = [{ call: CODEMODE, args: { script: "const a = await tools.pay({}); const b = await tools.pay({}); return [a, b];" } }, { say: "done" }];
  const specOf = (requests) => async (claim, run) => {
    const pay = {
      name: "pay",
      replaySafe: false,
      run: async () => {
        try {
          const text = `searched (${(await paidRequest(parallelSearchFee(10), async () => (sent++, new Response("{}", { status: 200 })))).status})`;
          said.push(text);
          return text;
        } catch (error) {
          said.push(String(error?.message ?? error));
          return String(error?.message ?? error);
        }
      },
    };
    return piAdapterSpec({ script, tools: { pay, ...fillerTools() }, hooks: quiet }, { fetch: scriptedOrigin(script, requests) })(claim, run);
  };
  const runCap = { capUsd, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf };
  const { row } = await capRun(t, { script, specOf, cap: runCap, runCap: { capUsd: () => capUsd, modelOf: () => FREE } });
  assert.equal(sent, 1, `only the first search was sent: ${JSON.stringify(said)}`);
  assert.match(said[1] ?? "", /could cost up to \$0\.001/, `the second was refused in the cap's words: ${JSON.stringify(said)}`);
  assert.equal(row.state, "parked", `the run parked on the refused call: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A `harness` run of `script` over `tools` (each `{name, replaySafe, run, structured?, images?}`), uncapped, ended: what
 *  the model said, in order, and the requests pi's provider got (pi only, `requests`). `native`: pi-native tools. */
async function metaRun(t, harness, script, own, { native } = {}) {
  const tools = { ...own, ...fillerTools() };
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const requests = [];
  const spec = harness.name === "pi" ? piAdapterSpec({ script, tools, hooks: quiet }, { requests, ...(native ? { native } : {}) }) : harness.specOf({ script, tools, hooks: quiet });
  const runner = startRunner({ store, createLoop: createAdapterLoop(spec, { restartLimit: MAX_RESTARTS }), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return (now.state === "ended" || now.state === "failed") && now.runner === null && now;
  }, "the run ended", 30_000);
  const { entries } = await journalRecords(server.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  return { row, said: messagesOf(entries).filter((message) => message.role === "model").map((message) => message.text), requests, server };
}

for (const harness of HARNESSES) {
  test(`${harness.name}: tools_call${harness.codemode ? " and a codemode script each leave" : " leaves"} a row of their own on the timeline, the calls they made after it`, async (t) => {
    const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
    const { runTimeline } = await import("../dist/store-reads/journal.js");
    const add = { name: "add", replaySafe: false, run: async () => "5" };
    // One run each: a scripted CLI stand-in makes its script's first call alone.
    // (Claude Code defers MCP tools itself, so it is never offered tools_call.)
    const runs = [...(harness.discovery ? [[TOOLS_CALL, { name: "add", args: {} }]] : []), ...(harness.codemode ? [[CODEMODE, { script: "await tools.add({}); await tools.add({}); return 'two';" }]] : [])];
    for (const [name, args] of runs) {
      const { row, server } = await metaRun(t, harness, [{ call: name, args }, { say: "done" }], { add });
      assert.equal(row.state, "ended", JSON.stringify(row));
      const rows = (await runTimeline(server, "run-1", ctx)).filter((one) => one.kind === "tool_use" || one.kind === "tool_result");
      const shown = JSON.stringify(rows.map((one) => [one.kind, one.tool_name, one.tool_use_id, one.summary]));
      const [call, ...more] = rows.filter((one) => one.kind === "tool_use" && one.tool_name === name);
      assert.ok(call, `${name} has its own row: ${shown}`);
      assert.equal(more.length, 0, `once: ${shown}`);
      assert.ok(rows.some((one) => one.kind === "tool_result" && one.tool_use_id === call.tool_use_id && one.tool_status === "success"), `${name}'s result row: ${shown}`);
      // Where the harness shows the nested calls (a CLI's record keeps each as its own tool's), each reads after the row
      // of the call that made it.
      for (const nested of rows.filter((one) => one.kind === "tool_use" && one.tool_name === "add")) {
        assert.ok(nested.tool_use_id.startsWith(`${call.tool_use_id}/`) && rows.indexOf(call) < rows.indexOf(nested), `${nested.tool_use_id} reads after its call's row: ${shown}`);
      }
    }
  });
}

for (const harness of HARNESSES.filter((one) => one.codemode)) {
  test(`${harness.name}: a codemode script's call answers the tool's value, not its text`, async (t) => {
    const shot = { name: "shot", replaySafe: true, structured: { n: 7, kind: "shot" }, run: async () => "a shot, as text" };
    const script = [{ call: CODEMODE, args: { script: "const v = await tools.shot({}); return typeof v === 'object' && v !== null ? 'n=' + v.n : 'text:' + v;" } }, { sayLastResult: true }];
    const { row, said } = await metaRun(t, harness, script, { shot });
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.match(said.join("\n"), /n=7/, `the script read the tool's value: ${JSON.stringify(said)}`);
  });
}

test("pi: a tool's image called through tools_call reaches the model, as a direct call's does", async (t) => {
  const shot = { name: "shot", replaySafe: true, images: [{ data: PNG, mimeType: "image/png" }], run: async () => "the screen" };
  const { row, requests } = await metaRun(t, HARNESSES[0], [{ call: TOOLS_CALL, args: { name: "shot", args: {} } }, { say: "done" }], { shot });
  assert.equal(row.state, "ended", JSON.stringify(row));
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  const parts = Array.isArray(results.at(-1)?.content) ? results.at(-1).content : [];
  assert.ok(parts.some((part) => part.type === "image" && part.source?.data === PNG), `the image is in tools_call's result: ${JSON.stringify(parts).slice(0, 400)}`);
  assert.ok(parts.some((part) => part.type === "text" && part.text === "the screen"), "with its text");
});

test("pi: a pi-native tool of the run (as the subagent tool is) is found by tools_search and called by tools_call", async (t) => {
  const { defineTool } = await import("@earendil-works/pi-durable");
  let ran = 0;
  const helper = defineTool({
    name: "helper_tool",
    description: "A native helper that tallies the oranges in the basket.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => (ran++, { output: [{ type: "text", text: "helper ran" }] }),
  });
  const script = [{ call: TOOLS_SEARCH, args: { query: "tally oranges" } }, { call: TOOLS_CALL, args: { name: "helper_tool", args: {} } }, { sayLastResult: true }];
  const { tools } = suiteTools();
  const { row, said, requests } = await metaRun(t, HARNESSES[0], script, tools, { native: [helper] });
  assert.equal(row.state, "ended", JSON.stringify(row));
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  const text = (part) => (typeof part?.content === "string" ? part.content : (part?.content ?? []).map((one) => one.text ?? "").join(""));
  assert.match(text(results[0]), /"name":\s*"helper_tool"/, `tools_search found the native tool: ${text(results[0])}`);
  assert.equal(ran, 1, "tools_call ran it once");
  assert.match(said.join("\n"), /helper ran/, `its answer is tools_call's: ${JSON.stringify(said)}`);
});

test("a run's catalog tools are deferred only past DEFER_CATALOG_OVER of them: the name decides, and the three are never counted", async () => {
  const { DEFER_CATALOG_OVER, defersCatalog } = await import("@parcha/agentrun-kernel");
  const mcp = (count) => Array.from({ length: count }, (_, index) => `mcp__probe__tool_${index}`);
  assert.equal(DEFER_CATALOG_OVER, 20);
  assert.equal(defersCatalog(["read", "write", "edit", "bash", "web_fetch"]), false, "built-ins only");
  assert.equal(defersCatalog(["read", ...mcp(1)]), false, "one MCP tool");
  assert.equal(defersCatalog(["monid_discover", "monid_inspect", "monid_run"]), false, "monid's three");
  assert.equal(defersCatalog(mcp(DEFER_CATALOG_OVER)), false, "exactly the threshold: not yet");
  assert.equal(defersCatalog(mcp(DEFER_CATALOG_OVER + 1)), true, "past it");
  assert.equal(defersCatalog([...mcp(DEFER_CATALOG_OVER - 3), "monid_discover", "monid_inspect", "monid_run", "monid_run2"].slice(0, 22)), true, "monid's tools count toward it");
  const many = Array.from({ length: 40 }, (_, index) => `tool_${index}`);
  assert.equal(defersCatalog(many), false, "built-in tools never defer, however many");
});

/** A pi run's first model request's tool names, for `tools` (the session's, `{name, replaySafe, run}`) under `gate`, and what ran. */
async function listedRun(t, script, tools, gate = Object.assign(() => "allow", { permission: async () => "allow" })) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const requests = [];
  const spec = piAdapterSpec({ script, tools, hooks: quiet }, { requests });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), gate }), { restartLimit: MAX_RESTARTS });
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => {
    const now = await server.runs.get("run-1");
    return (now.state === "ended" || now.state === "failed") && now.runner === null && now;
  }, "the run ended", 30_000);
  const offered = (body) => (body?.tools ?? []).map((tool) => tool.name).sort();
  return { offered: offered(requests[0]), requests, result: lastResult(requests) };
}

const catalog = (count, ran) => Object.fromEntries(Array.from({ length: count }, (_, index) => {
  const name = `mcp__probe__tool_${index}`;
  return [name, { name, replaySafe: true, ask: false, description: `Probe ${index}: ${index === 3 ? "weigh the oranges" : "does nothing in particular"}.`, run: async () => (ran?.push(name), `${name} ran`) }];
}));

test("a run with a few catalog tools lists every tool and offers no tools_search or tools_call", async (t) => {
  const { offered } = await listedRun(t, [{ say: "done" }], { read: { name: "read", replaySafe: true, run: async () => "r" }, ...catalog(3) });
  assert.deepEqual(offered, ["codemode", "mcp__probe__tool_0", "mcp__probe__tool_1", "mcp__probe__tool_2", "read"], "all listed; codemode as always");
});

test("a run over the threshold does not list its catalog tools: tools_search finds one, tools_call runs it as that tool, and a gate's deny of it refuses it", async (t) => {
  const ran = [];
  const tools = { read: { name: "read", replaySafe: true, run: async () => "r" }, ...catalog(25, ran) };
  const script = [{ call: TOOLS_SEARCH, args: { query: "weigh oranges" } }, { call: TOOLS_CALL, args: { name: "mcp__probe__tool_3", args: {} } }, { sayLastResult: true }];
  const { offered, result } = await listedRun(t, script, tools);
  assert.deepEqual(offered, [CODEMODE, "read", TOOLS_CALL, TOOLS_SEARCH].sort(), "the catalog tools are not listed; the built-in is, with search, call and codemode");
  assert.deepEqual(ran, ["mcp__probe__tool_3"], "tools_call ran the tool search found, once");
  assert.match(result.text, /mcp__probe__tool_3 ran/);
  const denied = [];
  const gate = Object.assign((call) => (call.tool === "mcp__probe__tool_3" ? { deny: "no catalog tool 3" } : "allow"), { permission: async () => "allow" });
  const refused = await listedRun(t, script, { read: tools.read, ...catalog(25, denied) }, gate);
  assert.deepEqual(denied, [], "asked about as the inner tool, a deny refused it: it never ran");
  assert.match(refused.result.text, /no catalog tool 3/);
});

test("a tool whose setting is deny is never found by tools_search", async (t) => {
  const tools = { read: { name: "read", replaySafe: true, run: async () => "r" }, ...catalog(25) };
  const gate = Object.assign(() => "allow", { permission: async (name) => (name === "mcp__probe__tool_3" ? "deny" : "allow") });
  const { result } = await listedRun(t, [{ call: TOOLS_SEARCH, args: { query: "probe", limit: 25 } }, { sayLastResult: true }], tools, gate);
  assert.doesNotMatch(result.text, /tool_3\b/, "the denied tool is not among the matches");
  assert.match(result.text, /mcp__probe__tool_4/, "the others are");
});

test("codemode, tools_search and tools_call each have a setting: allow unless an owner sets deny, and a denied one is not offered at all", async (t) => {
  const tools = { read: { name: "read", replaySafe: true, run: async () => "r" }, ...catalog(25) };
  const without = (denied) => Object.assign(() => "allow", { permission: async (name) => (name === denied ? "deny" : "allow") });
  assert.deepEqual((await listedRun(t, [{ say: "done" }], tools, without(CODEMODE))).offered, ["read", TOOLS_CALL, TOOLS_SEARCH].sort());
  // With either helper denied the model could not both find and run what was hidden, so nothing is hidden: every catalog
  // tool is listed and neither helper is offered (denying a helper never takes an allowed tool out of reach).
  const all = [CODEMODE, ...Object.keys(tools)].sort();
  assert.deepEqual((await listedRun(t, [{ say: "done" }], tools, without(TOOLS_SEARCH))).offered, all);
  assert.deepEqual((await listedRun(t, [{ say: "done" }], tools, without(TOOLS_CALL))).offered, all);
});

test("the gate: each of the three allows unless its own setting is deny, then a call to it is refused in the gate's words; pi's computer codemode stays the kind's", async () => {
  const gate = (settings, where) => runnerGate({ settings, harness: "pi", ...where });
  for (const name of [CODEMODE, TOOLS_SEARCH, TOOLS_CALL]) {
    assert.equal(await verdictOf(gate({}), name), "allow", `${name}: allow by default`);
    assert.equal(await verdictOf(gate({ [name]: { permission: "allow" } }), name), "allow");
    const denied = gate({ [name]: { permission: "deny" } });
    assert.equal(await denied.policy(name), "deny", `${name}: its setting is read`);
    assert.match(await verdictOf(denied, name), /denied|not run|refused|deny/i, `${name}: a call is refused`);
    assert.equal(await verdictOf(denied, `mcp__hands__${name}`), await verdictOf(denied, name), `${name}: claude-agent's name for it reads the same key`);
    const others = [CODEMODE, TOOLS_SEARCH, TOOLS_CALL].filter((one) => one !== name);
    for (const other of others) assert.equal(await verdictOf(denied, other), "allow", `${name}'s setting does not hold ${other}`);
  }
});

test("tools_search, tools_call and codemode are tool-settings keys: allow or deny, never ask", async () => {
  const { settingsIssues } = await import("../dist/tool-plane.js");
  for (const name of [CODEMODE, TOOLS_SEARCH, TOOLS_CALL]) {
    assert.deepEqual(settingsIssues({ [name]: { permission: "deny" } }), [], `${name}: deny is a setting`);
    assert.deepEqual(settingsIssues({ [name]: { permission: "allow" } }), []);
    assert.equal(settingsIssues({ [name]: { permission: "ask" } }).length, 1, `${name}: ask is not offered`);
  }
});

for (const harness of HARNESSES.filter((one) => one.discovery)) {
  test(`${harness.name}: a catalog tool of a deferred run is not listed to the model, and tools_call runs it by name`, async (t) => {
    const { row, said } = await metaRun(t, harness, [{ call: TOOLS_CALL, args: { name: "mcp__idle__tool_0", args: {} } }, { sayLastResult: true }], {});
    assert.equal(row.state, "ended", JSON.stringify(row));
    assert.match(said.join("\n"), /idle/, `the deferred tool ran: ${JSON.stringify(said)}`);
  });
}
