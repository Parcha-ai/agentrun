// The harness conformance suite's claude-agent subject THROUGH the runner: the Claude Agent adapter, as the runner's
// harnesses give it (runner/adapters/index.ts, the launch's harness "claude-agent"), driven by the kernel's generic
// adapter loop (runner/adapter-loop.ts) with the run's visible record kept by the loop (record: "loop"). The CLI is the
// package's scripted stand-in (its fake Agent SDK and a node child), playing the suite's script: the run's input makes
// its one call, and what it says after the call is the script's next step (its words, or the last steer it was given).
// The script is played from the words the CLI is handed, so a resumed CLI (a new claim, a new process) never makes its
// first call again. Its session's records are the run's journal (runner/sessions.ts); its model requests go through its
// session proxy and the runner's booking, as every harness's do.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facts } from "@parcha/agentrun-harness-claude/facts";
import { fakeSdk } from "@parcha/agentrun-harness-claude/testing";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { resolveHarness } = await import("../dist/runner/adapters/index.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");

// The package's stand-in CLI is for tests only: it asks for this under the test runner.
process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = "1";

export const MODEL = "claude-test";
const INPUT = "Follow the script.";
const SESSIONS = mkdtempSync(join(tmpdir(), "conformance-claude-agent-"));

/** The suite's tools as the host's tools (HostTool): replay-safe or at most once, each calling the suite's own. */
function hostTools(tools) {
  return Object.values(tools).map((tool) => ({
    name: tool.name,
    description: `The suite's ${tool.name} tool.`,
    inputSchema: { type: "object", properties: {} },
    replay: tool.replaySafe ? "safe" : "never",
    call: async (args, context) => ({ text: String(await tool.run(args ?? {}, context.signal)) }),
  }));
}

/** Every session the subject's adapters opened and nobody closed yet: a crash case's frozen loop never closes its own,
 *  so a test file closes these at its end. */
export const openSessions = new Set();
export async function closeOpenSessions() {
  for (const session of [...openSessions]) await session.close().catch(() => undefined);
}

function tracked(adapter) {
  return {
    ...adapter,
    capabilities: () => adapter.capabilities(),
    check: (spec) => adapter.check(spec),
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

/** The stand-in CLI's script for the suite's: the input makes the first step's call; after it, the next step's words. A
 *  script of answers some of which the output limit cuts is the stand-in's `cut` turn: its answers in order, the CLI
 *  resuming each cut one itself in the same turn, as Claude Code does. */
function standInScript(script) {
  const [first, next] = script;
  const cutTurn = script.some((step) => step.cut) && script.every((step) => "say" in step)
    ? `cut ${JSON.stringify(script.map((step) => ({ text: step.say, ...(step.cut ? { cut: true } : {}) })))}`
    : undefined;
  const isInput = (text) => text === INPUT || text.endsWith(`\n\n${INPUT}`);
  return {
    // The input, alone or after a note the harness put before it (as the CLI is handed it).
    script: (text) => (!isInput(text) ? undefined : cutTurn ?? (first && "call" in first ? `call ${first.call} ${JSON.stringify(first.args ?? {})}` : undefined)),
    reply: ({ result, steers }) =>
      next && "sayLastSteer" in next ? (steers.at(-1) ?? "") : next && "sayLastResult" in next ? result : next && "say" in next ? next.say : "",
  };
}

/** The adapter loop for the suite's setup: claude-agent as the runner's harnesses give it, on the stand-in CLI. */
export function claudeAgentSpec({ script, tools, hooks, agentId }) {
  const harness = resolveHarness("claude-agent");
  return async (_claim, run) => ({
    ...(agentId ? { agentId } : {}),
    adapter: tracked(await harness.adapter(
      { run, model: MODEL, provider: { origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, price: () => 0, sessionsDir: SESSIONS },
      { standIn: { command: process.execPath }, sdk: fakeSdk({ mirrorLagMs: 10, ...standInScript(script) }) },
    )),
    record: harness.record,
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: INPUT,
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks,
    gate: (call) => (tools[call.tool]?.ask ? "ask" : "allow"),
  });
}

/** The subject the suite runs: claude-agent through the runner. */
export const claudeAgentSubject = {
  name: "claude-agent through the runner",
  process: { module: import.meta.url, export: "claudeAgentSubject" },
  createLoop: (setup) => createAdapterLoop(claudeAgentSpec(setup), { restartLimit: MAX_RESTARTS }),
  // What its adapter declares (steer false, rerunsStarted false, recoversCutAnswers 3): the suite derives the cases those
  // rule out.
  facts,
  unsupported: {
    // The suite's crash child runs outside the test runner (it drops NODE_TEST_CONTEXT), where the package's stand-in CLI
    // is refused by its own guard; the in-process crash cases cover the same points.
    "crash-before-intent-process": "the stand-in Claude Agent CLI runs only under the test runner (its guard), and the suite's crash child runs outside it",
    "crash-after-intent-process": "the stand-in Claude Agent CLI runs only under the test runner (its guard), and the suite's crash child runs outside it",
    "stalled-past-lease-process": "the stand-in Claude Agent CLI runs only under the test runner (its guard), and the suite's runner child runs outside it",
  },
};
