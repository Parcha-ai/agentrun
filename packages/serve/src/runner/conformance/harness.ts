// The harness conformance suite (kernel page: "One conformance suite proves every adapter durable"; a new harness ships
// when it passes). Harness-agnostic: it owns a store in a data directory of its own, the runners, the tools, the crash
// and the checks, and reads the run's journal with the kernel's one reader. A harness hands it a ConformanceSubject.
//
// The crash: at one of the kernel's two points a hook kills the runner (runner.kill(): no renew, no release) and never
// resolves, so that loop is frozen as a dead process's would be; a second runner reclaims the run once its claim runs out
// and resumes it from the journal, and any late write of the frozen loop is fenced.
// Cases 1 and 2 run twice: with the loop frozen in-process, and with the first runner a process of its own (child.ts)
// that SIGKILLs itself at the point, since a frozen loop can hide a write a real crash would cut.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openSqliteStore, type RunRow, type Store } from "../../store/index.js";
import { sendCommand } from "../commands.js";
import { callsOf, journalRecords, messagesOf, type CallRecord, type MessageRecord } from "../journal-reader.js";
import { KINDS } from "../journal-kinds.js";
import { timelineReducer, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { emptyState, translate } from "../../live/translate.js";

/** The one row a person's stop gives on the live timeline (live/translate.ts STOPPED_BY_YOU), the same on every harness. */
const STOPPED_BY_YOU = "Stopped by you";
import { startRunner, type Runner } from "../runner.js";
import type { ConformanceCase, ConformanceSetup, ConformanceSubject, KernelHooks, ScriptStep, SuiteTool, ToolName } from "./subject.js";

/** node:test's test(), as the suite registers its cases with it. */
export type TestFunction = (name: string, options: { skip?: string | boolean; timeout?: number }, fn: (t: { after(fn: () => unknown): void }) => Promise<void>) => unknown;

// interruptBackoffMs at the suite's scale: a run whose Session closes itself (the fault cases) is claimed again after it.
const TIMING = { leaseMs: 600, renewEveryMs: 150, stopMarginMs: 200, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
/** The most times a kernel restarts a faulting task before the run fails: every harness's bound is at most this. */
export const MAX_RESTARTS = 5;
/** The suite's runner timing, for its runner process too (child.ts). */
export const CONFORMANCE_TIMING = TIMING;
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
export function suiteTools(countFile?: string) {
  // Counted in memory, or in a file when a runner in another process runs them too (a line per run).
  const memory: Record<ToolName, number> = { effect: 0, read: 0, slow: 0, asked: 0 };
  const count = (name: ToolName) =>
    countFile ? (existsSync(countFile) ? readFileSync(countFile, "utf8").split("\n").filter((line) => line === name).length : 0) : memory[name];
  const ran = {
    get effect() { return count("effect"); },
    get read() { return count("read"); },
    get slow() { return count("slow"); },
    get asked() { return count("asked"); },
    set effect(_: number) { bump("effect"); },
    set read(_: number) { bump("read"); },
    set slow(_: number) { bump("slow"); },
    set asked(_: number) { bump("asked"); },
  } as Record<ToolName, number>;
  function bump(name: ToolName) {
    if (countFile) appendFileSync(countFile, `${name}\n`);
    else memory[name] += 1;
  }
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
    const runner = startRunner({ store, createLoop: subject.createLoop(setup), name, ...TIMING, onEvent: (event) => events.push({ runner: name, at: Date.now(), ...event }) });
    runners.push(runner);
    if (holder) holder.runner = runner;
    return runner;
  };
  const run = async (): Promise<RunRow> => (await server.runs.get(RUN))!;
  const read = async (): Promise<{ calls: CallRecord[]; messages: MessageRecord[] }> => {
    const row = await run();
    // pi's tool tasks and the CLI record alike: the kernel's one reader.
    const entries = await journalRecords(server.journal({ runId: RUN, runner: "conformance-reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
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
  /** The run's timeline as its live view shows it: every stored commit through the live translate (live/translate.ts),
   *  its events through the timeline's own reducer, as the console reads them. */
  const liveRows = async (): Promise<TimelineEvent[]> => {
    const row = await run();
    const journal = server.journal({ runId: RUN, runner: "conformance-reader", epoch: row.epoch, until: 0, from: row.state });
    const state = emptyState();
    const reducer = timelineReducer();
    for (let after = 0; ; ) {
      const page = await journal.commitsAfter(after, 500, BACKGROUND_CONTEXT);
      for (const commit of page.commits) reducer.apply(translate(state, commit) as never);
      if (page.next === undefined) break;
      after = page.next;
    }
    return reducer.rows();
  };
  const commandRow = async (id: number) => (await server.commands(RUN, id - 1)).find((row) => row.id === id)!;
  /** The call the run asked a person about: its ask entry's callId, which an approve or deny names as its approval. */
  const askedCall = async (): Promise<string> => {
    const row = await run();
    const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "conformance-reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
    const ask = entries.find((entry) => entry.kind === KINDS.ask);
    assert.ok(ask, "the run wrote its ask");
    return String((ask.data as { callId?: unknown }).callId);
  };
  return { dir, server, start, run, read, ended, commandRow, askedCall, events, liveRows };
}

interface Case {
  readonly id: ConformanceCase;
  readonly title: string;
  body(subject: ConformanceSubject, t: { after(fn: () => unknown): void }): Promise<void>;
}

/**
 * The resume after a crash, as runner-b's own events tell it: runner-b claimed the run once and released it once, with the
 * run ended, and nothing touched the row after its end (its end commit is its release, moving the epoch to runner-b's
 * claim + 1 in that commit; runner-b's release after it is a no-op). Not an absolute epoch:
 * on a slow box the crashed runner may lose its own claim (a renew that missed) and retake the run before it dies, so the
 * epoch runner-b claims at counts the box's speed, not the resume.
 */
/** Waits for runner-b to say it released the run. The run reads ended and released from its end commit (a write that makes
 *  the run final is its release), which comes before the runner's own end of it says so: bounded, never a sleep. */
async function saidReleased(events: readonly unknown[]): Promise<void> {
  await until(() => events.some((event) => (event as { runner?: string; type?: string }).runner === "runner-b" && (event as { type?: string }).type === "released"), "runner-b says it released the run");
}

function resumedOnceByB(events: readonly unknown[], row: RunRow): void {
  // The whole claim history, every runner's (the crashed one's too, the process cases' read from its events file), in time
  // order: a failure here says what each runner did, not only that the epoch differed.
  const history = JSON.stringify([...events].sort((a, b) => ((a as { at?: number }).at ?? 0) - ((b as { at?: number }).at ?? 0)));
  const ofB = events.filter((event) => (event as { runner?: string }).runner === "runner-b") as { type: string; claim?: { epoch: number }; epoch?: number; end?: string }[];
  const claims = ofB.filter((event) => event.type === "claimed");
  const releases = ofB.filter((event) => event.type === "released");
  assert.equal(claims.length, 1, `runner-b claimed the run once: ${history}`);
  assert.deepEqual(releases.map((event) => [event.epoch, event.end]), [[claims[0].claim!.epoch, "ended"]], `runner-b released it once, ended, under its claim: ${history}`);
  assert.equal(row.epoch, claims[0].claim!.epoch + 1, `nothing touched the run after runner-b's end: ${history}`);
}

/** The crashed runner process's events, appended to `file` as JSON lines (child.ts): each one, or none when it wrote none. */
function childEvents(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { runner: "runner-process", unreadable: line };
    }
  });
}

/** The run's live timeline says it went on after `runner` was lost: the loop that took it over wrote it (Claim.lost). */
function saidTakenOver(rows: readonly TimelineEvent[], runner: string): void {
  const said = rows.filter((row) => row.kind === "phase" && /^Resumed after its runner/.test(row.summary ?? "")).map((row) => row.summary);
  assert.ok(said.includes(`Resumed after its runner (${runner}) was lost`), `the timeline says the run went on after ${runner} was lost: ${JSON.stringify(said)}`);
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
  await saidReleased(w.events);
  resumedOnceByB(w.events, row);
  saidTakenOver(await w.liveRows(), "runner-a");
  return { ...(await w.read()), ran };
}

/** The runner process the process cases start (child.ts), and its environment: never a test runner's own. */
const CHILD = fileURLToPath(new URL("./child.js", import.meta.url));
const childEnv = () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

/** As crashThenResume, with the first runner a process of its own that SIGKILLs itself at `point`: nothing it had not
 *  committed survives, as in a real crash. The tools count their runs in a file both processes append to. */
async function processCrashThenResume(subject: ConformanceSubject, t: { after(fn: () => unknown): void }, tool: ToolName, point: keyof KernelHooks, { stall = false }: { stall?: boolean } = {}) {
  const w = await world(subject, t);
  const countFile = join(w.dir, "tool-runs");
  const { tools, ran } = suiteTools(countFile);
  const eventsFile = join(w.dir, "runner-process-events.jsonl");
  const config = { dataDir: w.dir, module: subject.process!.module, export: subject.process!.export, tool, point, countFile, eventsFile, ...(stall ? { stopOnce: true } : {}) };
  const child = spawn(process.execPath, [CHILD, JSON.stringify(config)], { env: childEnv(), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  // `stall`: the process stops itself at `point` (child.ts stopOnce) and is let go once its lease has run out, before
  // anyone has taken the run again: the window where only the store can refuse what its old loop writes next.
  let continuedAt = 0;
  if (stall) {
    await until(() => childEvents(eventsFile).some((event) => (event as { type?: string }).type === "stopping"), `the runner process stops at ${point}`);
    await sleep(TIMING.leaseMs + TIMING.stopMarginMs + 100);
    continuedAt = Date.now();
    child.kill("SIGCONT");
  }
  const exit = (await Promise.race([once(child, "exit"), sleep(15_000).then(() => ["timeout", null])])) as [number | string | null, string | null];
  // What the process did, when it did not die where it should: its claims, lost claims, commits (landed or refused, by
  // epoch), the tool's runs and the run's row.
  if (exit[1] !== "SIGKILL") {
    const row = await w.run();
    assert.fail(`the runner process dies at ${point} (it ended ${JSON.stringify(exit)}); continued at ${continuedAt}; its events ${JSON.stringify(childEvents(eventsFile))}; the tool ran ${JSON.stringify(ran)}; the run ${JSON.stringify(row)}; stderr ${stderr}`);
  }
  await w.start("runner-b", { script: [{ call: tool }, { say: "done" }], tools, hooks: quiet });
  const row = await w.ended("ended");
  await saidReleased(w.events);
  resumedOnceByB([...childEvents(eventsFile), ...w.events], row);
  saidTakenOver(await w.liveRows(), "runner-process");
  return { ...(await w.read()), ran, events: childEvents(eventsFile) as { type?: string; at?: number; epoch?: number; name?: string; claim?: { epoch: number } }[], continuedAt };
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
    id: "crash-before-intent-process",
    title: "a runner process killed before a tool's intent: another resumes, runs it once",
    async body(subject, t) {
      const { calls, ran } = await processCrashThenResume(subject, t, "effect", "beforeIntent");
      assert.equal(ran.effect, 1, "the effect ran once");
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["effect", "done"]]);
    },
  },
  {
    id: "crash-after-intent-process",
    title: "a runner process killed after intent, before result: interrupted",
    async body(subject, t) {
      const { calls, ran } = await processCrashThenResume(subject, t, "effect", "beforeResult");
      assert.equal(ran.effect, 1, "the effect ran once, never again after the crash");
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["effect", "interrupted"]]);
    },
  },
  {
    id: "stalled-past-lease-process",
    title: "a runner process paused past its lease before a tool's intent: its old loop's write is refused, a fresh loop retakes the run, and the tool runs once",
    async body(subject, t) {
      const { calls, ran, events, continuedAt } = await processCrashThenResume(subject, t, "effect", "beforeIntent", { stall: true });
      const history = JSON.stringify(events);
      const claims = events.filter((event) => event.type === "claimed").map((event) => event.claim!.epoch);
      assert.ok(claims.length >= 2 && claims[1]! > claims[0]!, `the process lost its claim and took the run back at a new epoch, with a fresh loop: ${history}`);
      // What its old loop wrote once it went on, its lease run out and no one holding the run yet: tried, and refused.
      const old = events.filter((event) => (event.at ?? 0) >= continuedAt && event.epoch === claims[0] && (event.type === "commit-landed" || event.type === "commit-refused"));
      assert.ok(old.length > 0, `the old loop tried to write after it went on: ${history}`);
      assert.deepEqual(old.filter((event) => event.type === "commit-landed"), [], `none of the old loop's writes landed: ${history}`);
      assert.ok(old.every((event) => event.name === "ClaimLost" || event.name === "Fenced"), `each was refused by the claim's fence, by name: ${history}`);
      assert.equal(ran.effect, 1, "the effect ran once");
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["effect", "done"]]);
    },
  },
  {
    // #1933's read: a task restart re-ran a node's effects (pi's restartLimit masked it). A fault after the effect ran
    // (the process alive) restarts the task under the kernel's rule, and the effect never runs twice.
    id: "fault-effects-once",
    title: "a task that faults after its effect ran is restarted without running the effect again",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, ran } = suiteTools();
      let faults = 0;
      const hooks: KernelHooks = {
        beforeIntent: async () => {},
        beforeResult: async () => {
          if (faults++ === 0) throw new Error("a fault in the task after its effect ran");
        },
      };
      await w.start("runner-a", { script: [{ call: "effect" }, { say: "done" }], tools, hooks });
      const row = await until(async () => {
        const now = await w.run();
        return ["ended", "failed"].includes(now.state) && now.runner === null && now;
      }, "the run ends after the fault");
      assert.equal(ran.effect, 1, "the effect ran once, never again on the restart");
      const { calls } = await w.read();
      const effect = calls.filter((call) => call.tool === "effect");
      assert.equal(effect.length, 1, `one call of the effect: ${JSON.stringify(calls)}`);
      assert.ok(effect[0]!.status === "interrupted" || effect[0]!.status === "failed", `the faulted call is not done: ${effect[0]!.status}`);
      assert.equal(row.state, "ended", "the run goes on past the fault and ends");
    },
  },
  {
    // The restart rule by name: a task that faults every time is restarted a bounded number of times, never forever, and
    // the run fails saying so. Removing the bound (or the rule that replaces pi's restartLimit) turns this red.
    id: "fault-restarts-bounded",
    title: "a task that faults every time is restarted a bounded number of times, then the run fails",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, ran } = suiteTools();
      const hooks: KernelHooks = {
        beforeIntent: async () => {},
        beforeResult: async () => {
          throw new Error("a fault in the task, every time");
        },
      };
      await w.start("runner-a", { script: [{ call: "read" }, { say: "done" }], tools, hooks });
      const row = await w.ended("failed");
      assert.ok(ran.read >= 2, `restarted at least once (a replay-safe call runs again): ran ${ran.read}`);
      assert.ok(ran.read <= MAX_RESTARTS + 1, `restarted at most ${MAX_RESTARTS} times: ran ${ran.read}`);
      assert.match(row.summary ?? "", /fault|restart/i, `the run says why it failed: ${JSON.stringify(row.summary)}`);
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
      assert.ok(slow?.endEntry !== undefined && slow.status === "done", `slow ran to its end: ${JSON.stringify(calls)}`);
      assert.equal(steered?.text, "check the totals", `the steer is in the journal: ${JSON.stringify(messages)}`);
      assert.ok(steered.entry > slow.endEntry, "after the tool's end: mid-turn, not lost");
      assert.deepEqual(said.map((message) => message.text), ["check the totals"], "the next step saw it");
      assert.ok(said[0]!.entry > steered.entry);
      assert.ok((await w.commandRow(steer.id)).takenAt !== null, "the steer row is taken");
    },
  },
  {
    id: "stop-ends-turn",
    title: "stop ends the turn; the run says why",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, slowStarted } = suiteTools();
      await w.start("runner-a", { script: [{ call: "slow" }, { say: "never" }], tools, hooks: quiet });
      await slowStarted;
      const stop = await sendCommand(w.server, RUN, { kind: "stop" });
      const row = await w.ended("stopped");
      const { calls, messages } = await w.read();
      assert.ok(calls.every((call) => call.status !== "pending"), `no call left pending: ${JSON.stringify(calls)}`);
      assert.equal(messages.some((message) => message.text === "never"), false, "the turn did not go on");
      // Why it stopped is on the run row, staged in the end commit: one place for every harness.
      assert.match(row.summary ?? "", /stopped/, `the run says why it stopped: ${JSON.stringify(row.summary)}`);
      assert.ok(row.endedAt !== null, "its end commit stamped ended_at");
      assert.ok((await w.commandRow(stop.id)).takenAt !== null, "the stop row is taken");
      // The live timeline: one row says the person stopped it, worded the same on every harness, and nothing a person
      // reads shows a harness's markup.
      const rows = await w.liveRows();
      const stops = rows.filter((one) => one.summary === STOPPED_BY_YOU);
      assert.deepEqual(stops.map((one) => one.kind), ["phase"], `one row says the person stopped it: ${JSON.stringify(rows.map((one) => [one.kind, one.summary]))}`);
      const leaked = rows.filter((one) => [one.summary, one.text, one.tool_result_preview, one.tool_input_preview].some((value) => typeof value === "string" && value.includes("<harness")));
      assert.deepEqual(leaked.map((one) => [one.kind, one.summary, one.tool_result_preview]), [], "no row shows a harness's markup");
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
      const approve = await sendCommand(w.server, RUN, { kind: "approve", body: { approval: await w.askedCall() } });
      const row = await w.ended("ended");
      assert.ok(row.epoch > parked.epoch, "resumed under a new claim");
      assert.equal(ran.asked, 1, "approved, it ran once");
      assert.ok((await w.commandRow(approve.id)).takenAt !== null, "the approve row is taken");
      const { calls } = await w.read();
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["asked", "done"]]);
    },
  },
  {
    id: "approval-names-its-call",
    title: "an approval that names another call is refused, never answers the waiting one, and the run parks again",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, ran } = suiteTools();
      await w.start("runner-a", { script: [{ call: "asked" }, { say: "done" }], tools, hooks: quiet });
      await w.ended("parked");
      const callId = await w.askedCall();
      const stale = await sendCommand(w.server, RUN, { kind: "approve", body: { approval: `${callId}-another` } });
      const refused = await until(async () => {
        const row = await w.commandRow(stale.id);
        return row.takenAt !== null && row;
      }, "the other approval answered");
      assert.match(refused.refused ?? "", /approval/, `refused in words: ${JSON.stringify(refused)}`);
      assert.equal(ran.asked, 0, "the waiting call did not run on another call's approval");
      await w.ended("parked");
      const approve = await sendCommand(w.server, RUN, { kind: "approve", body: { approval: callId } });
      await w.ended("ended");
      assert.equal(ran.asked, 1, "approved by its own approval, it ran once");
      assert.equal((await w.commandRow(approve.id)).refused, null, "its approve row is taken, not refused");
      const { calls } = await w.read();
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["asked", "done"]]);
    },
  },
  {
    id: "approval-double-click",
    title: "a double-clicked approval runs the call once: the first answers it, the second is refused in words",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, ran } = suiteTools();
      await w.start("runner-a", { script: [{ call: "asked" }, { say: "done" }], tools, hooks: quiet });
      await w.ended("parked");
      const callId = await w.askedCall();
      const first = await sendCommand(w.server, RUN, { kind: "approve", body: { approval: callId } });
      const second = await sendCommand(w.server, RUN, { kind: "approve", body: { approval: callId } });
      await w.ended("ended");
      assert.equal(ran.asked, 1, "the call ran once");
      assert.equal((await w.commandRow(first.id)).refused, null, "the first approve answered it");
      const late = await until(async () => {
        const row = await w.commandRow(second.id);
        return row.takenAt !== null && row;
      }, "the second approve answered");
      assert.match(late.refused ?? "", /\w/, `the second approve is refused in words: ${JSON.stringify(late)}`);
      const { calls } = await w.read();
      assert.deepEqual(calls.map((call) => [call.tool, call.status]), [["asked", "done"]]);
    },
  },
  {
    id: "message-never-answers",
    title: "a message that answers nothing (a trigger's, answers: false) never answers a waiting call, whatever its words",
    async body(subject, t) {
      const w = await world(subject, t);
      const { tools, ran } = suiteTools();
      await w.start("runner-a", { script: [{ call: "asked" }, { say: "done" }], tools, hooks: quiet });
      await w.ended("parked");
      const callId = await w.askedCall();
      // A trigger's message: it says "yes", but it answers nothing (answers: false), so it resolves no approval.
      await sendCommand(w.server, RUN, { kind: "steer", body: { text: "yes", answers: false, origin: { kind: "trigger", trigger: "trigger-1" } } });
      await sleep(TIMING.leaseMs * 2);
      assert.equal(ran.asked, 0, "the waiting call did not run on a message");
      const row = await w.run();
      const { entries } = await journalRecords(w.server.journal({ runId: RUN, runner: "conformance-reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
      assert.deepEqual(entries.filter((entry) => entry.kind === KINDS.answer), [], "no answer was written for the call");
      // Its own approval still answers it.
      await sendCommand(w.server, RUN, { kind: "approve", body: { approval: callId } });
      await w.ended("ended", 30_000);
      assert.equal(ran.asked, 1, "approved, it ran once");
    },
  },
];

/** Registers the six cases for `subject` with `test` (node:test). A case the subject cannot model is skipped with its
 *  reason, never passed. */
export function registerHarnessConformance(subject: ConformanceSubject, { test }: { test: TestFunction }): void {
  for (const entry of CASES) {
    const processCase = entry.id.endsWith("-process");
    const skip = subject.unsupported?.[entry.id] ?? (processCase && !subject.process ? "it names no module a runner process can load (subject.process)" : undefined);
    test(`${subject.name}: ${entry.title}`, { timeout: CASE_TIMEOUT_MS, ...(skip ? { skip: `${subject.name} cannot model this yet: ${skip}` } : {}) }, (t) =>
      entry.body(subject, t),
    );
  }
}

export const CONFORMANCE_CASES: readonly ConformanceCase[] = CASES.map((entry) => entry.id);
