// codemode's Python (`language: "python"`): the script runs in Monty (@pydantic/monty), a Python subset interpreter written
// in Rust, in a worker subprocess of its own, by the JavaScript script's rules (meta-tools.ts runScript). The run's tools
// are the module `tools` (imported by a feed ahead of the script's, so `tools.<name>` works without an import), each a host
// function: a call pauses the script, becomes a nested call (asked about at the gate as that tool, its intent and outcome
// recorded under `<callId>/s<n>`), and its outcome resumes the script as the awaited value, or raises. A refusal, a call cut
// by a crash, or (in a rerun after a park or a crash) the first call that runs now ends the script with the JavaScript
// path's words (endedWith). The clock, the random seed and the tools are the call's first run's (scriptStart), so a rerun
// makes the same calls and the recorded ones answer from their records.
//
// Monty is an optional dependency, loaded on the first Python script: an install without it runs JavaScript scripts as
// ever, and a Python one answers that the package is missing. The script sees its tools and nothing else of the run: no
// environment, files, network or packages; time.sleep returns at once and the clock reads the first run's start.
//
// Limits, as the JavaScript script's: 256 MB of memory and 600 s for the whole script, its calls' time included (Monty's
// own limits bound its memory and its execution time; the host's deadline kills the worker past the whole, and cuts the
// tool call the script waits on). Beyond the JavaScript path's: at most CODEMODE_PY_CALLS tool calls, printed output of
// at most HOST_RESULT_MAX_CHARS characters, and a recursion depth of Monty's 1,000.
import type { CodemodeOutputItem } from "@earendil-works/pi-codemode";
import { HOST_RESULT_MAX_CHARS, type HostTool, type JsonValue, type NestedCalls, type NestedResult } from "@parcha/agentrun-kernel";
import { withoutImageData } from "@parcha/agentrun-computer/surface";
import type { FunctionSnapshot, FutureResolution, MontySession, Snapshot } from "@pydantic/monty";

import { CODEMODE } from "../meta-tool-names.js";
import { CODEMODE_MEMORY_BYTES, CODEMODE_MS, endedWith, imagesIn, type ScriptAnswer, scriptStart, scriptValue, shownOf } from "./meta-tools.js";

/** The package that runs a Python script: one of the server's optionalDependencies. */
export const MONTY_PACKAGE = "@pydantic/monty";
/** The most tool calls one Python script may make. */
export const CODEMODE_PY_CALLS = 1_000;
/** Monty's own bound on the times a script pauses for its host (each call, each wait for one, each import): a backstop
 *  past the call bound, for a script that loops over imports or image(). */
const MONTY_SUSPENSIONS = 10 * CODEMODE_PY_CALLS;

type Monty = typeof import("@pydantic/monty");
let loading: Promise<Monty> | undefined;

/** Monty, loaded once; rejected (and the reason kept) where it is not installed. */
function monty(): Promise<Monty> {
  loading ??= import(MONTY_PACKAGE) as Promise<Monty>;
  return loading;
}

/** A Python identifier for a tool's name as a script's `tools` gives it: its JavaScript one (scriptStart's jsName) with
 *  each character Python's identifiers lack (`$`, and any non-ASCII one) as `_`. */
const pythonName = (jsName: string) => jsName.replace(/[^A-Za-z0-9_]/g, "_");

/** A value out of Monty as JSON: a dict is an object (its keys as strings), a set or tuple an array, an int too big for a
 *  number its digits, bytes base64. */
function plain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, inner]) => [String(key), plain(inner)]));
  if (value instanceof Set || Array.isArray(value)) return [...value].map(plain);
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
  return value;
}

/** A call's arguments as its tool takes them: one dict, keyword arguments, or both (the keywords win); else why not. */
function argumentsOf(call: FunctionSnapshot): Record<string, unknown> | string {
  const given = call.args.map(plain);
  const keywords = plain(call.kwargs) as Record<string, unknown>;
  if (given.length > 1 || (given.length === 1 && (given[0] === null || typeof given[0] !== "object" || Array.isArray(given[0])))) return `${call.functionName}() takes one dict of arguments, or keyword arguments`;
  return { ...((given[0] as Record<string, unknown> | undefined) ?? {}), ...keywords };
}

