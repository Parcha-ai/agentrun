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
import type { OwnCalls } from "@parcha/agentrun-kernel";
import type { DriveContext, SessionState } from "./host/kernel.js";
import type { ResultBudget, SessionMachine } from "./host/process.js";
import { boundKey, boundResult, failureText, openTurn, recoveryNote, recoverySystemNote, recoveryUserTurn, toolKey, transcriptOf } from "./host/process.js";
// cycle with harness.ts: read repairOutput only inside functions, never at module top level (pinned by "code mode and the harness
// load in either order and the repair reads repairOutput"). A host loads harness.js first, so at that point none of its const bindings is set.
import { repairOutput } from "./harness.js";
import { type RolloutSummary, summarizeRollout } from "./rollout.js";
import { callKey, completedNested, execRecovery, NESTED_CALL, type NestedFact, outputTextOf, parkedKey, recoveredFailed, recoveredRowText, recoveryFacts, Scripts, settle, UNWATCHED, waitResumed } from "./scripts.js";

/** The stream that ties each nested call to the `exec` it ran under: `{ callId, exec, since }` (`since`: the turn it ran in), written before the call runs. */
export const NESTED_STREAM = "codex.nested";
/** The stream that records the interrupted turns whose recovery note was injected: `{ since }`, once per interrupted turn. */
export const RECOVERY_NOTE_STREAM = "codex.recovery-note";
/** A yielded exec's nested call run on a resume (recoverItems), written before it runs: a later recovery of the same turn tells
 *  the model's `wait` its outcome from the session's record, never running it again. */
export const RESUMED_STREAM = "codex.nested-resumed";
/** The nested calls whose outcome a resume's recovered script output tells (recoverItems): `{ since, callIds }`, written before
 *  that output is injected, so the turn's recovery note says the outcome is there, after a crash between the two as well. */
export const SHOWN_STREAM = "codex.nested-shown";
/** Each `exec` a recovery answered (recoverItems), directly or through the `wait` on its cell, and whether that answer tells a
 *  script that failed (recoveredFailed): `{ exec, failed }`, written before the answer is injected. That answer carries no status
 *  header for its rollout line to be read by, so the exec's end on the host's record, live or replayed after a later crash, reads this. */
export const RECOVERED_END_STREAM = "codex.exec-recovered-end";

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
  /** The tool bridge; `take` gives a call's images and value once (host/process.ts), for the answer to Codex. */
  bridge: {
    get(name: string): { name: string; replay: string } | undefined;
    take?(callId: string): { images?: readonly { mimeType: string; data: string }[]; structured?: unknown } | undefined;
    /** A call through the bridge (gate, intent, call, result): a resumed nested call that never reached its intent (recoverItems). */
    call?(name: string, args: unknown, callId: string): Promise<{ text: string; isError: boolean }>;
  };
  log(message: string, fields?: Record<string, unknown>): void;
  /** The rollout lines restored from the log. */
  lines: readonly string[];
  rpc(): { request(method: string, params: Record<string, unknown>): Promise<unknown> };
  guard<T>(promise: Promise<T>): Promise<T>;
  threadId(): string;
  /** How often the barrier looks again for a script's line, and what a declined call is told. */
  tries: number;
  declined: string;
  /** The host's record of each `exec` (SessionIO.ownCalls): its row from its rollout lines, and each nested call it makes
   *  named under it before the call reaches the gate. */
  ownCalls?: OwnCalls;
  /** The bridge's budget (CodexHarnessOptions.resultBudget): a result handed Codex from the log is held to it as the
   *  bridge holds one it runs. */
  budget?: ResultBudget;
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

/** A nested call's tie record: its exec, the turn it ran in, and the call itself (Codex's name for its tool, its arguments), so a
 *  resume can run a call that never reached its intent (a park held it at the host's gate) under its own id. */
type Tie = { callId: string; exec: string | null; since?: number; tool?: string; args?: unknown };

/** What the log holds of one nested call: the session's record, the rollout's completion line, and what the turn's recovery note
 *  calls it (`told`, by call id). */
