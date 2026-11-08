// A reference loop for the harness conformance suite: the smallest kernel that follows the rule every edge follows
// (intent before anything runs, a flush before a side effect, route, result) on the run's real journal, with a model that
// plays the suite's script. The suite is proven on it first; each case's mutant (CONFORMANCE_MUTANT) breaks the one
// property its case checks.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";

const { KERNEL_ENTRY, callsOf, journalEntries, messagesOf } = await import("../dist/runner/journal-reader.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const MUTANT = process.env.CONFORMANCE_MUTANT ?? "";

/** The subject the suite runs: reference loops for `setup`. */
export const referenceSubject = {
  name: "reference",
  createLoop: (setup) => (deps) => referenceLoop(setup, deps),
};

function referenceLoop({ script, tools, hooks }, deps) {
  const inbox = [];
  let wake = () => {};
  let stopReason = null;
  const turn = new AbortController();
  deps.signal.addEventListener("abort", () => turn.abort(), { once: true });
  const waitForCommand = () => new Promise((resolve) => (wake = resolve));

  let journal;
  let rooted = false;
  const append = async (kind, data, staged) => {
    const writes = [];
    if (!rooted && !(await journal.conversation(ROOT, context))) writes.push({ type: "conversation", value: { id: ROOT } });
    writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, data } });
    if (staged) journal.stage(staged);
    await commitWrites(journal, writes, context);
    rooted = true;
  };
  /** The steers handed over so far, out of the inbox (an approve or deny stays for its ask). */
  const takeSteers = () => {
    const steers = inbox.filter((command) => command.kind === "steer");
    for (const steer of steers) inbox.splice(inbox.indexOf(steer), 1);
    return steers;
  };
  /** Steers handed over since the last step: into the journal, their rows taken in that commit. */
  const writeSteers = async () => {
    const steers = MUTANT === "steer-at-end" ? [] : takeSteers();
    for (const steer of steers) await append(KERNEL_ENTRY.message, { role: "steer", text: steer.body.text }, { take: [steer.id] });
  };
  const writeStop = async () => {
    if (MUTANT === "stop-unwritten") {
      journal.stage({ run: { state: "stopped" }, take: [stopReason.commandId] });
      await append("agentrun.note", { text: "stopped" }, { run: { state: "stopped" }, take: [stopReason.commandId] });
      return { state: "stopped" };
    }
    await append(KERNEL_ENTRY.message, { role: "stop", text: "stopped by a person" }, { run: { state: "stopped" }, take: [stopReason.commandId] });
    return { state: "stopped" };
  };

  /** The rule: intent, a flush before a side effect, route, result. */
  const invoke = async (call) => {
    const tool = tools[call.tool];
    if (MUTANT !== "intent-after-route") {
      await hooks.beforeIntent(call);
      await append(KERNEL_ENTRY.intent, { callId: call.callId, tool: call.tool, replaySafe: tool.replaySafe });
      if (!tool.replaySafe) await deps.flush();
    }
    const output = await tool.run(call.args, turn.signal);
    if (MUTANT === "intent-after-route") {
      await hooks.beforeIntent(call);
      await append(KERNEL_ENTRY.intent, { callId: call.callId, tool: call.tool, replaySafe: tool.replaySafe });
    }
    await hooks.beforeResult(call, output);
    const status = turn.signal.aborted ? "interrupted" : "done";
    await append(KERNEL_ENTRY.result, { callId: call.callId, status, output });
  };

  return {
    async start(claim) {
      journal = deps.journal(claim);
      let entries = await journalEntries(journal, context);
      // Recovery: an intent with no result. A replay-safe call runs again; any other is interrupted, never run twice.
      for (const call of callsOf(entries).filter((c) => c.status === "pending")) {
        const tool = tools[call.tool];
        const rerun = MUTANT === "rerun-any" || (tool.replaySafe && MUTANT !== "replay-safe-interrupted");
        if (rerun) {
          const output = await tool.run({}, turn.signal);
          await append(KERNEL_ENTRY.result, { callId: call.callId, status: "done", output });
        } else {
          await append(KERNEL_ENTRY.result, { callId: call.callId, status: "interrupted" });
        }
      }
      entries = await journalEntries(journal, context);
      const done = callsOf(entries).length + messagesOf(entries).filter((m) => m.role === "model").length;
      // A resume skips the step it crashed before (case 1's mutant: the call never runs).
      let step = MUTANT === "skip-replayed" && claim.from === "running" && done === 0 ? 1 : done;
      for (; step < script.length; step++) {
        if (stopReason?.kind === "command") return writeStop();
        if (stopReason) return { state: "interrupted" };
        await writeSteers();
        const next = script[step];
        if ("call" in next) {
          const callId = `call-${step}`;
          const tool = tools[next.call];
          if (tool.ask && MUTANT !== "ask-runs") {
            const answered = entries.some((entry) => entry.kind === KERNEL_ENTRY.answer && entry.data.callId === callId);
            if (!answered) {
              const asked = entries.some((entry) => entry.kind === KERNEL_ENTRY.ask && entry.data.callId === callId);
              if (!asked) {
                await append(KERNEL_ENTRY.ask, { callId, tool: next.call }, { run: { state: "parked" } });
                return { state: "parked" };
              }
              // Resumed on the command row: wait for the answer the runner hands over.
              let answer;
              while (!(answer = inbox.find((command) => command.kind === "approve" || command.kind === "deny"))) {
                if (stopReason) return stopReason.kind === "command" ? writeStop() : { state: "interrupted" };
                await waitForCommand();
              }
              inbox.splice(inbox.indexOf(answer), 1);
              await append(KERNEL_ENTRY.answer, { callId, approved: answer.kind === "approve" }, { take: [answer.id] });
              if (answer.kind === "deny") continue;
            }
          }
          await invoke({ callId, tool: next.call, args: next.args ?? {} });
          if (stopReason?.kind === "command") return writeStop();
          if (stopReason) return { state: "interrupted" };
        } else {
          const text = "say" in next ? next.say : [...messagesOf(await journalEntries(journal, context))].reverse().find((m) => m.role === "steer")?.text ?? "";
          if (MUTANT === "steer-at-end") await writeSteersNow();
          const last = step === script.length - 1;
          await append(KERNEL_ENTRY.message, { role: "model", text }, last ? { run: { state: "ended" } } : undefined);
          if (last) return { state: "ended" };
        }
      }
      await append(KERNEL_ENTRY.message, { role: "model", text: "" }, { run: { state: "ended" } });
      return { state: "ended" };

      async function writeSteersNow() {
        for (const steer of takeSteers()) await append(KERNEL_ENTRY.message, { role: "steer", text: steer.body.text }, { take: [steer.id] });
      }
    },
    async command(command) {
      inbox.push(command);
      wake();
      return { taken: true };
    },
    async stop(reason) {
      stopReason = reason;
      turn.abort();
      wake();
    },
  };
}
