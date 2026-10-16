// The box place's cases, for any provider: a test file calls `registerBoxPlaceCases` with its boxes and its runner.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { BoxProvider, BoxSpec } from "../src/box/box.ts";
import { localVault } from "../src/home/checkpoint.ts";
import { dirStore } from "../src/home/dir-store.ts";
import { leaseIn } from "../src/home/ownership.ts";
import type { RunnerProgram } from "../src/home/start.ts";
import {
	type BoxPlace,
	boxPlace,
	type PlaceSignal,
	RecordHomeError,
	type RunnerOrder,
} from "../src/place/box-place.ts";

const context = BACKGROUND_CONTEXT;
const STARTED = "2026-10-16T00:00:00.000Z";

/** Where the cases run: the boxes, the spec of each, and the runner the boxes run (the fixture `place-box-runner.fixture.ts`). */
export type BoxPlaceSetup = {
	readonly provider: (root: string) => BoxProvider;
	readonly spec: BoxSpec;
	readonly program: RunnerProgram;
	readonly timeoutMs?: number;
	/** The box's programs can write this machine's files (local boxes): a job's effects can land outside its box. */
	readonly hostFiles?: boolean;
	/** A runner with one pi agent turn on the host's faux model (the fixture `place-box-agent.fixture.ts`). */
	readonly agentProgram?: RunnerProgram;
};

/** A host's directory (lease, vault, the recording's spool with its clock) and the setup's boxes. */
function world(setup: BoxPlaceSetup) {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-place-"));
	const host = join(root, "host");
	const record = join(host, "record");
	mkdirSync(join(record, ".spool"), { recursive: true });
	writeFileSync(join(record, ".spool", "started"), `${STARTED}\n`);
	return {
		host,
		record,
		setup,
		provider: setup.provider(root),
		remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
	};
}
type World = ReturnType<typeof world>;

async function placeIn(made: World, more: { models?: Models; program?: RunnerProgram } = {}): Promise<BoxPlace> {
	return getOrThrow(
		await boxPlace(
			{
				session: "run-1",
				provider: made.provider,
				spec: made.setup.spec,
				environment: "box",
				ownership: leaseIn(dirStore(join(made.host, "lease"))),
				program: more.program ?? made.setup.program,
				models: more.models ?? createModels(),
				vault: localVault(join(made.host, "vault")),
				carry: ["CROSS_LOG"],
				recording: "RECORD_DIR",
			},
			context,
		),
	);
}

/** The order a supervisor gives attempt `gen`: host paths for the crossings log and the recording, the request file the place names. */
const orderOf = (made: World, place: BoxPlace, gen: number, more: Record<string, string> = {}): RunnerOrder => ({
	gen,
	env: {
		RUN_ID: "run-1",
		STEPS: "3",
		CROSS_LOG: join(made.host, `crossings-${gen}.jsonl`),
		RECORD_DIR: made.record,
		RECORD_STARTED: STARTED,
		RECORD_GEN: String(gen),
		KILL_REQUEST: place.requestFile(gen),
		KILL_NONCE: `nonce-${gen}`,
		...more,
	},
});

