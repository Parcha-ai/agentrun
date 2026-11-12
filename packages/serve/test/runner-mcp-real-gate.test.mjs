// MCP calls through the runner's REAL gate (adapterRunGate → RunGate.decide, the revision's and the server's tool settings
// from the store), not a stand-in permission function: an agent's own `mcp:<server>/<tool>` deny and a server's
// `mcp:<server>/*` deny each refuse the call before its intent with the gate's words, by the tool's catalog name, and
// nothing reaches the MCP server; an ask parks the run named by the catalog name. On pi (its wire name mcp__fake__add) and
// on a CLI stand-in whose MCP client calls the session's door.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { saveToolSettings } = await import("../dist/tool-plane.js");
const { deniedText } = await import("../dist/refusal-words.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { mcpForClaim } = await import("../dist/runner/mcp-run.js");

test.after(() => closeOpenSessions());

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"runner-mcp-real-gate-bearer"}`;
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const ADD = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: object({ a: { type: "number" }, b: { type: "number" } }), annotations: { readOnlyHint: true } };
const listed = ({ inputSchema, ...tool }) => ({ ...tool, input_schema: inputSchema });
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const toolCalls = (fake) => fake.log.filter((entry) => entry.method === "tools/call");
const lastResult = (sent) => {
  const results = sent.flatMap((body) => body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "tool_result");
  const content = results.at(-1)?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
};

/** A CLI stand-in whose MCP client (Claude Code's call-id key) calls `add` at the session's door and keeps the answer. */
function mcpCli(seen) {
  const client = { callIdMeta: "claudecode/toolUseId" };
  return {
    id: "stand-in-cli",
    capabilities: () => ({ mcpClient: client }),
    check: () => [],
    async open(spec, io) {
      const proxy = await startModelProxy({
        policy: anthropicPolicy({ model: "claude-test", tools: [] }), hooks: io.models, model: "claude-test", origin: "https://faux.invalid",
        credential: async () => "not-a-secret-provider", ...(spec.mcp ? { mcp: { session: spec.mcp, client } } : {}),
      }, randomBytes(32).toString("base64url"));
      let state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "idle" : "new";
      let turn;
      return {
        get state() { return state; },
        async send(text) {
          if (text.startsWith("[tool approval] ")) {
            turn = (async () => (io.onEvent({ type: "turn_end", status: "completed" }), { status: "completed" }))();
            return;
          }
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          state = "idle";
          turn = (async () => {
            const response = await fetch(`${proxy.url}/mcp/fake`, {
              method: "POST",
              headers: { authorization: `Bearer ${proxy.key}`, "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { a: 2, b: 3 }, _meta: { [client.callIdMeta]: "toolu_real_gate_1" } } }),
            });
            seen.answer = (await response.json()).result;
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {}, async settleOpenTurn() { state = "idle"; }, turnEnd: () => turn, async interrupt() {},
        async close() { await proxy.close().catch(() => undefined); },
      };
    },
  };
}

/** A store with the fake MCP server as "fake", the agent's revision carrying `agentSettings` (its tool settings) on
 *  `harness`, the server's own tool settings `serverSettings`, and a runner whose gate is the real one (adapterRunGate). */
async function realGateRun(t, { harness, agentSettings = {}, serverSettings }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-real-gate-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const fake = await startFakeMcp({ token: TOKEN });
  let runner;
  t.after(async () => {
    await runner?.close();
    await fake.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.mcp.put({ name: "fake", url: fake.url, auth: "bearer", tools: [listed(ADD)], sealed: sealMcpCredential(KEY, "fake", { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } }, fake.url) });
  if (serverSettings) await saveToolSettings(server, serverSettings);
  await server.agents.create({ id: "agent-1", name: "Gate" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const revision = { kind: "agentic", body: { toolSettings: agentSettings, harness } };
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-real-gate-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const sent = [];
  const seen = {};
  const script = [{ call: "mcp__fake__add", args: { a: 1, b: 1 } }, { sayLastResult: true }];
  const base = harness === "pi" ? piAdapterSpec({ script, tools: {}, hooks: quiet }, { fetch: scriptedOrigin(script, sent) }) : undefined;
  const loop = createAdapterLoop(async (claim, run) => {
    const mcp = await mcpForClaim({ claim, store, sealKey: KEY, grants: ["mcp:fake/add"], harness: run.harness, work: () => work });
    const gate = await adapterRunGate(store, claim, revision, work);
    const own = harness === "pi"
      ? await base(claim, run)
      : { adapter: mcpCli(seen), session: { key: "root", label: "root", system: [], tools: [], context: "fresh" }, input: "Add them.", record: "loop", hooks: quiet, runCap: { capUsd: () => undefined, modelOf: () => undefined } };
    return { ...own, workRoot: work, gate, ...(mcp ? { mcp } : {}) };
  });
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...STEADY });
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if ((row.state !== "running" && row.state !== "queued" && row.runner === null) || Date.now() - from > 20_000) break;
    await sleep(20);
  }
  const entries = (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
  return { row, sent, seen, fake, entries };
}

/** The gate's words for a deny of `mcp:fake/add` set at `from` (RunGate.decide's deniedText, key and tool the catalog name). */
const deny = (from) => deniedText("mcp:fake/add", "mcp:fake/add", from, "no");

test("pi, through the real gate: the agent's own mcp:fake/add deny refuses the call in the gate's words by its catalog name, and nothing reaches the server", async (t) => {
  const { row, sent, fake } = await realGateRun(t, { harness: "pi", agentSettings: { "mcp:fake/add": { permission: "deny" } } });
  assert.equal(toolCalls(fake).length, 0, "nothing reached the MCP server");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(sent), deny("agent"));
});

test("a CLI, through the real gate: the agent's own mcp:fake/add deny refuses the call at the door in the gate's words, and nothing reaches the server", async (t) => {
  const { seen, fake } = await realGateRun(t, { harness: "claude-agent", agentSettings: { "mcp:fake/add": { permission: "deny" } } });
  assert.equal(toolCalls(fake).length, 0, "nothing reached the MCP server");
  assert.deepEqual(seen.answer, { content: [{ type: "text", text: deny("agent") }], isError: true });
});

test("pi, through the real gate: the server's mcp:fake/* deny refuses the call in the gate's words, and nothing reaches the server", async (t) => {
  const { row, sent, fake } = await realGateRun(t, { harness: "pi", serverSettings: { "mcp:fake/*": { permission: "deny" } } });
  assert.equal(toolCalls(fake).length, 0, "nothing reached the MCP server");
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(lastResult(sent), deny("server"));
});

test("pi, through the real gate: the agent's mcp:fake/add ask parks the run, its ask named by the catalog name, and nothing is sent", async (t) => {
  const { row, fake, entries } = await realGateRun(t, { harness: "pi", agentSettings: { "mcp:fake/add": { permission: "ask" } } });
  assert.equal(toolCalls(fake).length, 0, "nothing sent while it waits");
  assert.equal(row.state, "parked", JSON.stringify(row));
  assert.deepEqual(entries.filter((entry) => entry.kind === KINDS.ask).map((entry) => entry.data.tool), ["mcp:fake/add"]);
});