/** What a script's nested call of a tool with a value was sent (scriptAnswer's text), from the tool's stored answer: the rollout
 *  holds that text, not the words the store keeps, so recovery compares the two. None for a tool with no value. */
function sentOf(output: unknown): { sent: string } | Record<string, never> {
  const kept = output as { structured?: unknown; images?: readonly Image[] } | null;
  if (kept === null || typeof kept !== "object" || kept.structured === undefined) return {};
  return { sent: JSON.stringify(withImageData(kept.structured, kept.images ?? [])) };
}

/** A failed call's error as the bridge handed it (`failureText`: its message, or words saying it had none). */
const failedText = (error: Parameters<typeof failureText>[0] | undefined): string => (error ? failureText(error) : "");

function factOf(state: SessionState, rolled: ReturnType<typeof completedNested>, tie: { callId: string; tool?: string }, told: ReadonlyMap<string, NestedFact["told"]> = new Map()): NestedFact {
  const e = state.effects.get(toolKey(tie.callId));
  const status = told.get(tie.callId);
  // The bridge's record of the cut it handed Codex, if it cut the result: what settle compares the two records on.
  const cut = state.effects.get(boundKey(tie.callId));
  const bound = cut?.status === "completed" ? (cut.output as { kept?: unknown; whole?: unknown } | null) : undefined;
  const lengths = bound && typeof bound.kept === "number" && typeof bound.whole === "number" ? { bound: { kept: bound.kept, whole: bound.whole } } : {};
  return {
    callId: tie.callId,
    tool: e ? e.name.replace(/^tool\./, "") : (rolled.get(tie.callId)?.tool ?? tie.tool ?? "a tool"),
    ...(e ? { store: { status: e.status === "completed" ? "completed" : e.status === "failed" ? "failed" : "started", text: e.status === "failed" ? failedText(e.error) : outputTextOf(e.output), ...(e.status === "completed" ? sentOf(e.output) : {}), ...(e.error?.interrupted ? { interrupted: true } : {}), ...lengths } as NonNullable<NestedFact["store"]> } : {}),
    ...(rolled.has(tie.callId) ? { rollout: rolled.get(tie.callId)! } : {}),
    ...(status ? { told: status } : {}),
    ...(state.effects.get(parkedKey(tie.callId))?.status === "completed" ? { parked: true as const } : {}),
  };
}

/** A recorded result that held images (bridgeTool's `{ text, images }`) as its text and a line saying how many, which are not
 *  shown again after the interruption; undefined for a result with none, whose repaired output stays as it is. */
export function imagesNoted(output: unknown): string | undefined {
  const images = (output as { images?: unknown } | null)?.images;
  const count = Array.isArray(images) ? images.length : 0;
  if (!count) return undefined;
  return `${outputTextOf(output)}\n\nIt also returned ${count} image${count === 1 ? "" : "s"} (not shown again after the interruption).`;
}

type Image = { mimeType: string; data: string };

/** `value` with `images`' data put back, in order, into its image objects (`{ type: "image", mimeType }` with no data,
 *  as a computer tool's value leaves them): the value whole, as serve's own script isolate gives a script. */
export function withImageData(value: unknown, images: readonly Image[]): unknown {
  let next = 0;
  const fill = (part: unknown): unknown => {
    if (Array.isArray(part)) return part.map(fill);
    if (part === null || typeof part !== "object") return part;
    const record = part as Record<string, unknown>;
    if (record.type === "image" && record.data === undefined && next < images.length) return { ...record, data: images[next++]!.data };
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, fill(entry)]));
  };
  return fill(value);
}

/** A nested call's answer from a tool with no value: its items, then a line saying how many images the tool returned,
 *  which are not sent (Codex gives a script an image as its data: URL in the result's text, so a script that prints the
 *  result would send the model the base64 as words); an answer of any other shape, or no images, as it is. */
export function withImagesHeld(answer: unknown, images: readonly unknown[] | undefined): unknown {
  const items = (answer as { contentItems?: unknown } | null)?.contentItems;
  if (!images?.length || !Array.isArray(items)) return answer;
  const count = images.length;
  return { ...(answer as object), contentItems: [...items, { type: "inputText", text: `${count} image${count === 1 ? "" : "s"} it returned ${count === 1 ? "was" : "were"} not sent: in code mode a tool's image reaches the script only as text.` }] };
}

