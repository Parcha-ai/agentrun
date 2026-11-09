// Remote MCP tools on the runner for a harness with its own MCP client (AdapterCapabilities.mcpClient: Claude Code, Codex):
// the loop hands the session's MCP in the session's spec (runner/mcp-run.ts `session`), the kernel's model proxy mounts
// it once at `/mcp/<server>` from the adapter's client fact (startModelProxy's `mcp`), and the CLI's client calls it
// there with the session's key. Each call asks the loop's gate first (by its catalog name), then runs as the loop's host
// tool: its start and end on the run's record, the gateway sending it with the credential the CLI never sees. Here the
// CLI is a stand-in that speaks MCP to the real door as Claude Code's client does (`_meta["claudecode/toolUseId"]`).
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

const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { permissionOf } = await import("../dist/tool-gate.js");
const { cannotWait } = await import("../dist/mcp-gateway.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { TOOL_UNMETERED } = await import("@parcha/pi-durable-agent/timeline");

const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"runner-mcp-cli-bearer-for-the-scan"}`;
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const ADD = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: object({ a: { type: "number" }, b: { type: "number" } }), annotations: { readOnlyHint: true } };
const CALL_ID = "toolu_cli_1";
const STEADY = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** A CLI stand-in with its own MCP client (Claude Code's call-id key): its session's proxy mounts the session's MCP, and
 *  its one turn calls `add` there over HTTP, then says what the door answered. `seen` keeps what it was handed. */
function mcpCli(seen) {
  const client = { callIdMeta: "claudecode/toolUseId" };
  return {
    id: "stand-in-cli",
    capabilities: () => ({ mcpClient: client }),
    check: () => [],
    async open(spec, io) {
      seen.spec = spec;
      const proxy = await startModelProxy({
        policy: anthropicPolicy({ model: "claude-test", tools: [] }),
        hooks: io.models,
        model: "claude-test",
        origin: "https://faux.invalid",
        credential: async () => "not-a-secret-provider",
        ...(spec.mcp ? { mcp: { session: spec.mcp, client } } : {}),
      }, randomBytes(32).toString("base64url"));
      let state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "idle" : "new";
      let turn;
      return {
        get state() { return state; },
        async send() {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          state = "idle";
          turn = (async () => {
            const response = await fetch(`${proxy.url}/mcp/fake`, {
              method: "POST",
              headers: { authorization: `Bearer ${proxy.key}`, "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { a: 2, b: 3 }, _meta: { [client.callIdMeta]: CALL_ID } } }),
            });
            const body = await response.json();
            seen.answer = body.result;
            io.onEvent({ type: "text", delta: `It said ${body.result?.content?.[0]?.text}.` });
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() { await proxy.close().catch(() => undefined); },
      };
    },
  };
}

async function cliRun(t, { settings = {} } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mcp-cli-"));
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
  await server.mcp.put({ name: "fake", url: fake.url, auth: "bearer", tools: [ADD], sealed: sealMcpCredential(KEY, "fake", { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } }, fake.url) });
  await server.agents.create({ id: "agent-1", name: "Cli" }, { id: "rev-1", kind: "agentic", body: {} });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const seen = {};
  const lookup = { name: "lookup", description: "Look it up.", inputSchema: { type: "object" }, replay: "never", call: async () => ({ text: "found" }) };
  const loop = createAdapterLoop(() => ({
    adapter: mcpCli(seen),
    session: { key: "root", label: "root", system: [], tools: [lookup], context: "fresh" },
    input: "Add them.",
    record: "loop",
    hooks: quiet,
    gate: (call) => permissionOf(call.tool, settings),
    mcp: { grants: ["mcp:fake/add"], store, sealKey: KEY },
  }));
  runner = startRunner({ store, createLoop: loop, name: "runner-a", ...STEADY });
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if ((row.state !== "running" && row.state !== "queued" && row.runner === null) || Date.now() - from > 20_000) break;
    await sleep(20);
  }
  const entries = (await journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
  return { row, seen, fake, entries };
}

const toolCalls = (fake) => fake.log.filter((entry) => entry.method === "tools/call");

test("C1: the CLI's session carries the run's MCP, not its tools as host tools; an allowed call through the door answers, sent once with the credential the CLI never held, on the run's record", async (t) => {
  const { row, seen, fake, entries } = await cliRun(t, { settings: { "mcp:fake/add": { permission: "allow" } } });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(seen.spec.mcp.servers.map((server) => ({ name: server.name, tools: server.tools.map((tool) => tool.name) })), [{ name: "fake", tools: ["add"] }]);
  assert.deepEqual(seen.spec.tools.map((tool) => tool.name), ["lookup"], "the MCP tools are the CLI's own client's, not host tools");
  assert.equal(JSON.stringify(seen.spec).includes(TOKEN), false, "no credential in what the CLI was handed");
  assert.deepEqual(seen.answer, { content: [{ type: "text", text: "5" }] });
  assert.equal(toolCalls(fake).length, 1, "sent once");
  assert.equal(toolCalls(fake)[0].authorization, true, "with its credential");
  const start = entries.find((entry) => entry.kind === KINDS.callStart)?.data;
  const end = entries.find((entry) => entry.kind === KINDS.callEnd)?.data;
  assert.equal(start?.callId, CALL_ID, "the call's start on the run's record, by the CLI's own id");
  assert.equal(end?.status, "done");
  assert.equal(end?.output, "5");
  assert.deepEqual(entries.filter((entry) => entry.kind === TOOL_UNMETERED).map((entry) => entry.data.tool), ["mcp:fake/add"]);
});

test("C2: a call set to ask is answered that the harness can't wait for a person's approval yet: nothing sent, no approval left waiting", async (t) => {
  const { row, seen, fake, entries } = await cliRun(t);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(seen.answer, { content: [{ type: "text", text: cannotWait("mcp:fake/add") }], isError: true });
  assert.equal(toolCalls(fake).length, 0, "nothing sent");
  assert.deepEqual(entries.filter((entry) => entry.kind === KINDS.ask), [], "no ask written");
});

test("C3: a call set to deny is refused in the gate's words, nothing sent", async (t) => {
  const { seen, fake } = await cliRun(t, { settings: { "mcp:fake/add": { permission: "deny" } } });
  assert.deepEqual(seen.answer, { content: [{ type: "text", text: "Permission denied: mcp:fake/add is set to deny." }], isError: true });
  assert.equal(toolCalls(fake).length, 0, "nothing sent");
});
