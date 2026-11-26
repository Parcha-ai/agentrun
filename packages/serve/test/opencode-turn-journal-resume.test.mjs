// An OpenCode session resumed in a fresh process answers the call its last answer left on that answer's facts, which the
// session's journal kept (harness-opencode/harness.ts: journalTurn): the resumed call gets only what the turn left,
// never the share a budget that knows nothing would give it. On the OpenCode stand-in, its model scripted.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDrive } from "@parcha/agentrun-kernel/kernel";
import { answerReserve, journalTurn, NativeJournal, TurnBudget } from "@parcha/agentrun-kernel/process";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { openCodeAdapter } from "../dist/harness-opencode/index.js";
import { scriptedResponses } from "./conformance-opencode.mjs";

const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const WINDOW = 16_384;
/** The input the interrupted answer's request held: what it leaves its one call, in characters. */
const HELD = 12_000;
const LEFT = (WINDOW - HELD - answerReserve(WINDOW)) * 3;
const RESULT = 10_000;
const until = async (done, what) => {
  for (let i = 0; i < 200; i++) {
    if (await done()) return;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`not seen: ${what}`);
};

/** The session's journal given an answer's facts, as the process that read it journaled them before it stopped. */
async function journaled(store, key, facts) {
  const drive = await openDrive({ writer: await store.open(key), signal: new AbortController().signal });
  const journal = new NativeJournal(drive);
  const turn = new TurnBudget();
  journalTurn(turn, journal);
  turn.open(facts);
  await journal.flush();
}

test("a parked call resumed in a fresh process gets only what its answer left (12,000 of 16,384 held), not a fresh budget's share", async (t) => {
  // MUTATION: the drive without journalTurn resumes the call on a budget that knows nothing: its 10k result goes back whole.
  const requests = [];
  const sessionsDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-opencode-turn-journal-"));
  const adapter = openCodeAdapter({
    model: "gpt-test",
    provider: { origin: "https://provider.invalid", credential: () => `not-a-secret-${"x"}` },
    price: () => 0,
    sessionsDir,
    standIn: { command: process.execPath, args: [STAND_IN] },
    fetch: scriptedResponses([{ call: "lookup", args: {} }, { say: "done" }], requests, { callId: (step, n) => `call_${step}_r${n}` }),
  });
  const lookup = { name: "lookup", description: "Look a thing up.", inputSchema: { type: "object", properties: {} }, replay: "never", call: async () => ({ text: `START ${"r".repeat(RESULT - 6)}` }) };
  const store = memorySessionStore();
  const spec = { key: "root", label: "root", system: ["Follow the script."], tools: [lookup], context: "fresh", contextWindow: WINDOW };
  const models = { beforeRequest: async () => undefined, afterRequest: async () => undefined };
  const asked = [];

  // The first process: the gate parks the call; the run lets go of the session.
  const first = new AbortController();
  const parked = await adapter.open(spec, { writer: await store.open("root"), models, signal: first.signal, onEvent: () => {}, gate: async (call) => (asked.push(call), { park: true }) });
  await parked.send("Follow the script.");
  await until(() => asked.length === 1, "the gate asked about the call");
  first.abort(new Error("the run parked"));
  await parked.close();
  await journaled(store, "root", { inputTokens: HELD, outputTokens: 0, calls: 1 });

  // The next process, a fresh adapter session: the call runs on the journal's turn, then OpenCode goes on.
  const resumed = await adapter.open(spec, { writer: await store.open("root"), models, signal: new AbortController().signal, onEvent: () => {}, gate: async () => "allow" });
  t.after(() => resumed.close());
  await resumed.recover();
  assert.equal((await resumed.turnEnd()).status, "completed");
  const output = requests.at(-1).input.find((item) => item.type === "function_call_output")?.output;
  assert.ok(typeof output === "string" && output.startsWith("START"), `the model reads the call's result: ${String(output).slice(0, 200)}`);
  assert.ok(output.length <= LEFT, `${output.length} characters, past what the turn left (${LEFT})`);
});