/** A code-mode script's nested call's answer. A tool with a value (a computer tool's) answers the value as JSON text,
 *  its images' data back in it, so the script reads it with JSON.parse and holds each image whole, to compute on or
 *  pass on; any other tool answers its words and a line on its images, which are not sent (`withImagesHeld`). A failed
 *  call's answer, or one of any other shape, as it is. */
export function scriptAnswer(answer: unknown, extras: { images?: readonly Image[]; structured?: unknown } | undefined): unknown {
  const shaped = answer as { contentItems?: unknown; success?: unknown } | null;
  if (extras?.structured === undefined || !Array.isArray(shaped?.contentItems) || shaped.success === false) return withImagesHeld(answer, extras?.images);
  return { ...shaped, contentItems: [{ type: "inputText", text: JSON.stringify(withImageData(extras.structured, extras.images ?? [])) }] };
}

/** A dynamic tool call's answer with `images` after its items, each `{ type: "inputImage", imageUrl }` with a data: URL
 *  (Codex 0.164's DynamicToolCallOutputContentItem); an answer of any other shape, or no images, as it is. */
export function withImages(answer: unknown, images: readonly { mimeType: string; data: string }[] | undefined): unknown {
  const items = (answer as { contentItems?: unknown } | null)?.contentItems;
  if (!images?.length || !Array.isArray(items)) return answer;
  return { ...(answer as object), contentItems: [...items, ...images.map((image) => ({ type: "inputImage", imageUrl: `data:${image.mimeType};base64,${image.data}` }))] };
}

