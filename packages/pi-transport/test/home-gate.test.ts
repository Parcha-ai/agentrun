import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { createGate, DrainError, type Drained, type DrainOptions } from "../src/home/gate.ts";
import {
	besideTicker,
	compactedAtThreshold,
	compactedByHand,
	delegated,
	type Moved,
	move,
	parallelRounds,
	type Scenario,
	type Site,
	serialLoop,
	sleep,
	TICKER,
	type Trial,
	uncut,
	until,
	withTrial,
} from "./home-gate-support.ts";

const context = BACKGROUND_CONTEXT;

/** Moves for each case. A proof run asks for more than the default. */
const MOVES = Number(process.env.PI_TRANSPORT_GATE_MOVES ?? 5);
if (!Number.isInteger(MOVES) || MOVES < 1) {
	throw new Error(
		`PI_TRANSPORT_GATE_MOVES must be a whole number above 0, not ${process.env.PI_TRANSPORT_GATE_MOVES}`,
	);
}
/** A move takes about a second, and five at the worst. */
const TIMEOUT_MS = 30_000 + MOVES * 5_000;
/** Longer than any tool call or model request here, so only what never ends still runs at the timeout. */
const SHORT_DRAIN_MS = 400;
/** Kinds of the session's own work that may be in flight toward the gate when a drain gives up. */
const IN_FLIGHT_KINDS = ["pi.tool", "pi.generation", "pi.compaction"];

/** Run `each` on a trial of its own for every move index, one after another. The label names the move in a failure. */
async function everyTrial(
	plan: (site: Site) => Scenario,
	each: (trial: Trial, label: string) => Promise<void>,
): Promise<void> {
	for (let index = 0; index < MOVES; index += 1) {
		await withTrial(index, plan, (trial) => each(trial, `move ${index} at ${trial.moveAtMs} ms`));
	}
}

/**
 * Move the scenario once for every move index and check each move: the run finished, no tool call was cut, every effect
 * happened once and the model was asked exactly as often as the run needs. `also` adds what one case checks on top.
 */
async function everyMove(
	plan: (site: Site) => Scenario,
	also?: (moved: Moved, label: string) => void,
	options?: DrainOptions,
): Promise<void> {
	let held = 0;
	await everyTrial(plan, async (trial, label) => {
		const moved = await move(trial, options);
		expect(moved.outcome, label).toMatchObject(uncut(trial.scenario));
		also?.(moved, label);
		held += moved.drained.held;
	});
	// Moves that all found the session idle would say nothing about the gate.
	expect(held, "tasks held at the gate over all moves").toBeGreaterThan(0);
}

/** The error of a drain that did not complete. */
function refusal(drained: Result<Drained, DrainError>): DrainError {
	if (drained.ok) throw new Error("the drain completed");
	return drained.error;
}

