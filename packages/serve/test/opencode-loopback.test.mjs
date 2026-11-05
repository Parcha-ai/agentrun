// The OpenCode adapter's servers listen on 127.0.0.1 only, as the key-gate markers on their addresses say: the adapter's
// MCP server, and `opencode serve` as the adapter starts it (the stand-in, given the adapter's own server arguments, and
// the pinned binary). A connection to this host's non-loopback address is refused; one to 127.0.0.1 is answered.
// Without a non-loopback IPv4 address on this host there is nothing to try, and the tests say so. The pinned-binary test
// skips without the binary; with AGENTRUN_OPENCODE_REQUIRE_BINARY=1 it fails instead.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { openCodeAdapter } from "../dist/harness-opencode/index.js";
import { findOpenCode } from "../dist/harness-opencode/binary.js";
import { startMcpServer } from "../dist/harness-opencode/host/mcp.js";
import { verifyOpenCodeBinary } from "../dist/harness-opencode/verify.js";

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "agentrun-opencode-loopback-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** This host's first non-loopback IPv4 address, if it has one. */
const OUTSIDE = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
const noOutside = OUTSIDE ? false : "this host has no non-loopback IPv4 address to try a connection on";
const pinned = verifyOpenCodeBinary(findOpenCode());
const noBinary = pinned instanceof Error && process.env.AGENTRUN_OPENCODE_REQUIRE_BINARY !== "1" ? pinned.message : false;

/** Whether a TCP connection to `host:port` is answered within 3 s. */
const answers = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port });
  const done = (ok) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(3000, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
});

/** That `url`'s server answers on 127.0.0.1 and refuses this host's non-loopback address, on the same port. */
async function loopbackOnly(what, url) {
  const port = Number(new URL(url).port);
  assert.ok(port > 0, `${what} has a port: ${url}`);
  assert.equal(new URL(url).hostname, "127.0.0.1", `${what} is reached at 127.0.0.1`);
  assert.equal(await answers("127.0.0.1", port), true, `${what} answers on 127.0.0.1:${port}`);
  assert.equal(await answers(OUTSIDE, port), false, `${what} refuses ${OUTSIDE}:${port}, this host's non-loopback address`);
}

test("the adapter's MCP server listens on 127.0.0.1 only: this host's non-loopback address is refused", { skip: noOutside }, async (t) => {
  const mcp = await startMcpServer({ tools: [], key: "session-key-not-a-secret", call: async () => ({ text: "", isError: false }) });
  t.after(() => mcp.close());
  await loopbackOnly("the MCP server", mcp.url);
});

/** A turn held inside a tool call, with OpenCode's and the MCP server's addresses from the adapter's log; `check` runs
 *  while it is held, then the turn completes. */
async function whileHeld(options, check) {
  const said = [];
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const hold = { name: "hold", description: "Waits.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: async () => { started.resolve(); await release.promise; return { text: "released" }; } };
  const script = [{ call: true }, { text: "Done." }];
  const seen = [];
  const fetch = async (_url, init) => {
    const i = seen.length;
    seen.push(JSON.parse(init.body));
    const step = script[i] ?? { text: "spare" };
    const events = step.call
      ? [{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_hold", call_id: "call_hold", name: "hands_hold", arguments: "", status: "in_progress" } }, { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_hold", call_id: "call_hold", name: "hands_hold", arguments: "{}", status: "completed" } }]
      : [{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: `m${i}`, role: "assistant", status: "in_progress", content: [] } }, { type: "response.content_part.added", item_id: `m${i}`, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", item_id: `m${i}`, output_index: 0, content_index: 0, delta: step.text }, { type: "response.output_text.done", item_id: `m${i}`, output_index: 0, content_index: 0, text: step.text }, { type: "response.output_item.done", output_index: 0, item: { type: "message", id: `m${i}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] } }];
    events.push({ type: "response.completed", response: { id: `r${i}`, object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } });
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const a = openCodeAdapter({ model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => "provider-secret" }, sessionsDir: mkdtempSync(join(ROOT, "s-")), fetch, log: (message, fields) => said.push({ message, ...fields }), ...options });
  const store = memorySessionStore();
  const io = { writer: await store.open("loopback"), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, cwd: mkdtempSync(join(ROOT, "w-")), onEvent: () => {} };
  const session = await a.open({ key: "loopback", label: "task", system: ["You answer."], tools: [hold], context: "fresh" }, io);
  await session.send("Hold.");
  await started.promise;
  try {
    const listens = said.find((l) => l.message === "opencode: OpenCode listens");
    assert.ok(listens, `the adapter says where OpenCode and its MCP server listen: ${JSON.stringify(said)}`);
    await check(listens);
  } finally {
    release.resolve();
  }
  assert.deepEqual(await session.turnEnd(), { status: "completed" });
  await session.close();
}

test("opencode serve as the adapter starts it (the stand-in, given the adapter's server arguments) and the MCP server it uses listen on 127.0.0.1 only", { skip: noOutside, timeout: 60_000 }, async () => {
  await whileHeld({ standIn: { command: process.execPath, args: [STAND_IN] } }, async ({ url, mcp }) => {
    await loopbackOnly("opencode serve (the stand-in)", url);
    await loopbackOnly("the MCP server", mcp);
  });
});

test("the pinned opencode serve, as the adapter starts it, and the MCP server it uses listen on 127.0.0.1 only", { skip: noOutside || noBinary, timeout: 120_000 }, async () => {
  await whileHeld({}, async ({ url, mcp }) => {
    await loopbackOnly("the pinned opencode serve", url);
    await loopbackOnly("the MCP server", mcp);
  });
});