/** The commits the place's vault holds from commit 1, read as a host that starts again reads them. */
async function logFrom1(made: World) {
	return getOrThrow(await localVault(join(made.host, "vault")).readLog("run-1", 1, context));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The host's model: a faux one whose answers stream slowly, numbered by the call, and how often it was asked. */
function slowModel() {
	const faux = fauxProvider({ api: "faux", tokensPerSecond: 40 });
	const models = createModels();
	models.setProvider(faux.provider);
	let asked = 0;
	faux.setResponses(
		Array.from({ length: 5 }, () => () => {
			asked += 1;
			return fauxAssistantMessage(`answer number ${asked}: ${"slowly ".repeat(60).trim()}`);
		}),
	);
	return { models, asked: () => asked };
}

/** The spool files the recording's directory holds on the host. */
const spoolFiles = (made: World) => readdirSync(join(made.record, ".spool")).filter((name) => name.endsWith(".jsonl"));

/** What `promise` rejected with: its `code`. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		return error instanceof RecordHomeError ? error.code : String(error);
	}
}

const lines = (path: string) =>
	readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

/** The first signal of a kind for attempt `gen`, the iterator ended after it. */
async function firstSignal(place: BoxPlace, gen: number, kind: PlaceSignal["kind"]): Promise<PlaceSignal> {
	const iterator = place.signals(gen)[Symbol.asyncIterator]();
	try {
		for (;;) {
			const next = await iterator.next();
			if (next.done) throw new Error("the signals ended");
			if (next.value.kind === kind) return next.value;
		}
	} finally {
		await iterator.return?.();
	}
}

export function registerBoxPlaceCases(name: string, setup: BoxPlaceSetup): void {
	describe(name, () => {
		it(
			"runs a runner in the box until it reports its outcome, carries its files, brings its recording home when asked, and lets the box go",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					expect(place.clockSkewMs).toBeLessThan(1_000);
					const runner = await place.start(orderOf(made, place, 1, { PARTIAL: "1" }));
					expect(runner.epoch).toBe(1);
					const exit = await runner.exited;
					expect({ exit: exit.exit, signal: exit.signal, status: exit.outcome?.status }).toEqual({
						exit: 0,
						signal: null,
						status: "complete",
					});
					// The recording's clock went in before the runner started; the session's paths are the place's.
					expect(exit.outcome?.record).toEqual({
						done: 3,
						resumedFrom: 0,
						started: STARTED,
						root: place.paths.root,
					});
					// The crossings log came back whole at the exit, to the host path the order named.
					expect(lines(join(made.host, "crossings-1.jsonl")).map((line) => line.n)).toEqual([1, 2, 3]);
					// The recording comes home when the supervisor asks, not before: the blobs, then the whole lines.
					expect(spoolFiles(made)).toEqual([]);
					const recordHome = place.recordHome;
					if (recordHome === undefined) throw new Error("a place with a recording has recordHome");
					await recordHome.bringHome(made.record, { final: true });
					await recordHome.bringHome(made.record, { final: true });
					const spool = spoolFiles(made);
					expect(spool).toHaveLength(1);
					const spoolText = readFileSync(join(made.record, ".spool", spool[0] as string), "utf8");
					// Whole lines only, once each: the line the runner left half written stays in the box.
					expect(spoolText.endsWith("\n")).toBe(true);
					const spooled = lines(join(made.record, ".spool", spool[0] as string));
					expect(spooled.map((line) => line.step)).toEqual([1, 2, 3]);
					for (const line of spooled)
						expect(readFileSync(join(made.record, "blobs", String(line.blob)), "utf8")).toBe(`step ${line.step}`);
					expect(readFileSync(join(made.record, ".spool", "started"), "utf8")).toBe(`${STARTED}\n`);
					// The status a supervisor writes run.json lines from: the run, the lease's epoch, the box in holder.host.
					const status = await place.status();
					const holder = status.record.holder as { host: string; bootId: string };
					expect(status.record).toMatchObject({ run: "run-1", generation: 1, status: "stopped" });
					expect(holder.bootId).toBe("epoch-1");
					await place.release();
					expect(getOrThrow(await made.provider.attach(holder.host, context))).toBeUndefined();
				} finally {
					made.remove();
				}
			},
			setup.timeoutMs ?? 60_000,
		);

		it(
			"kills a runner by its process at its request, and starts the next in the same box where the store left off",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "2" }));
					expect(await firstSignal(place, 1, "kill-request")).toEqual({
						kind: "kill-request",
						crossing: { point: "fixture.step", n: 2 },
						nonce: "nonce-1",
					});
					// At rest at its request, the session is open; a tick brings home what is written so far.
					expect((await place.status()).record).toMatchObject({ run: "run-1", generation: 1, status: "open" });
					await place.recordHome?.bringHome(made.record, {});
					expect(
						spoolFiles(made).flatMap((name) => lines(join(made.record, ".spool", name)).map((line) => line.step)),
					).toEqual([1, 2]);
					await place.kill(runner, "process");
					const killed = await runner.exited;
					expect({ signal: killed.signal, outcome: killed.outcome }).toEqual({
						signal: "SIGKILL",
						outcome: undefined,
					});
					const recovered = await place.recover(runner, "process", orderOf(made, place, 2));
					expect({ epoch: recovered.runner.epoch, restored: recovered.restored }).toEqual({
						epoch: 1,
						restored: undefined,
					});
					const exit = await recovered.runner.exited;
					expect(exit.outcome?.record).toMatchObject({ done: 3, resumedFrom: 2 });
					// Each attempt wrote its own spool file in its own directory: both are home, each line once.
					await place.recordHome?.bringHome(made.record, { final: true });
					const steps = spoolFiles(made).flatMap((name) =>
						lines(join(made.record, ".spool", name)).map((line) => line.step),
					);
					expect(steps.sort()).toEqual([1, 2, 3]);
					// return() ends a pending next(): the supervisor stops reading when a runner has exited.
					const iterator = place.signals(3)[Symbol.asyncIterator]();
					const pending = iterator.next();
					await iterator.return?.();
					expect(await pending).toEqual({ done: true, value: undefined });
					await place.release();
				} finally {
					made.remove();
				}
			},
			setup.timeoutMs ?? 60_000,
		);

		it(
			"brings home a spool that grows while the runner runs, at every call, each line once",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					const runner = await place.start(orderOf(made, place, 1, { STEPS: "5", STEP_MS: "300" }));
					let ended = false;
					void runner.exited.then(() => {
						ended = true;
					});
					// The supervisor's ticks while the runner runs: some find part of the file, and the next ones the rest.
					const seen: number[] = [];
					while (!ended) {
						await place.recordHome?.bringHome(made.record, {});
						seen.push(spoolFiles(made).flatMap((name) => lines(join(made.record, ".spool", name))).length);
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					await place.recordHome?.bringHome(made.record, { final: true });
					expect(seen.some((count) => count > 0 && count < 5)).toBe(true);
					const steps = spoolFiles(made).flatMap((name) =>
						lines(join(made.record, ".spool", name)).map((line) => line.step),
					);
					expect(steps).toEqual([1, 2, 3, 4, 5]);
					await place.release();
				} finally {
					made.remove();
				}
			},
			setup.timeoutMs ?? 60_000,
		);

		it(
			"brings home every blob that matches its name and the lines, and says which did not",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					const runner = await place.start(orderOf(made, place, 1, { BAD_BLOB: "1" }));
					await runner.exited;
					expect(
						await codeOf(place.recordHome?.bringHome(made.record, { final: true }) ?? Promise.resolve()),
					).toBe("BLOB_MISMATCH");
					// The blob whose bytes are not its name stayed in the box; the others and the lines are home.
					expect(readdirSync(join(made.record, "blobs"))).toHaveLength(3);
					expect(
						spoolFiles(made).flatMap((name) => lines(join(made.record, ".spool", name)).map((line) => line.step)),
					).toEqual([1, 2, 3]);
					await place.release();
				} finally {
					made.remove();
				}
			},
			setup.timeoutMs ?? 60_000,
		);

		it(
			"takes a checkpoint at rest and, when the box is lost, restores it into a new box at the next epoch",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "2" }));
					await firstSignal(place, 1, "kill-request");
					const lost = ((await place.status()).record.holder as { host: string }).host;
					// A supervisor that asks again while a checkpoint is being taken gets that one: the session is held once.
					expect(await Promise.all([place.checkpoint(), place.checkpoint()])).toEqual([
						{ taken: true },
						{ taken: true },
					]);
					expect({ taken: place.stats.taken, skipped: place.stats.skipped.failed }).toEqual({
						taken: 1,
						skipped: 0,
					});
					// The commits the checkpoint covers are let go, and at rest none follow it: the log holds nothing from commit 1.
					expect(await logFrom1(made)).toEqual({ entries: [], gap: false });
					expect(await firstSignal(place, 1, "crossing")).toMatchObject({
						kind: "crossing",
						crossing: {
							point: "transport.checkpoint.taken",
							n: 1,
							info: { session: "run-1", epoch: 1, box: lost },
						},
					});
					await place.kill(runner, "box");
					await runner.exited;
					// The supervisor's last call for the attempt whose box was lost: the place says the box is gone.
					expect(
						await codeOf(place.recordHome?.bringHome(made.record, { final: true }) ?? Promise.resolve()),
					).toBe("BOX_GONE");
					const recovered = await place.recover(runner, "box", orderOf(made, place, 2));
					expect(recovered.runner.epoch).toBe(2);
					expect(recovered.restored).toEqual({ checkpoint: expect.any(String), head: expect.any(Number) });
					const exit = await recovered.runner.exited;
					// The new box holds the store as the checkpoint had it: two steps done, the third run there, at the new epoch.
					expect(exit.outcome?.record).toMatchObject({ done: 3, resumedFrom: 2, started: STARTED });
					expect(exit.outcome?.generation).toBe(2);
					// The lost box's attempt is behind the place; the restored one's recording comes home.
					await place.recordHome?.bringHome(made.record, { final: true });
					const status = await place.status();
					expect((status.record.holder as { host: string }).host).not.toBe(lost);
					expect(status.record.generation).toBe(2);
					await place.release();
				} finally {
					made.remove();
				}
			},
			(setup.timeoutMs ?? 60_000) * 1.5,
		);

		it.skipIf(setup.hostFiles !== true)(
			"restores a job that never rests from the record stream alone when its box is lost, and runs no effect twice",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					const effects = join(made.host, "effects.jsonl");
					writeFileSync(effects, "");
					const steps = 30;
					const runner = await place.start(
						orderOf(made, place, 1, { STEPS: String(steps), STEP_MS: "30", EFFECTS: effects }),
					);
					// Mid-run: the job never rests, and no checkpoint is ever taken.
					while (lines(effects).length < 3) await new Promise((resolve) => setTimeout(resolve, 20));
					await place.kill(runner, "box");
					await runner.exited;
					expect(place.stats.taken).toBe(0);
					// The vault holds every commit the lost box shipped, from 1 and without a gap.
					const held = await logFrom1(made);
					expect({ first: held.entries[0]?.commit, gap: held.gap }).toEqual({ first: 1, gap: false });
					const recovered = await place.recover(
						runner,
						"box",
						orderOf(made, place, 2, { STEPS: String(steps), EFFECTS: effects }),
					);
					expect({ epoch: recovered.runner.epoch, restored: recovered.restored }).toEqual({
						epoch: 2,
						restored: undefined,
					});
					expect(recovered.replayed).toEqual({ from: 1, to: expect.any(Number) });
					const exit = await recovered.runner.exited;
					expect(exit.outcome?.generation).toBe(2);
					const record = exit.outcome?.record as { done: number; resumedFrom: number; interrupted: number | null };
					expect(record.done).toBe(steps);
					// Three effects ran in the lost box, so the host held their intents and the steps before them.
					expect(record.resumedFrom).toBeGreaterThanOrEqual(2);
					// Repeated 0: no step's effect ran twice, across the kill and the restore.
					const ran = lines(effects);
					const each = ran.map((line) => line.step as number);
					expect(each).toHaveLength(new Set(each).size);
					// Every step ran its effect, but the one the kill cut between its intent and its commit, which may have.
					const missing = Array.from({ length: steps }, (_, n) => n + 1).filter((step) => !each.includes(step));
					expect(missing.every((step) => step === record.interrupted)).toBe(true);
					expect(new Set(ran.map((line) => line.generation))).toEqual(new Set([1, 2]));
					await place.release();
				} finally {
					made.remove();
				}
			},
			(setup.timeoutMs ?? 60_000) * 1.5,
		);

		it.skipIf(setup.agentProgram === undefined)(
			"answers a turn's model request once across a lost box: the restored runner asks again by key, the host answers what it paid for",
			async () => {
				const made = world(setup);
				try {
					const model = slowModel();
					const place = await placeIn(made, { models: model.models, program: setup.agentProgram });
					const runner = await place.start(orderOf(made, place, 1));
					// The generation's intent reached the host before its request did. The box is lost while the answer streams.
					while (model.asked() === 0) await sleep(20);
					await sleep(300);
					await place.kill(runner, "box");
					await runner.exited;
					const recovered = await place.recover(runner, "box", orderOf(made, place, 2));
					expect({ epoch: recovered.runner.epoch, restored: recovered.restored }).toEqual({
						epoch: 2,
						restored: undefined,
					});
					const exit = await recovered.runner.exited;
					expect(exit.outcome?.generation).toBe(2);
					const record = exit.outcome?.record as { answer: string | null; questions: number };
					// Paid calls repeated 0: the provider was asked once across both runners, and the restored turn has that answer.
					expect(model.asked()).toBe(1);
					expect(record.answer?.startsWith("answer number 1:")).toBe(true);
					expect(record.questions).toBe(1);
					await place.release();
				} finally {
					made.remove();
				}
			},
			(setup.timeoutMs ?? 60_000) * 1.5,
		);
	});
}