export function codeMode(deps: CodeModeDeps) {
  const { ctx, machine, journal, logged, synced } = deps;
  const scripts = new Scripts();
  /** The exec each nested call was admitted under. */
  const execOf = new Map<string, string>();
  /** After a recovery: the `never` calls the log holds a completed outcome for, by tool and arguments, until the turn ends. Each answers one re-issue. */
  const recovered = new Map<string, { tool: string; text: string; sent?: string }[]>();
  /** Each `exec` whose row this drive opened on the host's record (SessionIO.ownCalls): its end waits for that write. */
  const rows = new Map<string, Promise<void>>();
  /** The host's record of `exec`'s end, once its row is written: `output`, failed as a recovery recorded it (RECOVERED_END_STREAM)
   *  or else as its status header says (`failed`). A crash leaves an exec open on the record (its start is marked as one its
   *  harness answers), so its end is always one of these. A recovered exec that ended ok shows its calls' outcomes without
   *  the words telling the model its script was cut short (recoveredRowText): on the record, those are a failed exec's. */
  const endRow = (exec: string, output: string, failed: boolean): void => {
    const own = deps.ownCalls;
    if (!own) return;
    void (rows.get(exec) ?? Promise.resolve())
      .then(() => journal.read<{ exec: string; failed: boolean }>(RECOVERED_END_STREAM))
      .then((kept) => {
        const recovered = kept.findLast((r) => r.data.exec === exec)?.data;
        return recovered ? own.ended(exec, recoveredRowText(output, recovered.failed), recovered.failed) : own.ended(exec, output, failed);
      })
      .catch((error) => deps.log("codex: an exec's end was not written", { exec, error: String(error) }));
  };
  // An `exec` of the log restored that Codex finished before the session stopped: its end, which a crash may have kept off
  // the host's record (a call ended there already says nothing).
  for (const line of deps.lines) {
    const said = scripts.note(line);
    if (said?.kind === "finished") endRow(said.exec, said.output, said.failed);
  }
  /** The host's row of the `exec` `exec`, opened once with its script (`{ script }`, as codemode's own input is held), from
   *  its rollout line or, before that line is in the rollout, from the proxy's announcement. */
  const openRow = (exec: string, input: string | undefined): Promise<void> => {
    const own = deps.ownCalls;
    if (!own) return Promise.resolve();
    let row = rows.get(exec);
    if (!row) rows.set(exec, (row = own.opened(exec, "exec", input === undefined ? {} : { script: input })));
    return row;
  };
  // The lines read live open an `exec`'s row and end it. An `exec` of the log restored is on the host's record already; a
  // cut-off one ends here too, when its recovered output (recoverItems) reaches the rollout: after the rows of the calls the
  // recovery ran or found cut off, failed as the recovery recorded (RECOVERED_END_STREAM).
  machine.onRolloutLine?.((line) => {
    const said = scripts.note(line);
    if (!said || !deps.ownCalls) return;
    if (said.kind === "opened") void openRow(said.exec, said.input).catch((error) => deps.log("codex: an exec's row was not written", { exec: said.exec, error: String(error) }));
    else endRow(said.exec, said.output, said.failed);
  });

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
      recovered.set(key, [...(recovered.get(key) ?? []), { tool: fact.tool, text: settled.text, ...(fact.store?.sent !== undefined ? { sent: fact.store.sent } : {}) }]);
    }
  };

  /** A `never` call the log holds a completed outcome for, re-issued after a recovery: its answer from the log, taken once. Held
   *  to the host's bound as the bridge holds a call's result (`boundResult`): the log keeps the result whole. */
  function answeredAgain(tool: string, args: unknown, callId?: string): string | undefined {
    const again = recovered.get(callKey(tool, args))?.shift();
    if (!again) return undefined;
    deps.log("codex: answered a never call from the log: it completed before the interruption", { ...(callId ? { callId } : {}), tool: again.tool });
    // A script's call of a tool with a value gets that value's JSON again, as the first call did (scriptAnswer): the script
    // parses it, so no words go before it.
    if (callId !== undefined && NESTED_CALL.test(callId) && again.sent !== undefined) return again.sent;
    return boundResult(`Recorded earlier in this turn, not run again: ${again.text}`, deps.budget).text;
  }

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
          const again = tool?.replay === "never" ? answeredAgain(tool.name, p.arguments, callId) : undefined;
          if (again !== undefined) return { contentItems: [{ type: "inputText", text: again }], success: true };
          if (NESTED_CALL.test(callId)) {
            if (tool?.replay === "never" && !ctx.isMemoized(toolKey(callId)) && !(await admit(callId))) return declined;
            const tie = tieNow();
            const exec = execOf.get(callId) ?? (tie.kind === "tied" || tie.kind === "held" ? tie.exec : undefined);
            if (exec) execOf.set(callId, exec);
            // On the host's record the call sits under its exec's row, written first (from the proxy's announcement when the
            // exec's line is not in the rollout yet), as a codemode script's calls sit under its call on every other harness.
            // A call tied to no known exec names none: no parent is made up.
            if (exec && exec !== UNWATCHED && deps.ownCalls) {
              await openRow(exec, scripts.inputOf(exec) ?? machine.announcedInput?.(exec)).catch((error) => deps.log("codex: an exec's row was not written", { exec, error: String(error) }));
              deps.ownCalls.nestedIn(callId, exec);
            }
            // Never the unwatched-answer marker: a call tied to no known exec is journaled with none.
            journal.append(NESTED_STREAM, { callId, exec: exec === undefined || exec === UNWATCHED ? null : exec, since: openTurn(ctx.state())?.since ?? -1, tool: String(p.tool), args: p.arguments ?? {} } satisfies Tie);
          }
          // The harness answers with the result's text; its images follow as `inputImage` items, which Codex 0.164's
          // dynamic tool output takes (DynamicToolCallResponse.contentItems, its app-server schema), each a data: URL.
          // The call runs first (`next`): its images and value are kept by the bridge as it answers, and taken after,
          // whether or not the answer was built, so a call whose answer throws leaves none in the bridge for the session's life.
          let extras: { images?: readonly Image[]; structured?: unknown } | undefined;
          let answer: unknown;
          try {
            answer = await next(req);
          } finally {
            extras = deps.bridge.take?.(callId);
          }
          // A script's nested call gets the tool's value, images and all, to compute on (scriptAnswer); the model's own
          // call gets the words and the images to look at.
          return NESTED_CALL.test(callId) ? scriptAnswer(answer, extras) : withImages(answer, extras?.images);
        }
        return next(req);
      };
    },

    /** The outputs injected for the calls the rollout left dangling: a cut-off `exec` gets a custom tool call output from the log, in place of `items`';
     *  any other call keeps its generic output, as an item of its own kind, and code mode's `wait` is told that it had started. `since`: the
     *  turn the dangling calls ran in: the interrupted one a recovery note resumes, or with none, the turn that ended last. Every output is then
     *  held to the host's bound as the tool bridge holds a call's result (`boundResult`): these come from the log, not through the bridge, and
     *  both repairs (with a recovery note and without) inject what this leaves. A recovered script's output (a cut-off exec's, a resumed
     *  `wait`'s) quotes each finished call's result as the script was handed it and holds its whole to its own bound
     *  (scripts.ts recoveryMaxChars, at the session's window); on a resume, the calls it tells the outcome of are recorded for the note (SHOWN_STREAM). `resume`: the open turn a recovery note resumes, whose
     *  parked nested calls run now; the repair of an ended turn (repairUnnoted) only tells, and runs nothing. */
    async recoverItems(items: Record<string, unknown>[], dangling: readonly Dangling[], lines: readonly string[], since: number, resume = false): Promise<void> {
      const ties = (await journal.read<Tie>(NESTED_STREAM)).map((r) => r.data);
      const execs = dangling.filter(isExec).map((d) => d.callId);
      const rolled = completedNested(lines);
      // A nested call of a cut-off exec that never reached its intent and that Codex was never answered (its script went with
      // the session: the host's gate parked it for a person's approval, or a crash came before its intent) runs now, through
      // the bridge under its own id, the gate first, so the person's answer on it holds, as a dangling call of the model's own
      // does (resumeUnstartedCalls): its outcome is the exec's output, and nothing runs it again. A gate that parks again
      // rejects out of here, nothing written. Only on the resume of the open turn: an ended turn's repair runs nothing, so a call a
      // person may never have answered does not run on a later turn. A script whose exec had yielded ("Script running") made
      // its call in this turn while the model waited on its cell: that call runs too, and the dangling `wait` tells its
      // outcome (with none dangling there is nowhere to tell it, and it does not run).
      const resumed = new Map<string, NonNullable<NestedFact["resumed"]>>();
      const cut = new Set(execs);
      const carrier = dangling.findIndex((c) => !isExec(c) && waitedCell(c) !== undefined);
      const yieldedTies: Tie[] = [];
      const ranBefore = resume ? new Set((await journal.read<{ callId: string }>(RESUMED_STREAM)).map((r) => r.data.callId)) : new Set<string>();
      for (const tie of resume ? ties : []) {
        const cutOff = tie.exec === null ? tie.since === since && execs.length > 0 : cut.has(tie.exec);
        const yielded = !cutOff && carrier >= 0 && tie.since === since;
        const done = ctx.state().effects.get(toolKey(tie.callId));
        // Run on an earlier recovery of this turn that stopped before the wait was answered: told from its record.
        if (yielded && ranBefore.has(tie.callId) && (done?.status === "completed" || done?.status === "failed") && !rolled.has(tie.callId)) {
          resumed.set(tie.callId, { text: done.status === "failed" ? failedText(done.error) : outputTextOf(done.output), isError: done.status === "failed", ran: true });
          yieldedTies.push(tie);
          continue;
        }
        if ((!cutOff && !yielded) || tie.tool === undefined || done || rolled.has(tie.callId)) continue;
        if (!deps.bridge.call || !deps.bridge.get(tie.tool)) continue;
        if (yielded) {
          journal.append(RESUMED_STREAM, { callId: tie.callId });
          await journal.flush();
        }
        const result = await deps.bridge.call(tie.tool, tie.args ?? {}, tie.callId);
        resumed.set(tie.callId, { text: result.text, isError: result.isError, ran: ctx.state().effects.has(toolKey(tie.callId)) });
        if (yielded) yieldedTies.push(tie);
      }
      const state: SessionState = ctx.state();
      // Each cut-off exec lists its own calls. A call whose script could not be told when it ran (an answer the proxy did not see to its end)
      // is listed once, apart, in the LAST cut-off exec's output, if it ran in this interrupted turn.
      const told = new Map((recoveryNote(state)?.calls ?? []).map((c) => [c.callId, c.status] as const));
      const fact = (tie: Tie): NestedFact => ({ ...factOf(state, rolled, tie, told), ...(resumed.has(tie.callId) ? { resumed: resumed.get(tie.callId)! } : {}) });
      const listed = recoveryFacts(execs, ties, since, fact);
      // The exec each dangling `wait`'s cell belongs to, as the rollout has it.
      const yielders = new Scripts();
      for (const line of lines) yielders.note(line);
      // The outputs built here hold their quoted results to their own bound (scripts.ts recoveryMaxChars, at the session's window): every other is
      // held to the host's below. The calls whose outcome they tell, for the turn's recovery note.
      const built = new Set<number>();
      const shown: string[] = [];
      // Each output is one result the model reads in this turn: it claims its room in the turn's budget (the answer's facts,
      // taken back from the journal by a new process), as a call through the bridge does, and is held to that claim.
      const turn = deps.budget?.turn;
      await turn?.ready();
      const budgets = dangling.map((c) => (deps.budget && turn ? { ...deps.budget, maxChars: turn.claim(c.callId, deps.budget.contextWindow) } : deps.budget));
      dangling.forEach((c, i) => {
        if (!isExec(c)) {
          // Code mode's `wait` on a cell had started: the generic answer, that the call never started, would be false.
          const cell = waitedCell(c);
          const item = items[i] as { call_id?: unknown; output?: unknown };
          // A completed call whose result held images (bridgeTool records { text, images }): repairOutput gives the record
          // as JSON, so the model would read their base64 as text. Its text and a line on them instead; they are not sent.
          const done = state.effects.get(toolKey(c.callId));
          const pictured = cell === undefined && done?.status === "completed" ? imagesNoted(done.output) : undefined;
          const answered = cell !== undefined && i === carrier && yieldedTies.length > 0 ? yieldedTies.map((tie) => ({ ...factOf(state, rolled, tie, told), resumed: resumed.get(tie.callId)! })) : undefined;
          const recovered = answered && cell !== undefined ? waitResumed(cell, answered, budgets[i]) : undefined;
          const waited = cell === undefined ? undefined : recovered ? recovered.output : waitStoppedText(cell);
          if (recovered) {
            built.add(i);
            shown.push(...recovered.shown);
          }
          // This output finishes the cell's exec, and it carries no status header: that exec ends as its last call says.
          const exec = cell === undefined ? undefined : yielders.execOn(cell);
          if (exec !== undefined) journal.append(RECOVERED_END_STREAM, { exec, failed: recoveredFailed(ties.filter((tie) => tie.exec === exec).map(fact)) });
          items[i] = withOutputKind(waited !== undefined ? { ...item, output: waited } : pictured !== undefined ? { ...item, output: pictured } : item, c);
          return;
        }
        const { own, loose } = listed.get(c.callId)!;
        // Only the calls the output still tells after its bound: a call cut from it is not said to be above.
        const recovered = execRecovery(own, loose, budgets[i]);
        items[i] = { type: "custom_tool_call_output", call_id: c.callId, output: recovered.output };
        journal.append(RECOVERED_END_STREAM, { exec: c.callId, failed: recoveredFailed(own) });
        built.add(i);
        shown.push(...recovered.shown);
      });
      items.forEach((item, i) => {
        if (!built.has(i) && typeof item.output === "string") item.output = boundResult(item.output, budgets[i]).text;
        if (typeof item.output === "string") turn?.settle(dangling[i]!.callId, item.output.length);
      });
      if (resume && shown.length > 0) journal.append(SHOWN_STREAM, { since, callIds: shown });
      // Every record above is in the log before the outputs are injected.
      await journal.flush();
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
      // The calls whose outcome a recovered script output of this turn tells: the note says it is there, not that it is not shown.
      const shown = new Set((await journal.read<{ since: number; callIds: string[] }>(SHOWN_STREAM)).filter((r) => r.data.since === note.turn.since).flatMap((r) => r.data.callIds));
      const system = recoverySystemNote(ctx.state(), shown);
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
