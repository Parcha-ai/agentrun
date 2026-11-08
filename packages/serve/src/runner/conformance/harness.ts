// The harness conformance suite (kernel page: "One conformance suite proves every adapter durable"; a new harness ships
// when it passes). Harness-agnostic: it owns a store in a data directory of its own, the runners, the tools, the crash
// and the checks, and reads the run's journal with the kernel's one reader. A harness hands it a ConformanceSubject.
//
// The crash: at one of the kernel's two points a hook kills the runner (runner.kill(): no renew, no release) and never
// resolves, so that loop is frozen as a dead process's would be; a second runner reclaims the run once its claim runs out
// and resumes it from the journal, and any late write of the frozen loop is fenced.
// Next step (not yet): a variant of cases 1 and 2 that kills a real runner child process and has a second process
// reclaim, since freezing a loop in-process can hide a write a real crash would cut.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openSqliteStore, type RunRow, type Store } from "../../store/index.js";
import { sendCommand } from "../commands.js";
import { callsOf, journalEntries, messagesOf, type CallRecord, type MessageRecord } from "../journal-reader.js";
import { startRunner, type Runner } from "../runner.js";
import type { ConformanceCase, ConformanceSetup, ConformanceSubject, KernelHooks, ScriptStep, SuiteTool, ToolName } from "./subject.js";

/** node:test's test(), as the suite registers its cases with it. */
export type TestFunction = (name: string, options: { skip?: string | boolean; timeout?: number }, fn: (t: { after(fn: () => unknown): void }) => Promise<void>) => unknown;

const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30 };
const RUN = "run-1";
const CASE_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(check: () => Promise<T | false | undefined | null> | T | false | undefined | null, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(10);
  }
}
const never = () => new Promise<never>(() => {});