/** Why a script failed, as Monty words it: a Python exception with its traceback, else its summary. */
function failureOf(lib: Monty, error: unknown): string | undefined {
  if (error instanceof lib.MontyRuntimeError || error instanceof lib.MontySyntaxError) return error.display("traceback").trim();
  if (error instanceof lib.MontyError) return error.display("type-msg");
  return undefined;
}

/** Whether loading Monty failed because a package is not installed: Monty itself, or its binary for this platform (none
 *  for musl at 1.6.0), whose loader throws with each failed require's MODULE_NOT_FOUND chained as its cause. */
function notInstalled(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return true;
  let cause = (error as { cause?: unknown } | null)?.cause;
  if (cause === undefined) return false;
  for (; cause !== undefined; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown } | null)?.code !== "MODULE_NOT_FOUND") return false;
  }
  return true;
}

/** Run `script` in Monty over `tools`, each call a nested call answered in the order the script made them, for at most
 *  `ms` (CODEMODE_MS; a test's shorter one). */
export async function runPython(script: string, tools: readonly HostTool[], nested: NestedCalls, signal: AbortSignal, ms = CODEMODE_MS): Promise<ScriptAnswer> {
  let lib: Monty;
  try {
    lib = await monty();
  } catch (error) {
    const why = notInstalled(error) ? `this install lacks the optional package ${MONTY_PACKAGE} or its build for this platform (npm installs both with the server on glibc Linux and macOS, x64 or arm64, and on Windows x64, unless optional dependencies are left out)` : `${MONTY_PACKAGE} did not load: ${(error instanceof Error ? error.message : String(error)).replace(/\.+$/, "")}`;
    return { text: `${CODEMODE} can't run Python here: ${why}. Write the script in JavaScript instead. Nothing was run.`, isError: true };
  }
  let pool: Awaited<ReturnType<Monty["Monty"]["create"]>>;
  try {
    pool = await lib.Monty.create({ minProcesses: 1, maxProcesses: 1, maxCheckoutsPerWorker: 1 });
  } catch (error) {
    return { text: `${CODEMODE} can't run Python here: ${MONTY_PACKAGE} could not start its worker: ${error instanceof Error ? error.message : String(error)}. Write the script in JavaScript instead. Nothing was run.`, isError: true };
  }
  const deadline = AbortSignal.timeout(ms);
  const stop = AbortSignal.any([signal, deadline]);
  let session: MontySession | undefined;
  let kill = () => {};
  const output: CodemodeOutputItem[] = [];
  let printed = "";
  // print() output kept so far, across flushes: at most HOST_RESULT_MAX_CHARS, past which the script is killed.
  let kept = 0;
  let overPrinted = false;
  const print = (text: string) => {
    if (overPrinted) return;
    const room = HOST_RESULT_MAX_CHARS - kept;
    printed += text.slice(0, room);
    kept += Math.min(text.length, room);
    if (text.length > room) {
      overPrinted = true;
      kill();
    }
  };
  // print() output so far, as one text item of the answer (its last newline off, as console.log's item has none).
  const flush = () => {
    if (printed) output.push({ type: "text", text: printed.replace(/\n$/, "") });
    printed = "";
  };
  const overPrint = () => failed(`it printed more than ${HOST_RESULT_MAX_CHARS} characters, the most one script may: its output up to there is above, and nothing after it ran.`);
  const pastDeadline = () => failed(`the script ran past ${ms} ms.`);
  const told: { name: string; result: NestedResult }[] = [];
  const failed = (why: string): ScriptAnswer => {
    flush();
    const shown = shownOf(output, undefined);
    return { text: [shown.text, `The script failed: ${why}`].filter(Boolean).join("\n"), isError: true, ...(shown.images.length ? { images: shown.images } : {}) };
  };
  try {
    const { start, rerun, kept: offered } = await scriptStart(tools, nested);
    const byName = new Map(offered.map((tool) => [pythonName(tool.jsName), tool]));
    session = await pool.checkout({
      scriptName: "script.py",
      externalModules: { tools: new lib.ExternalModule(Object.fromEntries([...byName.keys()].map((name) => [name, () => undefined]))) },
      limits: { maxMemory: CODEMODE_MEMORY_BYTES, maxFeedDurationSecs: ms / 1000, maxSuspensions: MONTY_SUSPENSIONS },
      osPolicy: { datetime: new Date(start.startedAt), randomStart: { seed: start.seed }, sleep: "zero" },
    });
    // The worker is this script's alone (a pool of one, never reused): past the deadline, or once the call is aborted, it
    // is killed mid-turn, which a session's close does not do.
    const pid = session.workerPid;
    kill = () => {
      try {
        if (pid !== undefined) process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    };
    stop.addEventListener("abort", kill, { once: true });
    // A stop that came while the script started (its start read, its worker checked out): an abort listener added
    // after it never hears it, so the worker goes now and no step of the script runs.
    if (stop.aborted) {
      kill();
      stop.throwIfAborted();
    }
    const answers = new Map<number, FutureResolution>();
    let calls = 0;
    // `tools` imported by a feed of its own, ahead of the script's: the script's lines keep their numbers.
    await session.feedRun("import tools");
    stop.throwIfAborted();
    let snap: Snapshot = await session.feedStart(script, {
      inputs: { ALL_TOOLS: offered.map((tool) => ({ name: pythonName(tool.jsName), description: tool.description })) },
      externalLookup: { image: () => undefined },
      printCallback: (_stream, text) => print(text),
    });
    while (!(snap instanceof lib.MontyComplete)) {
      if (snap instanceof lib.FutureSnapshot) {
        // Every task waits on calls already answered (each is answered when made): deliver their outcomes.
        const ids = snap.pendingCallIds.filter((id) => answers.has(id));
        snap = await snap.resume(ids.map((id) => answers.get(id)!));
        for (const id of ids) answers.delete(id);
        continue;
      }
      // A name the script never defined: Python's NameError.
      if (snap instanceof lib.NameLookupSnapshot) {
        snap = await snap.resume();
        continue;
      }
      // An import (Monty's own modules, or `tools` again) or any other OS call: no mounts and no handler, so Monty's own
      // answer (the module, or the call's refusal: no files, environment or clock beyond the session's).
      if (snap.isOsFunction) {
        snap = await snap.resumeAuto();
        continue;
      }
      if (snap.functionName === "image") {
        flush();
        for (const image of imagesIn(plain(snap.args[0]))) output.push({ type: "image", data: image.data, mimeType: image.mimeType });
        snap = await snap.resume(null);
        continue;
      }
      const tool = snap.functionName.startsWith("tools.") ? byName.get(snap.functionName.slice("tools.".length)) : undefined;
      if (!tool) {
        snap = await snap.resumeNotFound();
        continue;
      }
      const args = argumentsOf(snap);
      if (typeof args === "string") {
        snap = await snap.resumeError(new TypeError(args));
        continue;
      }
      calls += 1;
      if (calls > CODEMODE_PY_CALLS) return failed(`it called a tool more than ${CODEMODE_PY_CALLS} times, the most one script may: the calls before ran, and nothing after them.`);
      if (overPrinted) return overPrint();
      // The call runs on the script's stop as well as the run's: past the deadline the host's work is cut too.
      const result = await nested.call(tool.name, args, `s${snap.callId}`, stop);
      told.push({ name: tool.name, result });
      // A refusal, a call cut by a crash, or (in a rerun) the first call that ran now: the script ends with it.
      if (result.refused || result.interrupted || (rerun && result.fresh)) return endedWith(told, result, rerun && result.fresh && !result.refused);
      if (stop.aborted) break;
      answers.set(snap.callId, result.isError ? { callId: snap.callId, error: new Error(result.text) } : { callId: snap.callId, value: scriptValue(result) });
      snap = await snap.resumeFuture();
    }
    if (signal.aborted) throw signal.reason ?? new Error(`${CODEMODE} was stopped`);
    if (deadline.aborted) return pastDeadline();
    if (overPrinted) return overPrint();
    flush();
    // A script whose last line is no expression ends with None: it returned nothing.
    const value = snap instanceof lib.MontyComplete && snap.output !== null ? plain(snap.output) : undefined;
    const shown = shownOf(output, value);
    return { text: shown.text || "(the script returned nothing and showed nothing)", ...(shown.images.length ? { images: shown.images } : {}), ...(value !== undefined ? { structured: withoutImageData(value) as JsonValue } : {}) };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new Error(`${CODEMODE} was stopped`);
    if (deadline.aborted) return pastDeadline();
    if (overPrinted) return overPrint();
    const why = failureOf(lib, error);
    if (why === undefined) throw error;
    return failed(why);
  } finally {
    stop.removeEventListener("abort", kill);
    // A script that ended mid-turn (a refusal, the call bound) leaves its worker paused: it goes with the pool.
    await session?.close().catch(() => {});
    await pool.close();
  }
}
