// The harness conformance suite's OpenCode subject, through the runner: OpenCode's adapter (src/harness-opencode) driven
// by the kernel's generic adapter loop (runner/adapter-loop.ts), the loop that drives pi and every CLI harness. OpenCode
// is the stand-in for `opencode serve` (fixtures/fake-opencode-serve.mjs: no binary, no network beyond loopback); its
// model requests go through the session's model proxy, the runner's booking the one ledger, to a scripted Responses
// origin (its `fetch`), whose answer to a request is the script step the conversation has reached: the steps the model
// has taken so far, read from the request's own input, so a resumed run picks up at its step.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { resolveHarness } = await import("../dist/runner/adapters/index.js");
const { facts } = await import("../dist/harness-opencode/facts.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
export const MODEL = "gpt-test";

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const textOf = (item) => (typeof item?.content === "string" ? item.content : (item?.content ?? []).map((part) => part.text ?? "").join(""));

/** The steps the model has taken in `input` (Responses items): each call it made, each text it said. */
const stepsIn = (input) => input.filter((item) => item.type === "function_call" || item.role === "assistant").length;

/** A fetch that answers OpenAI's Responses API as `script` says, one step per request. Records every request body.
 *  `callId`: the id a call gets, by its step and the request's number (default `call_<step>`, the same each time the
 *  step is asked; a model that calls again under a new id gives one per request). */
export function scriptedResponses(script, requests = [], { callId = (step) => `call_${step}` } = {}) {
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    requests.push(body);
    const n = requests.length - 1;
    const input = body.input ?? [];
    const step = stepsIn(input);
    const next = script[step];
    const usage = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } };
    const done = { type: "response.completed", response: { id: `resp_${step}`, object: "response", status: "completed", usage } };
    if (next && "call" in next) {
      // OpenCode names the host's tools hands_<name> (its one MCP server's).
      const item = { type: "function_call", id: `fc_${step}`, call_id: callId(step, n), name: `hands_${next.call}`, arguments: JSON.stringify(next.args ?? {}), status: "completed" };
      return sse([{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, { type: "response.output_item.done", output_index: 0, item }, done]);
    }
    // The newest person message (a steer, once one was placed), and the newest call's result as OpenCode hands it back.
    const lastPerson = [...input].reverse().find((item) => item.role === "user");
    const lastResult = [...input].reverse().find((item) => item.type === "function_call_output");
    const text = next === undefined ? "" : "say" in next ? next.say : "sayLastResult" in next ? String(lastResult?.output ?? "") : textOf(lastPerson);
    return sse([{ type: "response.output_text.delta", item_id: `m_${step}`, output_index: 0, content_index: 0, delta: text }, done]);
  };
}

/** The suite's tools as the host's tools (HostTool): replay-safe or at most once, each calling the suite's own. */
export function hostTools(tools) {
  return Object.values(tools).map((tool) => ({
    name: tool.name,
    description: `The suite's ${tool.name} tool.`,
    inputSchema: { type: "object", properties: {} },
    replay: tool.replaySafe ? "safe" : "never",
    call: async (args, context) => ({ text: String(await tool.run(args ?? {}, context.signal)) }),
  }));
}

/** Every session this module's adapters opened and nobody closed yet: a crash case freezes its loop in-process, so that
 *  session's OpenCode and model proxy keep running; a test file closes these at its end. */
export const openSessions = new Set();
const dirs = [];
export async function closeOpenSessions() {
  for (const session of [...openSessions]) await session.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** `adapter` with each session it opens tracked in openSessions until closed. */
function tracked(adapter) {
  return {
    ...adapter,
    open: async (spec, io) => {
      const session = await adapter.open(spec, io);
      const close = session.close.bind(session);
      session.close = async () => {
        openSessions.delete(session);
        await close();
      };
      openSessions.add(session);
      return session;
    },
  };
}

/** The adapter loop's spec for the suite's setup: OpenCode as the runner's harnesses give it (resolveHarness), on the
 *  stand-in, its model through the session's proxy to the script, the run's visible record kept by the loop. One
 *  sessions folder per loop: a resume on another runner opens the session from the run's journal. */
export function openCodeSpec({ script, tools, hooks }, options = {}) {
  const sessionsDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-opencode-conformance-"));
  dirs.push(sessionsDir);
  const harness = resolveHarness("opencode");
  return async (_claim, run) => ({
    adapter: tracked(await harness.adapter(
      { run, model: MODEL, provider: { origin: "https://provider.invalid", credential: () => `not-a-secret-${"x"}` }, price: () => 0, sessionsDir, fetch: options.fetch ?? scriptedResponses(script, options.requests) },
      { standIn: { command: process.execPath, args: [STAND_IN] } },
    )),
    record: harness.record,
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    hooks,
    gate: (call) => (tools[call.tool]?.ask ? "ask" : "allow"),
  });
}

/** The subject the suite runs: OpenCode through the runner. The runner process the process cases start is no test
 *  runner, and the OpenCode stand-in runs only under one (its guard), so those two cases cannot run on the stand-in. */
export const openCodeSubject = {
  name: "opencode through the runner",
  createLoop: (setup) => createAdapterLoop(openCodeSpec(setup), { restartLimit: MAX_RESTARTS }),
  // What its adapter declares (steer false, rerunsStarted false): the suite derives the cases those rule out.
  facts,
  unsupported: {
    "crash-before-intent-process": "the OpenCode stand-in runs only under a test runner, and the conformance runner process is none (the in-process crash case covers the point)",
    "crash-after-intent-process": "the OpenCode stand-in runs only under a test runner, and the conformance runner process is none (the in-process crash case covers the point)",
    "stalled-past-lease-process": "the OpenCode stand-in runs only under a test runner, and the conformance runner process is none",
  },
};
