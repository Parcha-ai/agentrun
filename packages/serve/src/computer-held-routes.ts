// A run's computer, from the owner's side: POST /v2/runs/{id}/computer/call sends it one protocol call through the
// computer call channel (computer-channel.ts) and answers what it answered, for any running run whose computer speaks the
// protocol. A run started with `hold: true` holds its computer for its owner (computer-held.ts has the contract): POST
// /v2/runs/{id}/start starts its agent, and POST /v2/runs/{id}/computer/release lets the computer go. The run read's
// computer field says where the hold is (`held`).
//
// Each route writes a command row and waits for the run's runner to deal with it: taken by the commit that writes what came
// of it to the run's journal, or refused in words. Nothing is kept in this process, so any server answers the same.
//
// They are the owner's: the server's token or the owner's session. A run never holds the server's token (runner/main.ts
// RUNNER_ONLY), so no run's agent reaches its own computer this way: it drives it through its tools.
import { callComputer, callIssues, type ChannelOptions, type ChannelStore, sendRow, TAKE_MS } from "./computer-channel.js";
import { type ComputerCallOptions, type ComputerCallStore, computerHoldOf, entriesOf, runOver } from "./computer-commands.js";
import { COMPUTER_RELEASE, COMPUTER_START, heldIn, type HeldState, holdIssues } from "./computer-held.js";
import { computerOfPlace, type ComputerSetting, type PlaceView } from "./computer-setting.js";
import { ApiError, invalid } from "./errors.js";
import { runComputerField } from "./run-computer.js";
import { readLaunchBody } from "./run-launch.js";
import type { Store } from "./store/index.js";
import { unknownFields } from "./validate.js";

export { holdIssues };

/** The routes' names in serve's route table. */
export const HELD_ROUTES: ReadonlySet<string> = new Set(["startRun", "callRunComputer", "releaseRunComputer"]);

/** The slice of the store the routes read and write. */
export type HeldStore = ComputerCallStore & ChannelStore & Pick<Store, "runs">;

/** Where the routes read from, their clock, and how often and how long they wait for the runner (a test's own). */
export type HeldOptions = ComputerCallOptions & ChannelOptions;

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

/** The run read's `computer` field (`{ computer }`, or nothing for a run with none): its revision's computer setting, else
 *  the one its place says; taken_over while the owner holds its desktop or phone (computerHoldOf, read from the run's
 *  journal only while that computer is up); with `held` for a run that holds its computer for its owner. The journal is
 *  read at most once, and not at all for a run that neither can be taken over nor holds. `view` is the run read so far. */
export async function runComputerRead(store: HeldStore & Pick<Store, "agents">, runId: string, view: Record<string, unknown>, options: HeldOptions = {}): Promise<{ computer?: Record<string, unknown> }> {
  const run = await store.runs.get(runId);
  const body = run ? ((await store.agents.revision(run.revisionId))?.body as { computer?: ComputerSetting; place?: PlaceView } | undefined) : undefined;
  const setting = body?.computer ?? (body?.place ? computerOfPlace(body.place) : undefined);
  if (!setting) return {};
  const error = view.error as { code?: unknown; message?: unknown } | null | undefined;
  const read = { id: runId, status: String(view.status), ...(error && typeof error.code === "string" ? { error: { code: error.code, message: String(error.message ?? "") } } : {}) };
  // The run's journal, read at most once for the whole field (the hold and `held` both read it), and only when one needs
  // it: a long run's every poll would pay for a read that grows with it.
  let journal: Promise<Awaited<ReturnType<typeof entriesOf>>> | undefined;
  const once: HeldOptions = { ...options, entries: () => (journal ??= entriesOf(store, runId, options)) };
  // Who drives: only a desktop or a phone is taken over (a sandbox or a browser never is here), and only while it is up.
  const takeable = setting.kind === "desktop" || setting.kind === "phone";
  const hold = takeable && runComputerField(setting, read)?.state === "ready" ? await computerHoldOf(store, runId, once) : "agent";
  const field = runComputerField(setting, read, (_, state) => (hold === "person" ? "taken_over" : state));
  if (!field) return {};
  const held = await heldField(store, runId, once);
  return { computer: { ...field, ...(held ? { held } : {}) } };
}

/** The body as an object: 422 otherwise. */
function fieldsOf(body: unknown): Record<string, unknown> {
  const given = body ?? {};
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new ApiError("input_invalid", "the body is a JSON object");
  return given as Record<string, unknown>;
}

/**
 * One of the routes (HELD_ROUTES, by its name in serve's route table) for run `runId`.
 * - callRunComputer: the channel's answer (callComputer), the computer's own: `{ ok: true, value }` or `{ ok: false,
 *   error }`. 422 for a method the protocol does not have.
 * - startRun, releaseRunComputer: 404 for a run that holds no computer, and for a release of one already let go; 409
 *   computer_not_live when the hold is not where the route needs it (not up yet, already started, released).
 * Either: 503 when the runner took no row in time.
 */
export async function heldRoute(name: string, runId: string, body: unknown, store: HeldStore, options: HeldOptions = {}): Promise<unknown> {
  const fields = fieldsOf(body);
  if (name === "callRunComputer") {
    const issues = callIssues(fields);
    if (issues.length) throw invalid(issues);
    return callComputer(store, runId, { method: fields.method as string, params: (fields.params ?? {}) as Record<string, unknown> }, options);
  }
  const issues = unknownFields(fields, []);
  if (issues.length) throw invalid(issues);
  if (!(await holdOfRun(store, runId))) throw new ApiError("not_found", `run ${runId} holds no computer: a run started with hold: true holds one`);
  const read = heldIn(await entriesOf(store, runId, options));
  const over = await runOver(store, runId);
  if (name === "releaseRunComputer" && (over || read?.state === "released")) throw new ApiError("not_found", `run ${runId}'s computer was already let go`);
  if (over || read?.state === "released") throw new ApiError("computer_not_live", `run ${runId}'s computer was let go${read?.why === "timeout" ? `: no call came for ${read.minutes} minutes` : ""}`);
  if (read === undefined) throw new ApiError("computer_not_live", `run ${runId}'s computer is not up yet: the run waits for a runner to claim it`);
  if (name === "startRun" && read.state !== "waiting") throw new ApiError("computer_not_live", `run ${runId}'s agent has already started`);
  const start = name === "startRun";
  await sendRow(store, runId, { kind: start ? COMPUTER_START : COMPUTER_RELEASE, body: {} }, options.takeMs ?? TAKE_MS, options.pollMs);
  return { held: { state: start ? "started" : "released" } };
}
