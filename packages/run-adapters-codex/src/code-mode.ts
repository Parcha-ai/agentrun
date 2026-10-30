// Code mode for the Codex harness: what a model's script does with host tools. Written for AgentRun.
//
// A code-mode model calls its tools from a JavaScript `exec` of Codex's, as nested calls under ids of Codex's own (`exec-<uuid>`)
// that no rollout line carries and that name no `exec`. This module holds everything the session does about that, so the copied
// harness takes only hooks: it
//  - ties each nested call to the one live script (scripts.ts) and holds a `never` tool's call until that script's `exec` line is in
//    the log, declining it while two scripts are live;
//  - writes the tie to the session's records before the call runs;
//  - answers, after a recovery, a `never` call the log already holds a completed outcome for from the log, one re-issue for each;
//  - answers a cut-off `exec` with a custom tool call output built from the nested calls the log holds for it, and runs nothing;
//  - gives the model the harness's note about an interrupted turn as a developer message, once per interrupted turn.
import type { DriveContext, SessionState } from "./host/kernel.js";
import type { SessionMachine } from "./host/process.js";
import { openTurn, recoverySystemNote, recoveryUserTurn, toolKey, transcriptOf } from "./host/process.js";
// cycle with harness.ts: read repairOutput only inside functions, never at module top level (pinned by "code mode and the harness
// load in either order and the repair reads repairOutput"). A host loads harness.js first, so at that point none of its const bindings is set.
import { repairOutput } from "./harness.js";
import { type RolloutSummary, summarizeRollout } from "./rollout.js";
import { callKey, completedNested, execRecoveryOutput, NESTED_CALL, type NestedFact, outputTextOf, recoveryFacts, Scripts, settle, UNWATCHED } from "./scripts.js";

/** The stream that ties each nested call to the `exec` it ran under: `{ callId, exec, since }` (`since`: the turn it ran in), written before the call runs. */
export const NESTED_STREAM = "codex.nested";
/** The stream that records the interrupted turns whose recovery note was injected: `{ since }`, once per interrupted turn. */
export const RECOVERY_NOTE_STREAM = "codex.recovery-note";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Journal {
  append(stream: string, record: unknown): void;
  flush(): Promise<void>;
  read<T>(stream: string): Promise<{ data: T }[]>;
}

export interface CodeModeDeps {
  ctx: DriveContext;
  machine: SessionMachine;
  journal: Journal;
  /** The calls whose line is in the log: the harness's barrier looks here, so a call admitted here passes it. */
  logged: Set<string>;
  /** Drain the rollout's tail into the log. */
  synced(): Promise<void>;
  bridge: { get(name: string): { name: string; replay: string } | undefined };
  log(message: string, fields?: Record<string, unknown>): void;
  /** The rollout lines restored from the log. */
  lines: readonly string[];
  rpc(): { request(method: string, params: Record<string, unknown>): Promise<unknown> };
  guard<T>(promise: Promise<T>): Promise<T>;
  threadId(): string;
  /** How often the barrier looks again for a script's line, and what a declined call is told. */
  tries: number;
  declined: string;
}

interface Dangling {
  callId: string;
  name: string;
  /** `function_call` or `custom_tool_call` (code mode's `exec`, Codex's own `apply_patch`). */
  type: string;
  arguments?: string;
}

/** Only a custom tool call named `exec` is code mode's: a host tool that happens to be called `exec` is a function call. */
const isExec = (d: Dangling) => d.type === "custom_tool_call" && d.name === "exec";

/** The item that answers a dangling call that is not an `exec`: of the kind the call asks for (the Responses API refuses an output of the
 *  wrong kind), a custom tool call output for a custom tool call such as `apply_patch`, a function call output for any other. */
