// A run of one MCP tool on a CLI harness through the adapter loop, its call parked at the gate: the tool is the claim's
// MCP tool (spec.mcp, wire name `mcp__srv__write`, catalog name `mcp:srv/write`), a host tool like any other, and the CLI
// is a stand-in whose tool bridge asks the host's gate before it calls the tool, as every CLI adapter's bridge does
// (run-adapters' toolBridge). A deny is the call's result, never run; a park holds the call until the session closes. Its
// resume log keeps that its turn was sent: a session opened again finds it open and recovers it, issuing call-1 again
// under its id, as a CLI resumes the turn its call parked.
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "../runner-support.mjs";

const { startRunner } = await import("../../dist/runner/runner.js");
const { createAdapterLoop } = await import("../../dist/runner/adapter-loop.js");

export const WIRE = "mcp__srv__write";
export const CATALOG = "mcp:srv/write";
const STEADY = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

function parkingCli(said) {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(spec, io) {
      let state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "open_turn" : "new";
      let turn;
      const closing = new AbortController();
      const run = () => (async () => {
        const call = { callId: "call-1", tool: WIRE, args: { path: "notes.md" } };
        const answer = await io.gate(call);
        if (answer !== "allow" && !("deny" in answer)) {
          await new Promise((resolve) => closing.signal.addEventListener("abort", resolve, { once: true }));
          return { status: "aborted" };
        }
        const result = answer === "allow" ? await spec.tools.find((each) => each.name === WIRE).call(call.args, { callId: call.callId, signal: io.signal }) : { text: answer.deny, isError: true };
        said.push(result);
        io.onEvent({ type: "text", delta: `It said ${result.text}` });
        io.onEvent({ type: "turn_end", status: "completed" });
        return { status: "completed" };
      })();
      return {
        get state() { return state; },
        async send() {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          state = "idle";
          turn = run();
        },
        async recover() {
          state = "idle";
          turn = run();
        },
        async settleOpenTurn() { state = "idle"; },
        turnEnd: () => turn,
        async interrupt() {},
        async close() { closing.abort(); },
      };
    },
  };
}

/** A CLI run whose one call is the MCP tool, its spec's gate `gate`: once it parks, `meanwhile(server)` (an answer to
 *  its ask), then its row once it rests at `state`. `ran`: each input the MCP server was sent; `said`: what the model
 *  was handed. */
export async function parkedMcpRun(t, { gate, hooks = quiet, state = "ended", meanwhile }) {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const ran = [];
  const said = [];
  const write = { name: WIRE, description: "Writes a note.", inputSchema: { type: "object" }, replay: "never", call: async (args) => (ran.push(args), { text: "the call ran" }) };
  const mcp = { tools: [write], catalogOf: (name) => (name === WIRE ? CATALOG : undefined), priceOf: (name) => (name === CATALOG ? "not metered" : undefined), effectOf: (name) => (name === CATALOG ? "write" : undefined), fresh: async () => {}, release: () => {} };
  const createLoop = createAdapterLoop(() => ({
    adapter: parkingCli(said),
    session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    input: "Write the note.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    record: "loop",
    hooks,
    gate,
    mcp,
  }), { restartLimit: 3 });
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...STEADY });
  t.after(() => runner.close());
  const rested = (want) => until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state === want && now.runner === null && now;
  }, `the run ${want} and released`, 10_000);
  if (meanwhile) {
    await rested("parked");
    await meanwhile(opened.server);
  }
  const row = await rested(state);
  return { ran, said, row, server: opened.server };
}
