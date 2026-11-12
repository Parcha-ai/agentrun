// The computer call channel: how a server sends a run's computer one protocol call, from any server process. The server
// writes a `computer_call` row; the runner that holds the run runs the call on the run's computer (runner/computer-
// channel.ts), behind a person's hold as the agent's own calls are, and the journal commit that writes the call's record
// takes the row with the call's answer. The server reads that answer once (Store.answerOf). Nothing is kept in a
// server's memory, so any server answers the same.
//
// A write wakes its reader in this process (Store.watchCommands): the runner beside the server hands the row on at once,
// and the server reads the answer as soon as it is in. A runner in another process finds the row at its next command
// poll, and the server finds its answer at its own (CHANNEL_POLL_MS).
//
// The journal contract (the runner writes it; the server's hold reads it, computer-held.ts):
//   computer.call, `{ by, at, method, ok, ms, code?, steps?, expect? }`: row `by`'s call, as computer-calls.ts records one:
//     never a param's value, never the answer's bytes.
// The row: computer_call `{ method, params, answers: false }`, `params` the call's params as one JSON text (a call answers
// no park: it never wakes a parked run).
//
// POST /v2/runs/{id}/computer/call is the owner's door to it (computer-held-routes.ts); another door, such as an MCP
// route, calls callComputer the same way.
import type { InputIssue } from "./errors.js";
import { ApiError } from "./errors.js";
import { RunFinal, type Store } from "./store/index.js";
import { unknownFields } from "./validate.js";

/** The command row kind the server writes. */
export const COMPUTER_CALL = "computer_call";
/** The journal entry kind the runner commits for each call. */
export const CALL_KIND = "computer.call";

/** The longest one call runs on the computer, a wait for a person's hand-back included, before the runner ends it. */
export const CALL_MS = 120_000;
/** How long the server waits for a runner to take a call's row, on top of the call's own time. */
export const TAKE_MS = 60_000;
/** How often the server reads a call's row when no wake comes (a runner in another process). */
export const CHANNEL_POLL_MS = 250;

/** The computer protocol's methods (spec/computer/protocol.json; a test keeps the two equal). A call names one of them. */
export const PROTOCOL_METHODS: readonly string[] = [
  "apps.install", "apps.launch", "apps.list", "apps.terminate", "deadline.extend", "exec.run", "files.list", "files.mkdir",
  "files.move", "files.read", "files.remove", "files.stat", "files.write", "hello", "input.actions", "mount.sync", "ping", "process.list",
  "process.read", "process.resize", "process.signal", "process.start", "process.wait", "process.write", "screen.read", "screen.shot",
  "screen.watch", "tar.pull.begin", "tar.pull.end", "tar.pull.read", "tar.push.begin", "tar.push.end", "tar.push.write", "ui.act", "ui.observe",
];

/** A call's answer, the computer's own: the method's result, or its error as the protocol gives it. */
export type ComputerAnswer = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly data?: unknown } };

/** One call: a protocol method and its params. */
export type ComputerCall = { readonly method: string; readonly params: Record<string, unknown> };

/** A call body's issues: `method` one of PROTOCOL_METHODS, `params` an object when given, no other field. */
export function callIssues(body: Record<string, unknown>): InputIssue[] {
  const issues = unknownFields(body, ["method", "params"]);
  if (typeof body.method !== "string" || !PROTOCOL_METHODS.includes(body.method)) {
    issues.push({ field: "method", reason: body.method === undefined ? "missing" : "not_an_option", message: `method is one of the computer protocol's methods: ${PROTOCOL_METHODS.join(", ")}` });
  }
  if (body.params !== undefined && (typeof body.params !== "object" || body.params === null || Array.isArray(body.params))) {
    issues.push({ field: "params", reason: "wrong_type", message: "params is an object: the method's params" });
  }
  return issues;
}

/** The slice of the store the channel reads and writes. */
export type ChannelStore = Pick<Store, "command" | "commands" | "runs" | "answerOf" | "watchCommands">;

/** A test's own waits: how often the server reads the row with no wake, and how long it waits for a runner to take it. */
export type ChannelOptions = { readonly pollMs?: number; readonly takeMs?: number };

/** Resolves at run `runId`'s next answered wake, or after `ms`; one per wait. */
function wakes(store: ChannelStore, runId: string): { next(ms: number): Promise<void>; close(): void } {
  let poke: (() => void) | undefined;
  let woke = false;
  const unwatch = store.watchCommands((event) => {
    if (event.runId !== runId || event.what !== "answered") return;
    woke = true;
    poke?.();
  });
  return {
    next: (ms) => {
      if (woke) {
        woke = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(0, ms));
        function done(): void {
          clearTimeout(timer);
          poke = undefined;
          woke = false;
          resolve();
        }
        poke = done;
      });
    },
    close: unwatch,
  };
}

/**
 * Writes row `command` for run `runId` and waits for its runner to deal with it: taken (with the row's id, so its answer
 * can be read), or refused in the runner's words (409 computer_not_live). 409 too when the run ended before the write;
 * 503 when no runner dealt with it within `waitMs`. The channel's write, and a held computer's start and release
 * (computer-held-routes.ts).
 */
export async function sendRow(store: ChannelStore, runId: string, command: { kind: string; body: unknown }, waitMs: number, pollMs: number = CHANNEL_POLL_MS): Promise<number> {
  // Watched before the write, so an answer that lands before the first read still wakes the wait.
  const wait = wakes(store, runId);
  try {
    let row;
    try {
      row = await store.command(runId, command);
    } catch (error) {
      if (error instanceof RunFinal) throw new ApiError("computer_not_live", `run ${runId} ended, and its computer was let go with it`);
      throw error;
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = (await store.commands(runId, row.id - 1)).find((one) => one.id === row.id);
      if (now?.refused !== null && now?.refused !== undefined) throw new ApiError("computer_not_live", now.refused);
      if (now?.takenAt !== null && now?.takenAt !== undefined) return row.id;
      const left = deadline - Date.now();
      if (left <= 0) throw new ApiError("unavailable", `run ${runId}'s runner did not take the row in time: is a runner up?`);
      await wait.next(Math.min(pollMs, left));
    }
  } finally {
    wait.close();
  }
}

/**
 * Sends run `runId`'s computer one call and answers what the computer answered. 404 for no such run; 409
 * computer_not_live when the run is not running (queued, parked, over) or its runner refused the call (no computer that
 * takes calls, its computer let go), in the runner's words; 503 when no runner took the row in time. A call that fails
 * on the computer is still an answer: `{ ok: false, error }`.
 */
export async function callComputer(store: ChannelStore, runId: string, call: ComputerCall, options: ChannelOptions = {}): Promise<ComputerAnswer> {
  const run = await store.runs.get(runId);
  if (!run) throw new ApiError("not_found", `no run ${runId}`);
  if (run.state !== "running") throw new ApiError("computer_not_live", `run ${runId}'s computer is not up now: the run is ${run.state}`);
  // The params as one JSON text: the store never reads into them, and a string Postgres's jsonb refuses (an escaped NUL, a
  // lone surrogate) is only escaped text inside it, so the row settles (store/dialect.ts settledBody) whatever was typed.
  const id = await sendRow(store, runId, { kind: COMPUTER_CALL, body: { method: call.method, params: JSON.stringify(call.params ?? {}), answers: false } }, (options.takeMs ?? TAKE_MS) + CALL_MS, options.pollMs);
  const answer = await store.answerOf(runId, id);
  return (answer?.value as ComputerAnswer | undefined) ?? { ok: false, error: { code: "gone", message: "the call's answer was already read" } };
}
