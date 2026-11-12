// A held computer's routes (computer-held.ts has the contract): POST /v2/runs/{id}/start starts a held run's agent, POST
// /v2/runs/{id}/computer/call sends the run's computer one protocol call and answers what it answered, and POST
// /v2/runs/{id}/computer/release lets the computer go. The run read's computer field says where the hold is (`held`).
//
// Each route writes a command row and waits for the run's runner to deal with it: taken by the commit that writes what came
// of it to the run's journal, or refused in words. Nothing is kept in this process, so any server answers the same.
//
// They are the owner's: the server's token or the owner's session. A run never holds the server's token (runner/main.ts
// RUNNER_ONLY), so no run's agent reaches its own computer this way: it drives it through its tools.
import { type ComputerCallOptions, type ComputerCallStore, entriesOf, runOver } from "./computer-commands.js";
import { callAnswerIn, COMPUTER_CALL, COMPUTER_RELEASE, COMPUTER_START, HELD_CALL_MS, heldIn, type HeldState, holdIssues, PROTOCOL_METHODS } from "./computer-held.js";
import { ApiError, invalid } from "./errors.js";
import { readLaunchBody } from "./run-launch.js";
import { RunFinal, type Store } from "./store/index.js";
import { unknownFields } from "./validate.js";

export { holdIssues };

/** The routes' names in serve's route table. */
export const HELD_ROUTES: ReadonlySet<string> = new Set(["startRun", "callRunComputer", "releaseRunComputer"]);

/** The slice of the store the routes read and write. */
export type HeldStore = ComputerCallStore & Pick<Store, "runs">;

/** Where the routes read from, their clock, and how often and how long they wait for the runner (a test's own). */
export type HeldOptions = ComputerCallOptions & { readonly pollMs?: number; readonly waitMs?: number };

/** How long a start or a release waits for the runner to take its row; a call waits its own run time on top. */
const TAKE_MS = 60_000;

/** The hold run `runId`'s launch asked for, or undefined when it holds no computer. */
async function holdOfRun(store: Pick<Store, "runs">, runId: string): Promise<{ minutes: number } | undefined> {
  return store.runs.launch(runId).then((row) => readLaunchBody(row.body)?.hold, () => undefined);
}

/** The run read's `computer.held`: where the run's hold is ("starting" until its computer first comes up held), its
 *  minutes, when it lapses with no call, and why it ended when no release did. Undefined for a run that holds none. */
export async function heldField(store: HeldStore, runId: string, options: HeldOptions = {}): Promise<{ state: HeldState | "starting"; minutes: number; until?: string; why?: string } | undefined> {
  const hold = await holdOfRun(store, runId);
  if (!hold) return undefined;
  const read = heldIn(await entriesOf(store, runId, options));
  if (!read) return (await runOver(store, runId)) ? { state: "released", minutes: hold.minutes } : { state: "starting", minutes: hold.minutes };
  // A run that ended while it held its computer (a stop, a failure) let it go with its end.
  const state = read.state !== "released" && (await runOver(store, runId)) ? "released" : read.state;
  return { state, minutes: read.minutes, ...(state === "released" ? {} : { until: new Date(read.until).toISOString() }), ...(read.why ? { why: read.why } : {}) };
}

/** Waits for the runner to deal with row `id` of run `runId`: taken, or refused in words. Undefined when it did neither
 *  within `waitMs` (a run with no runner now). A run that ended meanwhile refuses it. */
async function outcomeOf(store: HeldStore, runId: string, id: number, waitMs: number, pollMs: number): Promise<{ taken: true } | { refused: string } | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = (await store.commands(runId, id - 1)).find((one) => one.id === id);
    if (row?.refused !== null && row?.refused !== undefined) return { refused: row.refused };
    if (row?.takenAt !== null && row?.takenAt !== undefined) return { taken: true };
    if (await runOver(store, runId)) return { refused: "The run ended, and its computer was let go with it." };
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * One of the routes (HELD_ROUTES, by its name in serve's route table) for run `runId`. 404 for a run that holds no
 * computer, and for a release of one already let go; 409 computer_not_live when the hold is not where the route needs it
 * (not up yet, already started, released); 503 when the runner took no row in time. A call answers the computer's answer
 * as it gave it: `{ ok: true, value }` or `{ ok: false, error }`.
 */
export async function heldRoute(name: string, runId: string, body: unknown, store: HeldStore, options: HeldOptions = {}): Promise<unknown> {
  const given = body ?? {};
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new ApiError("input_invalid", "the body is a JSON object");
  const fields = given as Record<string, unknown>;
  const issues = unknownFields(fields, name === "callRunComputer" ? ["method", "params"] : []);
  if (name === "callRunComputer") {
    if (typeof fields.method !== "string" || !PROTOCOL_METHODS.includes(fields.method)) {
      issues.push({ field: "method", reason: fields.method === undefined ? "missing" : "not_an_option", message: `method is one of the computer protocol's methods: ${PROTOCOL_METHODS.join(", ")}` });
    }
    if (fields.params !== undefined && (typeof fields.params !== "object" || fields.params === null || Array.isArray(fields.params))) issues.push({ field: "params", reason: "wrong_type", message: "params is an object: the method's params" });
  }
  if (issues.length) throw invalid(issues);
  if (!(await holdOfRun(store, runId))) throw new ApiError("not_found", `run ${runId} holds no computer: a run started with hold: true holds one`);
  const read = heldIn(await entriesOf(store, runId, options));
  const over = await runOver(store, runId);
  if (name === "releaseRunComputer" && (over || read?.state === "released")) throw new ApiError("not_found", `run ${runId}'s computer was already let go`);
  if (over || read?.state === "released") throw new ApiError("computer_not_live", `run ${runId}'s computer was let go${read?.why === "timeout" ? `: no call came for ${read.minutes} minutes` : ""}`);
  if (read === undefined) throw new ApiError("computer_not_live", `run ${runId}'s computer is not up yet: the run waits for a runner to claim it`);
  if (name === "startRun" && read.state !== "waiting") throw new ApiError("computer_not_live", `run ${runId}'s agent has already started`);
  const kind = name === "startRun" ? COMPUTER_START : name === "releaseRunComputer" ? COMPUTER_RELEASE : COMPUTER_CALL;
  let row;
  try {
    row = await store.command(runId, { kind, body: kind === COMPUTER_CALL ? { method: fields.method, params: fields.params ?? {} } : {} });
  } catch (error) {
    if (error instanceof RunFinal) throw new ApiError("computer_not_live", `run ${runId} ended, and its computer was let go with it`);
    throw error;
  }
  const outcome = await outcomeOf(store, runId, row.id, (options.waitMs ?? TAKE_MS) + (kind === COMPUTER_CALL ? HELD_CALL_MS : 0), options.pollMs ?? 100);
  if (outcome === undefined) throw new ApiError("unavailable", `run ${runId}'s runner did not take the ${name === "callRunComputer" ? "call" : name === "startRun" ? "start" : "release"} in time: is a runner up?`);
  if ("refused" in outcome) throw new ApiError("computer_not_live", outcome.refused);
  if (kind === COMPUTER_CALL) return callAnswerIn(await entriesOf(store, runId, options), row.id) ?? { ok: false, error: { code: "gone", message: "the call's answer is not in the run's journal" } };
  return { held: { state: kind === COMPUTER_START ? "started" : "released" } };
}
