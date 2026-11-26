// pi holds every tool result to the kernel's bound (boundResult) before its model reads it, as every bridged harness's
// tool bridge does: a host tool's result (piTool) and a pi-native tool's (web_fetch, web_search, the browser's, the
// subagent's, registered with defineTool) alike, at the session model's context window (SessionSpec.contextWindow) when
// the host knows it, else at the host's fixed bound (HOST_RESULT_MAX_CHARS). A window too small for even a minimal cut
// refuses the result in words. serve hands the window over: the run's model route carries the catalog's window
// (model-route.ts routeOf), and the pi spec puts it on the session (adapter-run-spec.ts).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { defineTool } from "@earendil-works/pi-durable";
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";
import { closeOpenSessions, hostTools, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import { specFor } from "./runner-spec-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** 2 MB of text, its start marked so a test can tell it is there. */
const HUGE = `START-OF-RESULT ${"x".repeat(2_000_000)}`;
/** The per-model bound of a 16,384-token window (the kernel's resultMaxChars): a quarter of it at three characters a token. */
const SMALL_MAX = 12_288;
const WINDOW_NOTE = /\n\[kept (\d+) of (\d+) characters: the result was cut to fit this model's context window\./;
const HOST_NOTE = /\n\[cut at (\d+) of (\d+) characters\]$/;

/** A pi-native tool (registered with defineTool, as serve's web_fetch and web_search are) that answers HUGE. */
const nativeHuge = defineTool({
  name: "native_huge",
  description: "A native tool that answers two megabytes.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({ output: [{ type: "text", text: HUGE }] }),
});

/** A run of pi through the adapter whose model calls `call` once and then answers; the session's window is
 *  `contextWindow` (none: unknown). The text of the one tool result the model read. */
async function resultRead(t, { call, contextWindow }) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const requests = [];
  const tools = hostTools({ host_huge: { name: "host_huge", replaySafe: true, run: async () => HUGE } });
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: piAdapter({ run, redact: run.redact, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: scriptedOrigin([{ call }, { say: "done" }], requests), price: () => 0, tools: [nativeHuge] }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools, context: "fresh", ...(contextWindow !== undefined ? { contextWindow } : {}) },
    input: "Follow the script.",
    hooks: quiet,
    gate: () => "allow",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
  }), { restartLimit: MAX_RESTARTS });
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return now.state === "ended" && now.runner === null && now;
  }, "the run ended", 30_000);
  assert.equal(row.state, "ended");
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  assert.ok(results.length > 0, "a tool result reached the model");
  const last = results.at(-1);
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content ?? [];
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

test("pi, no window known: a host tool's 2 MB result reaches the model cut at the host's bound, saying so", async (t) => {
  const text = await resultRead(t, { call: "host_huge" });
  assert.ok(text.length <= HOST_RESULT_MAX_CHARS, `${text.length} characters, past ${HOST_RESULT_MAX_CHARS}`);
  const m = HOST_NOTE.exec(text);
  assert.ok(m, `ends with the host's note: ${JSON.stringify(text.slice(-120))}`);
  assert.equal(Number(m[2]), HUGE.length);
  assert.ok(text.startsWith("START-OF-RESULT "), "its start kept");
});

test("pi, a 16k window: a host tool's 2 MB result reaches the model cut to the per-model bound, saying why", async (t) => {
  // MUTATION: pi's bound that ignores the session's window (the host's 120k alone) fails here.
  const text = await resultRead(t, { call: "host_huge", contextWindow: 16_384 });
  assert.ok(text.length <= SMALL_MAX, `${text.length} characters, past ${SMALL_MAX}`);
  assert.match(text, WINDOW_NOTE);
  assert.ok(text.startsWith("START-OF-RESULT "), "its start kept");
});

test("pi, a 16k window: a pi-native tool's 2 MB result (as web_fetch's) is held to the same bound", async (t) => {
  const text = await resultRead(t, { call: "native_huge", contextWindow: 16_384 });
  assert.ok(text.length <= SMALL_MAX, `${text.length} characters, past ${SMALL_MAX}`);
  assert.match(text, WINDOW_NOTE);
  assert.ok(text.startsWith("START-OF-RESULT "), "its start kept");
});

test("pi, no window known: a pi-native tool's 2 MB result is within the host's bound", async (t) => {
  const text = await resultRead(t, { call: "native_huge" });
  assert.ok(text.length <= HOST_RESULT_MAX_CHARS, `${text.length} characters, past ${HOST_RESULT_MAX_CHARS}`);
  assert.ok(text.startsWith("START-OF-RESULT "), "its start kept");
});

test("pi, a window too small for any cut: the result is refused in words, none of it passed through", async (t) => {
  for (const call of ["host_huge", "native_huge"]) {
    const text = await resultRead(t, { call, contextWindow: 100 });
    assert.ok(!text.includes("START-OF-RESULT") && !text.includes("xxxx"), `${call}: none of the result: ${text.slice(0, 300)}`);
    assert.match(text, /context window/, call);
  }
});

test("the pi spec puts the run's model window on its session, from the model route", async (t) => {
  const routeOf = async () => ({ model: "faux-1", contextWindow: 16_384, provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" } });
  const { spec } = await specFor(t, { routeOf });
  assert.equal(spec.session.contextWindow, 16_384);
  const { spec: none } = await specFor(t, {});
  assert.equal(none.session.contextWindow, undefined, "no window on the route: none on the session (the host bound alone)");
});

test("a model route carries the catalog's context window", async () => {
  const route = await routeOf("openai/gpt-6.1-sol", { OPENAI_API_KEY: `not-a-secret-${"route-key"}` }, "default", ["anthropic-messages", "openai-responses"]);
  assert.ok(Number.isInteger(route.contextWindow) && route.contextWindow > 0, `a window: ${route.contextWindow}`);
});
