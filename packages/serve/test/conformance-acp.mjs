// The harness conformance suite's ACP subjects, through the runner: the ACP adapter (packages/run-adapters-acp) driven by
// the kernel's generic adapter loop (runner/adapter-loop.ts), on the fake ACP agent (run-adapters-acp's
// testing/fake-acp-agent.mjs, its ./testing export: a stdio agent on the official SDK whose model is the suite's script; no binary, no model, no
// network beyond loopback). The adapter is built here, not through the runner's harness table: registering an ACP
// harness waits for the table (S1), so the suite runs it under a test-only id.
//  - acpSubject plays Goose: it resumes with session/load, takes our tools over HTTP, and asks permission for each.
//  - acpNoLoadSubject plays an agent with no session/load, our tools over stdio: a crash restarts the turn with the
//    recovery note on a new agent session.
// The fake's model takes the step its conversation has reached (its own history, and the calls a recovery note names),
// so a resumed run picks up at its step.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { acpAdapter, acpFacts } = await import("@parcha/agentrun-harness-acp");
const { FAKE_ACP_AGENT: FAKE } = await import("@parcha/agentrun-harness-acp/testing");
/** The id the suite runs the adapter under: no harness of the runner's table is named so. */
export const TEST_ID = "acp-conformance";

/** The suite's tools as the host's tools (HostTool): the helper an author's conformance file takes from
 *  `@parcha/agentrun-serve/conformance`. */
const { suiteHostTools: hostTools } = await import("../dist/runner/conformance/host-tools.js");
export { hostTools };

/** Every session this module's adapters opened and nobody closed yet: a crash case freezes its loop in-process, so that
 *  session's agent keeps running; a test file closes these at its end. */
export const openSessions = new Set();
const dirs = [];
export async function closeOpenSessions() {
  for (const session of [...openSessions]) await session.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function tracked(adapter) {
  return {
    ...adapter,
    id: adapter.id,
    check: adapter.check.bind(adapter),
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

/** The adapter loop's spec for the suite's setup on the fake agent, played as `mode` says. One sessions folder per loop:
 *  a resume on another runner opens the session from the run's journal. */
export function acpSpec(setup, mode) {
  const { script, tools, hooks, agentId } = setup;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-acp-conformance-"));
  dirs.push(dir);
  const config = join(dir, "fake.json");
  writeFileSync(config, JSON.stringify({ script, load: mode.load, http: mode.http, style: mode.style, askMcp: mode.askMcp }));
  const recipe = {
    id: TEST_ID,
    label: "the fake ACP agent",
    command: process.execPath,
    args: [FAKE, config],
    state: [".fake-acp"],
    declares: { load: mode.load, mcp: mode.http ? "http" : "stdio" },
    billing: { kind: "plan", maxTurns: 100, maxToolCalls: 100 },
    // Our tools' permission requests as each style's shipped recipe answers them: Goose's permission file (the fake asks
    // nothing for our tools), Cursor's title tie. Each names its calls by its shipped recipe's field (announces).
    ...(mode.style === "cursor"
      ? { announces: { tool: "rawInput.toolName", server: "rawInput.providerIdentifier", args: "rawInput.args" }, quirks: { permissionTie: "title" } }
      : { announces: { tool: "_meta.goose.toolCall.toolName" }, allowFile: { path: ".config/goose/permission.yaml", form: "goose-permission" } }),
  };
  return async () => ({
    ...(agentId ? { agentId } : {}),
    adapter: tracked(acpAdapter({ recipe, sessionsDir: join(dir, "sessions") })),
    facts: acpFacts(TEST_ID),
    record: "loop",
    session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks,
    gate: (call) => (tools[call.tool]?.ask ? "ask" : "allow"),
  });
}

const subject = (name, mode) => ({
  name,
  createLoop: (setup) => createAdapterLoop(acpSpec(setup, mode), { restartLimit: MAX_RESTARTS }),
  // The runner process the process cases start imports this module and runs the same subject there.
  process: { module: import.meta.url, export: mode.export },
  // What the adapter declares (steer false, rerunsStarted false, recoversCutAnswers 0): the suite derives the cases those
  // rule out.
  facts: acpFacts(TEST_ID),
});

/** Goose's way: session/load, MCP over HTTP, a permission request before each of our tools. */
export const acpSubject = subject("acp (load, MCP over HTTP) through the runner", { load: true, http: true, style: "goose", askMcp: true, export: "acpSubject" });
/** No session/load, MCP over stdio, no permission requests for our tools. */
export const acpNoLoadSubject = subject("acp (no load, MCP over stdio) through the runner", { load: false, http: false, style: "cursor", askMcp: false, export: "acpNoLoadSubject" });
