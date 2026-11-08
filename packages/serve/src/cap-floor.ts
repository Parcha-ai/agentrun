// A cap too small for one request, refused when its run is created, and the agent's floor before a run.
//
// A run's first turn request records its floor on its start mark (cap.ts FloorMark): priced in the run's process by the
// cap's own rule, sent or refused, capped or not. The server never prices a model (the price is the run's process's: its
// keys, the gateway's catalog, claude-agent's price model), so a floor is a revision's, measured by its runs: another
// revision's instructions, skills or tools (its MCP servers') make another first request. Before a revision's first run
// there is no floor, and a create goes as before: that run is never refused, so a cap too small for it pauses at step 0
// once, and that pause records the floor. A deliberate trade against building the run's first request (and pricing it)
// in the server too. Once one is measured:
//   - POST /v2/agents/{id}/runs with a cap under the least that run's first request would need (that run's input
//     counted) is refused, 422 below_least, saying the model, the cap asked and both figures, with least_cap_usd: the
//     same request the cap would refuse at step 0, before anything was done.
//   - GET /v2/agents/{id} serves `cap_floor`: the figures of the agent's input-free part, a lower bound for any input,
//     the least (the hard minimum) and the typical (the advice), by effort.
// A first request has no previous request, so its price is linear in its fresh input: the figures for another input are
// the measured ones moved by the difference in its message's bytes at the measured price of a token (inputUsdPerToken).
import { type FloorMark, type FloorRun, money, raiseFigure } from "./cap.js";
import { ApiError } from "./errors.js";
import { DEFAULT_HARNESS } from "./harness.js";
import { hostModel } from "./model.js";

/** The model setting a run of `revision` runs under, for its floor (FloorMark.setting): the revision's model, else the
 *  host's default for its harness, the one the server picks at a launch (hostModel; `launched`, what it handed the run,
 *  when it handed one). A floor measured under another setting is never applied. */
export function floorSetting(env: NodeJS.ProcessEnv, revision: { kind: string; body: { model?: string; harness?: string } }, launched?: string): Pick<FloorRun, "setting"> {
  if (revision.kind !== "agentic") return {};
  const setting = revision.body.model ?? (launched || hostModel(env, "default", revision.body.harness ?? DEFAULT_HARNESS));
  return setting ? { setting } : {};
}

/** The newest runs of an agent a floor is looked for in. */
export const FLOOR_RUNS = 20;
/** A run that measured a floor: its mark, the input it was started with, and when it started (`at`). A run whose first
 *  message carried a file list is none: its list's bytes are not its agent's. */
export type MeasuredRun = { mark: FloorMark; input: unknown; at: string };
/** The figures as the API serves them, in dollars to the micro-dollar. */
export type FloorFigures = { least_usd: number; typical_usd: number };
/** GET /v2/agents/{id}'s `cap_floor`. */
export type CapFloor = FloorFigures & { model: string; effort?: string; measured_at: string; by_effort: Record<string, FloorFigures> };

const micro = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/** The bytes a run's input adds to its first request: its message's text as the request carries it, JSON-escaped. */
export const messageBytes = (input: unknown): number => {
  const content = (input as { content?: unknown } | null | undefined)?.content;
  return Buffer.byteLength(JSON.stringify(typeof content === "string" ? content : ""), "utf8");
};

/** `measured`'s floor for a run started with `input`: its input-free part (its input bound less its own message's
 *  bytes, never below 0) and `input`'s message, at the measured price of a token. */
export function floorFor(measured: MeasuredRun, input: unknown): { leastUsd: number; typicalUsd: number } {
  const { mark } = measured;
  const tokens = Math.max(0, mark.inputTokens - messageBytes(measured.input)) + messageBytes(input);
  const moved = (tokens - mark.inputTokens) * mark.inputUsdPerToken;
  return { leastUsd: Math.max(0, mark.leastUsd + moved), typicalUsd: Math.max(0, mark.typicalUsd + moved) };
}

/** The agent's `cap_floor` from its measured runs, newest first, of those measured under its model setting now
 *  (`setting`, floorSetting): the newest one's input-free figures, and the newest of each thinking level it was measured
 *  at. Undefined with none. */
export function capFloorView(all: readonly MeasuredRun[], setting: string | undefined): CapFloor | undefined {
  const measured = all.filter((run) => run.mark.setting === setting);
  const newest = measured[0];
  if (!newest) return undefined;
  const free = (run: MeasuredRun): FloorFigures => {
    const { leastUsd, typicalUsd } = floorFor(run, { content: "" });
    return { least_usd: micro(leastUsd), typical_usd: micro(typicalUsd) };
  };
  const byEffort: Record<string, FloorFigures> = {};
  for (const run of measured) if (run.mark.effort && !Object.hasOwn(byEffort, run.mark.effort)) byEffort[run.mark.effort] = free(run);
  return { ...free(newest), model: newest.mark.model, ...(newest.mark.effort ? { effort: newest.mark.effort } : {}), measured_at: newest.at, by_effort: byEffort };
}

/** The refusal of a create whose `cap` is under the least its first request would need: measured on the newest run under
 *  what this one runs under (`run`: its thinking level and model setting now), that run's input moved to this one's.
 *  Undefined when the cap covers it, or no such run measured one. `input`'s own files are not counted (a lower bound:
 *  their list only adds to its first request), so a run with files is refused only when even its message is not
 *  covered. */
export function belowLeast(cap: number, measured: readonly MeasuredRun[], input: unknown, run: FloorRun): ApiError | undefined {
  const same = measured.find((one) => one.mark.effort === run.effort && one.mark.setting === run.setting);
  if (!same) return undefined;
  const { leastUsd, typicalUsd } = floorFor(same, input);
  if (cap >= leastUsd) return undefined;
  const leastCap = raiseFigure(cap, leastUsd);
  const message = `This cap (${money(cap)}) can't cover one request on ${same.mark.model}: its first request needs at least ${money(micro(leastUsd))}, and typically about ${money(micro(typicalUsd))}. Give max_cost_usd at least $${leastCap.toFixed(2)}.`;
  return new ApiError("input_invalid", message, {
    fields: [{ field: "max_cost_usd", reason: "below_least", message, fix: `Give max_cost_usd at least $${leastCap.toFixed(2)} (about ${money(micro(typicalUsd))} for a typical first request).` }],
    details: { least_cap_usd: leastCap, least_usd: micro(leastUsd), typical_usd: micro(typicalUsd), model: same.mark.model, ...(same.mark.effort ? { effort: same.mark.effort } : {}) },
  });
}