export function withOutputKind<T extends { call_id?: unknown; output?: unknown }>(item: T, call: Dangling): T & { type: string } {
  return { ...item, type: call.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output" };
}

/** Where the turn that ended last began, as `openTurn` gave it while that turn was open: the end before its own (a `turn` entry, or a turn the
 *  harness could not run), or -1. With no open turn, the calls whose script could not be told that ran in it are tied to this. */
function endedTurnSince(state: SessionState): number {
  const ends = [...transcriptOf(state).filter((r) => r.data?.type === "turn").map((r) => r.at), ...state.effectOrder.flatMap((e, i) => (e.name === "unavailable" ? [i] : []))];
  ends.sort((a, b) => a - b);
  return ends.length >= 2 ? ends[ends.length - 2]! : -1;
}

/** What a dangling `wait` of code mode is told: it had started, on the cell named, when the session stopped and took the cell's script with it. */
export const waitStoppedText = (cell: string) =>
  `The session stopped while waiting on cell ${cell}; that cell's script was cut off, and nothing was run again. Check the actual state before relying on it.`;

type Tie = { callId: string; exec: string | null; since?: number };

/** What the log holds of one nested call: the session's record, and the rollout's completion line. */
function factOf(state: SessionState, rolled: ReturnType<typeof completedNested>, tie: { callId: string }): NestedFact {
  const e = state.effects.get(toolKey(tie.callId));
  return {
    callId: tie.callId,
    tool: e ? e.name.replace(/^tool\./, "") : (rolled.get(tie.callId)?.tool ?? "a tool"),
    ...(e ? { store: { status: e.status === "completed" ? "completed" : e.status === "failed" ? "failed" : "started", text: e.status === "failed" ? (e.error?.message ?? "") : outputTextOf(e.output), ...(e.error?.interrupted ? { interrupted: true } : {}) } as NonNullable<NestedFact["store"]> } : {}),
    ...(rolled.has(tie.callId) ? { rollout: rolled.get(tie.callId)! } : {}),
  };
}

export function codeMode(deps: CodeModeDeps) {
  const { ctx, machine, journal, logged, synced } = deps;
  const scripts = new Scripts();
  /** The exec each nested call was admitted under. */
  const execOf = new Map<string, string>();
  /** After a recovery: the `never` calls the log holds a completed outcome for, by tool and arguments, until the turn ends. Each answers one re-issue. */
  const recovered = new Map<string, { tool: string; text: string }[]>();
  for (const line of deps.lines) scripts.note(line);
  machine.onRolloutLine?.((line) => scripts.note(line));

  /** The script a nested call is tied to now, as the log and the proxy's latest answer have it. */
  const tieNow = () => scripts.tie(machine.announcedExec?.(), (id) => logged.has(id));

  /** A `never` nested call: wait for its script's line, as the harness's barrier waits for a call's own. True: admitted. */
  const admit = async (callId: string): Promise<boolean> => {
    for (let i = 0; ; i++) {
      await synced();
      const tie = tieNow();
      if (tie.kind === "ambiguous") {
        deps.log("codex: declined a nested call while two scripts are live", { callId, live: tie.live });
        return false;
      }
      if (tie.kind === "tied") {
        execOf.set(callId, tie.exec);
        logged.add(callId);
        await journal.flush();
        return true;
      }
      if (i + 1 >= deps.tries) break;
      await sleep(50 * 2 ** i);
    }
    deps.log("codex: declined a call whose function_call line is not in the log", { callId });
    return false;
  };

  /** After a recovery: every `never` call of the interrupted turn the log holds a completed outcome for (the session's record or, when it
   *  lost the end, the rollout's: Codex writes that line only after our tool answered, so the effect happened), each answering one
   *  re-issue. Read from the turn's tie records, not from the outputs a recovery repairs: a turn recovered once already has its exec
   *  answered, and a script that yielded has its exec answered by the running-cell output, yet their calls ran. */
  const arm = async (since: number): Promise<void> => {
    recovered.clear();
    const state: SessionState = ctx.state();
    const rolled = completedNested(deps.lines);
    for (const tie of (await journal.read<Tie>(NESTED_STREAM)).map((r) => r.data)) {
      if (tie.since !== since) continue;
      const e = state.effects.get(toolKey(tie.callId));
      if (e?.replay !== "never") continue;
      const fact = factOf(state, rolled, tie);
      const settled = settle(fact);
      if (settled.kind !== "completed") continue;
      const key = callKey(fact.tool, e.input);
      recovered.set(key, [...(recovered.get(key) ?? []), { tool: fact.tool, text: settled.text }]);
    }
  };

  /** The cell a dangling call waited on, when it is code mode's `wait` (a function call named `wait` with a `cell_id`, and no host tool of
   *  that name); otherwise `undefined`. */
  const waitedCell = (c: Dangling): string | undefined => {
    if (c.type !== "function_call" || c.name !== "wait" || deps.bridge.get("wait")) return undefined;
    try {
      const cell = (JSON.parse(c.arguments ?? "") as { cell_id?: unknown }).cell_id;
      return typeof cell === "string" || typeof cell === "number" ? String(cell) : undefined;
    } catch {
      return undefined;
    }
  };

  const declined = { contentItems: [{ type: "inputText", text: deps.declined }], success: false };

  return {
    /** The app-server's request handler, with a code-mode host tool call handled before the harness's own. */
    request<R extends { method: string; params?: Record<string, unknown> }>(next: (req: R) => Promise<unknown>) {
      return async (req: R): Promise<unknown> => {
        if (req.method === "item/tool/call") {
          const p = req.params ?? {};
          const callId = String(p.callId ?? "");
          const tool = deps.bridge.get(String(p.tool));
          // After a recovery, a `never` call the log already holds a completed outcome for, called again (a script that was cut short and
          // written again re-issues every call it made): answered from the log, run no more.
          const again = tool?.replay === "never" ? recovered.get(callKey(tool.name, p.arguments))?.shift() : undefined;
          if (again) {
            deps.log("codex: answered a never call from the log: it completed before the interruption", { callId, tool: again.tool });
            return { contentItems: [{ type: "inputText", text: `Recorded earlier in this turn, not run again: ${again.text}` }], success: true };
          }
          if (NESTED_CALL.test(callId)) {
            if (tool?.replay === "never" && !ctx.isMemoized(toolKey(callId)) && !(await admit(callId))) return declined;
            const tie = tieNow();
            const exec = execOf.get(callId) ?? (tie.kind === "tied" || tie.kind === "held" ? tie.exec : undefined);
            if (exec) execOf.set(callId, exec);
            // Never the unwatched-answer marker: a call tied to no known exec is journaled with none.
            journal.append(NESTED_STREAM, { callId, exec: exec === undefined || exec === UNWATCHED ? null : exec, since: openTurn(ctx.state())?.since ?? -1 });
          }
        }
        return next(req);
      };
    },

    /** The outputs injected for the calls the rollout left dangling: a cut-off `exec` gets a custom tool call output from the log, in place of `items`';
     *  any other call keeps its generic output, as an item of its own kind, and code mode's `wait` is told that it had started. `since`: the
     *  turn the dangling calls ran in: the interrupted one a recovery note resumes, or with none, the turn that ended last. */
    async recoverItems(items: Record<string, unknown>[], dangling: readonly Dangling[], lines: readonly string[], since: number): Promise<void> {
      const state: SessionState = ctx.state();
      const ties = (await journal.read<Tie>(NESTED_STREAM)).map((r) => r.data);
      const execs = dangling.filter(isExec).map((d) => d.callId);
      const rolled = completedNested(lines);
      // Each cut-off exec lists its own calls. A call whose script could not be told when it ran (an answer the proxy did not see to its end)
      // is listed once, apart, in the LAST cut-off exec's output, if it ran in this interrupted turn.
      const listed = recoveryFacts(execs, ties, since, (tie) => factOf(state, rolled, tie));
      dangling.forEach((c, i) => {
        if (!isExec(c)) {
          // Code mode's `wait` on a cell had started: the generic answer, that the call never started, would be false.
          const cell = waitedCell(c);
          const item = items[i] as { call_id?: unknown; output?: unknown };
          items[i] = withOutputKind(cell === undefined ? item : { ...item, output: waitStoppedText(cell) }, c);
          return;
        }
        const { own, loose } = listed.get(c.callId)!;
        items[i] = { type: "custom_tool_call_output", call_id: c.callId, output: execRecoveryOutput(own, loose) };
      });
    },

    /** With no recovery note, the calls the rollout has no output for get theirs from the log before any turn is sent: a turn that ended without
     *  them (one interrupted mid-call, or settled instead of resumed) left them dangling, and the provider refuses a history with a call unanswered.
     *  Nothing is armed here: a new turn that calls a `never` call the ended turn completed runs it. */
    async repairUnnoted(lines: readonly string[]): Promise<void> {
      const dangling = summarizeRollout(lines).dangling;
      if (dangling.length === 0) return;
      const items: Record<string, unknown>[] = dangling.map((c) => ({ type: "function_call_output", call_id: c.callId, output: repairOutput(ctx.state(), c) }));
      // A cut-off exec of the ended turn still lists the calls of that turn whose script could not be told: they ran.
      await this.recoverItems(items, dangling, lines, endedTurnSince(ctx.state()));
      await deps.guard(deps.rpc().request("thread/inject_items", { threadId: deps.threadId(), items }));
      await deps.guard(synced());
    },

    /** The user's turn that resumes an interrupted one: only the user's own words, or a bare nudge. The harness's note about the turn goes to
     *  the model as a developer message, injected once for this interrupted turn (every turn opens with `thread/resume`, so injecting on each
     *  would repeat it). With no statuses-only note to give, nothing is injected: the full note carries tool outputs and goes in no slot of the model's. */
    async resumeTurn(note: { turn: { since: number }; pending: { text?: string }[] }, owed: { text?: string }[]): Promise<string> {
      await arm(note.turn.since);
      const system = recoverySystemNote(ctx.state());
      const noted = (await journal.read<{ since: number }>(RECOVERY_NOTE_STREAM)).some((r) => r.data.since === note.turn.since);
      if (system !== undefined && !noted) {
        await deps.guard(deps.rpc().request("thread/inject_items", { threadId: deps.threadId(), items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: system }] }] }));
        // The injected item is in the log before it is recorded as injected: a record without it would leave the note out of every later resume.
        await deps.guard(synced());
        journal.append(RECOVERY_NOTE_STREAM, { since: note.turn.since });
        await deps.guard(journal.flush());
      }
      return recoveryUserTurn(owed.map((s) => s.text ?? ""), note.pending.map((s) => s.text ?? ""));
    },

    /** A turn ended: the calls answered from the log were for it alone. */
    turnEnded(): void {
      recovered.clear();
    },
  };
}

export type { RolloutSummary };
