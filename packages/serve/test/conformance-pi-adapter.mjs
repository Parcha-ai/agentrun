// The harness conformance suite's pi subject THROUGH the adapter contract (the one-ledger ruling, B2c): pi as an
// AgentAdapter (runner/adapters/pi.ts) driven by the kernel's generic adapter loop (runner/adapter-loop.ts), the same
// loop that drives claude-agent, codex and opencode. pi's model requests go through the session's model proxy like the
// CLI harnesses', so the runner's booking is the one ledger; here the proxy's upstream is a scripted Anthropic origin (its
// `fetch`), whose answer to a request is the script step the conversation has reached: the number of answers the model
// has given so far, read from the request's own messages, so a resumed run (a new process) picks up at its step.
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

export const MODEL = "claude-sonnet-4-5";
const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""));

/** A fetch that answers Anthropic's Messages API as `script` says, one step per request. Records every request body. */
export function scriptedOrigin(script, requests = []) {
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    requests.push(body);
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    const next = script[step];
    const usage = { input_tokens: 100, output_tokens: 10 };
    const start = { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } };
    // A call, or several in one round ({ calls: [{ call, args }, …] }, which pi runs in parallel).
    const calls = next && "calls" in next ? next.calls : next && "call" in next ? [next] : undefined;
    if (calls) {
      const blocks = calls.flatMap((each, index) => [
        { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${step}_${index}`, name: each.call, input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(each.args ?? {}) } },
        { type: "content_block_stop", index },
      ]);
      return sse([
        start,
        ...blocks,
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
        { type: "message_stop" },
      ]);
    }
    // The newest person message with text (a steer, once one was placed), not a tool result.
    const hasText = (message) => typeof message.content === "string" || (Array.isArray(message.content) && message.content.some((part) => part.type === "text"));
    const lastPerson = [...(body.messages ?? [])].reverse().find((message) => message.role === "user" && hasText(message));
    const text = next === undefined ? "" : "say" in next ? next.say : textOf(lastPerson);
    return sse([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
      { type: "message_stop" },
    ]);
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

/** Every session this module's adapters opened and nobody closed yet. A crash case freezes its loop in-process
 *  (runner.kill() stops nothing), so that session's model proxy keeps listening; a test file closes these at its end. */
export const openSessions = new Set();
export async function closeOpenSessions() {
  for (const session of [...openSessions]) await session.close().catch(() => undefined);
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

/** The adapter loop for the suite's setup: pi through the adapter, its model through the session proxy to the script. */
export function piAdapterSpec({ script, tools, hooks }, options = {}) {
  return (_claim, run) => ({
    adapter: tracked(piAdapter({ run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: options.fetch ?? scriptedOrigin(script, options.requests), price: () => 0 })),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    hooks,
    gate: (call) => (tools[call.tool]?.ask ? "ask" : "allow"),
  });
}

/** The subject the suite runs: pi through the adapter. */
export const piAdapterSubject = {
  name: "pi through the adapter",
  process: { module: import.meta.url, export: "piAdapterSubject" },
  createLoop: (setup) => createAdapterLoop(piAdapterSpec(setup), { restartLimit: MAX_RESTARTS }),
};