// Every trial has a directory, a store and a model of its own, so the cases run side by side.
describe.concurrent("the move gate", () => {
	describe("a move through the gate", () => {
		it("moves a serial tool loop with nothing cut", () => everyMove(serialLoop), TIMEOUT_MS);

		it(
			"holds a parallel round with nothing cut",
			() =>
				everyMove(
					(site) => parallelRounds(site, false),
					(moved, label) => expect(moved.outcome.peak, label).toBe(3),
				),
			TIMEOUT_MS,
		);

		it(
			"holds a round that another extension's slow hook split, with nothing cut",
			() => everyMove((site) => parallelRounds(site, true)),
			TIMEOUT_MS,
		);

		it(
			"lets a child conversation finish while its owner tool waits for it, and aborts no child task",
			() =>
				everyMove(
					(site) => delegated(site, true),
					(moved, label) => expect(moved.outcome, label).toMatchObject({ children: 2, abortedChildTasks: 0 }),
				),
			TIMEOUT_MS,
		);

		it(
			"moves the same when the child's agent drops the gate's extension",
			() =>
				everyMove(
					(site) => delegated(site, false),
					(moved, label) => expect(moved.outcome, label).toMatchObject({ children: 2, abortedChildTasks: 0 }),
				),
			TIMEOUT_MS,
		);

		it(
			"moves around a manual compaction and sends no summarizer prompt twice",
			() =>
				everyMove(compactedByHand, (moved, label) =>
					expect(moved.outcome, label).toMatchObject({ compactions: ["completed"], repeatedSummaries: 0 }),
				),
			TIMEOUT_MS,
		);

		for (const [name, backgroundTokens] of [
			["a compaction that blocks the run at a threshold", 0],
			["compactions at a threshold in the background", 250],
		] as const) {
			it(
				`moves around ${name} and sends no summarizer prompt twice`,
				() =>
					everyMove(
						(site) => compactedAtThreshold(site, backgroundTokens),
						(moved, label) => {
							const { compactions, summaries, repeatedSummaries } = moved.outcome;
							expect(summaries, label).toBeGreaterThan(0);
							expect(compactions, label).toEqual(compactions.map(() => "completed"));
							expect(repeatedSummaries, label).toBe(0);
						},
					),
				TIMEOUT_MS,
			);
		}

		it(
			"moves past a background task listed as closeable, and the next Harness resumes it",
			() =>
				everyMove(
					besideTicker,
					(moved, label) => {
						expect(moved.drained.closeable, label).toBe(1);
						expect(moved.outcome.ticks.length, label).toBeGreaterThan(moved.ticksAtClose);
						// A close between a line and its checkpoint makes the next Harness write that line again.
						const distinct = [...new Set(moved.outcome.ticks)];
						expect(distinct, label).toEqual(distinct.map((_, n) => n));
					},
					{ closeable: [TICKER] },
				),
			TIMEOUT_MS,
		);
	});

	describe("a drain that does not complete", () => {
		it(
			"times out on a background task that never ends, names its kind and cuts nothing",
			() =>
				everyTrial(besideTicker, async (trial, label) => {
					const home = await trial.open();
					await trial.begin(home);
					await sleep(trial.moveAtMs);
					const error = refusal(await home.gate.drain({ timeoutMs: SHORT_DRAIN_MS }, context));
					expect(error, label).toBeInstanceOf(DrainError);
					expect(error.code, label).toBe("timeout");
					// The ticker never reaches the gate. A tool or a model request that was already running when the drain began may
					// also still be on its way to it when a loaded machine ends the wait: the gate names it, and it is not the point.
					expect(error.holdouts, label).toContainEqual({ kind: TICKER, count: 1 });
					for (const { kind } of error.holdouts) expect([TICKER, ...IN_FLIGHT_KINDS], label).toContain(kind);
					expect(home.gate.held, label).toBe(0);

					// The same Harness finishes the run and the ticker never stopped: no line is missing, none repeats.
					const outcome = await trial.finish(home);
					expect(outcome, label).toMatchObject(uncut(trial.scenario));
					expect(outcome.ticks, label).toEqual(outcome.ticks.map((_, n) => n));
				}),
			TIMEOUT_MS,
		);

		it("returns aborted when its context is aborted, and leaves the gate open", () =>
			withTrial(0, besideTicker, async (trial) => {
				const home = await trial.open();
				await trial.begin(home);
				// The ticker never ends, so the drain is still waiting when its context is aborted.
				const stop = new AbortController();
				const draining = home.gate.drain(undefined, withAbortSignal(stop.signal, context));
				expect(await until(() => home.gate.held > 0)).toBe(true);
				stop.abort();
				expect(refusal(await draining).code).toBe("aborted");
				expect(home.gate.held).toBe(0);
				expect(await trial.finish(home)).toMatchObject(uncut(trial.scenario));
			}));

		it("lets a parked run finish in the same Harness when the gate is opened during a drain", () =>
			withTrial(0, besideTicker, async (trial) => {
				const home = await trial.open();
				await trial.begin(home);
				const stop = new AbortController();
				const draining = home.gate.drain(undefined, withAbortSignal(stop.signal, context));
				expect(await until(() => home.gate.held > 0)).toBe(true);
				home.gate.open();
				expect(home.gate.held).toBe(0);
				// The drain is still waiting for the ticker while the run goes on to its end.
				await home.root.waitForIdle(context);
				stop.abort();
				await draining;
				expect(await trial.finish(home)).toMatchObject(uncut(trial.scenario));
			}));
	});

	describe("a drain with nothing to hold", () => {
		it("completes on an idle session with nothing held", () =>
			withTrial(0, serialLoop, async (trial) => {
				const home = await trial.open();
				await trial.begin(home);
				await home.root.waitForIdle(context);
				expect(getOrThrow(await home.gate.drain(undefined, context))).toMatchObject({ held: 0, closeable: 0 });
				expect(await trial.finish(home)).toMatchObject(uncut(trial.scenario));
			}));

		it("holds a compaction that starts while the gate holds, before it selects", () =>
			withTrial(0, compactedByHand, async (trial) => {
				const home = await trial.open();
				await trial.begin(home);
				await home.root.waitForIdle(context);
				// The session is at rest and the gate holds: what starts now waits, as it would between the drain and the close.
				expect(getOrThrow(await home.gate.drain(undefined, context)).held).toBe(0);
				await home.root.compact(undefined, context);
				expect(await until(() => home.gate.held === 1, 5_000)).toBe(true);
				home.gate.open();
				expect(await trial.finish(home)).toMatchObject({ ...uncut(trial.scenario), compactions: ["completed"] });
			}));

		it("throws before attach()", async () => {
			await expect(createGate().drain(undefined, context)).rejects.toThrow("the gate has no Harness");
		});
	});
});