/** The suite's tools, with how many times each ran (outside the journal, as a real side effect would be counted). */
function suiteTools() {
  const ran: Record<ToolName, number> = { effect: 0, read: 0, slow: 0, asked: 0 };
  let letGo: () => void = () => {};
  const slowGate = new Promise<void>((resolve) => (letGo = resolve));
  let slowStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => (slowStarted = resolve));
  const tool = (name: ToolName, replaySafe: boolean, ask: boolean, run: SuiteTool["run"]): SuiteTool => ({ name, replaySafe, ask, run });
  const tools: Record<ToolName, SuiteTool> = {
    effect: tool("effect", false, false, async () => {
      ran.effect += 1;
      return "the effect happened";
    }),
    read: tool("read", true, false, async () => {
      ran.read += 1;
      return "read";
    }),
    slow: tool("slow", true, false, async (_args, signal) => {
      ran.slow += 1;
      slowStarted();
      await Promise.race([slowGate, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      return signal.aborted ? "cut" : "slow done";
    }),
    asked: tool("asked", false, true, async () => {
      ran.asked += 1;
      return "asked done";
    }),
  };
  return { tools, ran, letSlowGo: () => letGo(), slowStarted: started };
}

const quiet: KernelHooks = { beforeIntent: async () => {}, beforeResult: async () => {} };

/** Hooks that crash the runner held in `holder` at `point`, once: kill() and never resolve. */
function crashAt(point: keyof KernelHooks, holder: { runner?: Runner; crashed?: boolean }): KernelHooks {
  const crash = async () => {
    if (holder.crashed) return;
    holder.crashed = true;
    holder.runner?.kill();
    await never();
  };
  return {
    beforeIntent: async () => (point === "beforeIntent" ? crash() : undefined),
    beforeResult: async () => (point === "beforeResult" ? crash() : undefined),
  };
}

/** A store in a data directory of its own, one queued run, and runners started on it (each its own connection). */
async function world(subject: ConformanceSubject, t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-conformance-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores: Store[] = [server];
  const runners: Runner[] = [];
  /** What the runners said (claims, releases, errors): shown with a case's failure. */
  const events: unknown[] = [];
  t.after(async () => {
    for (const runner of runners) await runner.close();
    for (const store of stores.reverse()) await store.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Conformance" }, { id: "rev-1", kind: "agentic", body: { instructions: "Follow the script." } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" });
  const start = async (name: string, setup: ConformanceSetup, holder?: { runner?: Runner }) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const runner = startRunner({ store, createLoop: subject.createLoop(setup), name, ...TIMING, onEvent: (event) => events.push({ runner: name, ...event }) });
    runners.push(runner);
    if (holder) holder.runner = runner;
    return runner;
  };
  const run = async (): Promise<RunRow> => (await server.runs.get(RUN))!;
  const read = async (): Promise<{ calls: CallRecord[]; messages: MessageRecord[] }> => {
    const row = await run();
    const entries = await journalEntries(server.journal({ runId: RUN, runner: "conformance-reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
    return { calls: callsOf(entries), messages: messagesOf(entries) };
  };
  const ended = (state: RunRow["state"], ms = 15_000) =>
    until(async () => {
      const row = await run();
      return row.state === state && row.runner === null && row;
    }, `the run ${state} and released`, ms).catch(async (error: Error) => {
      const row = await run();
      throw new Error(`${error.message}; the run is ${row.state} (runner ${row.runner}, epoch ${row.epoch}); the runners said ${JSON.stringify(events)}`);
    });
  const commandRow = async (id: number) => (await server.commands(RUN, id - 1)).find((row) => row.id === id)!;
  return { server, start, run, read, ended, commandRow };
}

interface Case {
  readonly id: ConformanceCase;
  readonly title: string;
  body(subject: ConformanceSubject, t: { after(fn: () => unknown): void }): Promise<void>;
}

/** A crash at `point` during a call of `tool`, then a second runner's resume: the run ends. */
async function crashThenResume(subject: ConformanceSubject, t: { after(fn: () => unknown): void }, tool: ToolName, point: keyof KernelHooks) {
  const w = await world(subject, t);
  const { tools, ran } = suiteTools();
  const script: ScriptStep[] = [{ call: tool }, { say: "done" }];
  const holder: { runner?: Runner; crashed?: boolean } = {};
  await w.start("runner-a", { script, tools, hooks: crashAt(point, holder) }, holder);
  await until(() => holder.crashed, `the crash at ${point}`);
  await w.start("runner-b", { script, tools, hooks: quiet });
  const row = await w.ended("ended");
  assert.equal(row.epoch, 2, "the second runner resumed it under its own claim");
  return { ...(await w.read()), ran };
}

const CASES: readonly Case[] = [
  {
    id: "crash-before-intent",
    title: "crash before a tool's intent: resumes, runs it once",
    async body(subject, t) {
      const { calls, ran } = await crashThenResume(subject, t, "effect", "beforeIntent");
      assert.equal(ran.effect, 1, "the effect ran once");
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["effect", "done"]]);
    },
  },
  {
    id: "crash-after-intent",
    title: "crash after intent, before result: interrupted",
    async body(subject, t) {
      const { calls, ran } = await crashThenResume(subject, t, "effect", "beforeResult");
      assert.equal(ran.effect, 1, "the effect ran once, never again after the crash");
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["effect", "interrupted"]]);
    },
  },
  {
    id: "replay-safe-rerun",
    title: "replay-safe tool reruns after a crash",
    async body(subject, t) {
      const { calls, ran } = await crashThenResume(subject, t, "read", "beforeResult");
      assert.equal(ran.read, 2, "the replay-safe call ran again after the crash");
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["read", "done"]]);
    },
  },
  {
    id: "steer-mid-turn",
    title: "steer mid-turn reaches the next step",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, letSlowGo, slowStarted } = suiteTools();
      await w.start("runner-a", { script: [{ call: "slow" }, { sayLastSteer: true }], tools, hooks: quiet });
      await slowStarted;
      const steer = await sendCommand(w.server, RUN, { kind: "steer", body: { text: "check the totals" } });
      // One command poll and then some: the steer reaches the loop while the tool runs.
      await sleep(TIMING.commandPollMs * 4);
      letSlowGo();
      await w.ended("ended");
      const { calls, messages } = await w.read();
      const slow = calls.find((call) => call.tool === "slow");
      const steered = messages.find((message) => message.role === "steer");
      const said = messages.filter((message) => message.role === "model");
      assert.ok(slow?.resultEntry !== undefined && slow.status === "done", `slow ran to its result: ${JSON.stringify(calls)}`);
      assert.equal(steered?.text, "check the totals", `the steer is in the journal: ${JSON.stringify(messages)}`);
      assert.ok(steered.entry > slow.resultEntry, "after the tool's result: mid-turn, not lost");
      assert.deepEqual(said.map((message) => message.text), ["check the totals"], "the next step saw it");
      assert.ok(said[0]!.entry > steered.entry);
      assert.ok((await w.commandRow(steer.id)).takenAt !== null, "the steer row is taken");
    },
  },
  {
    id: "stop-ends-turn",
    title: "stop ends the turn; the journal says why",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, slowStarted } = suiteTools();
      await w.start("runner-a", { script: [{ call: "slow" }, { say: "never" }], tools, hooks: quiet });
      await slowStarted;
      const stop = await sendCommand(w.server, RUN, { kind: "stop" });
      await w.ended("stopped");
      const { calls, messages } = await w.read();
      assert.ok(calls.every((call) => call.status !== "pending"), `no call left pending: ${JSON.stringify(calls)}`);
      assert.equal(messages.some((message) => message.text === "never"), false, "the turn did not go on");
      const last = messages.at(-1);
      assert.equal(last?.role, "stop", `the journal's last message says why: ${JSON.stringify(messages)}`);
      assert.match(last!.text, /stopped/);
      assert.ok((await w.commandRow(stop.id)).takenAt !== null, "the stop row is taken");
    },
  },
  {
    id: "park-on-ask",
    title: "park on ask; resume on the command row",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, ran } = suiteTools();
      await w.start("runner-a", { script: [{ call: "asked" }, { say: "done" }], tools, hooks: quiet });
      const parked = await w.ended("parked");
      assert.equal(ran.asked, 0, "the asked tool waits for its answer");
      const approve = await sendCommand(w.server, RUN, { kind: "approve", body: { approval: "asked" } });
      const row = await w.ended("ended");
      assert.ok(row.epoch > parked.epoch, "resumed under a new claim");
      assert.equal(ran.asked, 1, "approved, it ran once");
      assert.ok((await w.commandRow(approve.id)).takenAt !== null, "the approve row is taken");
      const { calls } = await w.read();
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["asked", "done"]]);
    },
  },
];

/** Registers the six cases for `subject` with `test` (node:test). A case the subject cannot model is skipped with its
 *  reason, never passed. */
export function registerHarnessConformance(subject: ConformanceSubject, { test }: { test: TestFunction }): void {
  for (const entry of CASES) {
    const skip = subject.unsupported?.[entry.id];
    test(`${subject.name}: ${entry.title}`, { timeout: CASE_TIMEOUT_MS, ...(skip ? { skip: `${subject.name} cannot model this yet: ${skip}` } : {}) }, (t) =>
      entry.body(subject, t),
    );
  }
}

export const CONFORMANCE_CASES: readonly ConformanceCase[] = CASES.map((entry) => entry.id);
