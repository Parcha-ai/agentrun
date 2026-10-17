// The box place's cases, for any provider: a test file calls `registerBoxPlaceCases` with its boxes and its runner.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { err, getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { type Box, BoxError, type BoxProvider, type BoxSpec } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { type BoxReceipt, type BoxReceipts, boxReceipts } from "../src/box/receipts.ts";
import { localVault } from "../src/home/checkpoint.ts";
import { dirStore } from "../src/home/dir-store.ts";
import { leaseIn } from "../src/home/ownership.ts";
import type { RunnerProgram } from "../src/home/start.ts";
import {
	type BoxPlace,
	boxPlace,
	type PlaceLineKind,
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

/** `inner`, with the id of every box it makes kept in `ids`: what no line of the place may name. */
function idsOf(inner: BoxProvider, ids: string[]): BoxProvider {
	return {
		name: inner.name,
		async create(spec, context) {
			const made = await inner.create(spec, context);
			if (made.ok) ids.push(made.value.id);
			return made;
		},
		attach: (id, context) => inner.attach(id, context),
		list: (labels, context) => inner.list(labels, context),
	};
}

/** A host's directory (lease, vault, the recording's spool with its clock), the setup's boxes, and the place's lines. */
function world(setup: BoxPlaceSetup) {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-place-"));
	const host = join(root, "host");
	const record = join(host, "record");
	mkdirSync(join(record, ".spool"), { recursive: true });
	writeFileSync(join(record, ".spool", "started"), `${STARTED}\n`);
	const ids: string[] = [];
	return {
		host,
		record,
		setup,
		ids,
		lines: [] as { kind: PlaceLineKind; data: Readonly<Record<string, unknown>> }[],
		provider: idsOf(setup.provider(root), ids),
		remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
	};
}
type World = ReturnType<typeof world>;

/** `inner`, each box it makes passed through `rig` with its number (1 for the first): a case breaks a box this way. */
function rigged(inner: BoxProvider, rig: (box: Box, n: number) => Box): BoxProvider {
	let count = 0;
	return {
		name: inner.name,
		async create(spec, context) {
			const created = await inner.create(spec, context);
			if (!created.ok) return created;
			count += 1;
			return ok(rig(created.value, count));
		},
		attach: (id, context) => inner.attach(id, context),
		list: (labels, context) => inner.list(labels, context),
	};
}

/** `box` with its `exec` given to `exec`, which may run the box's own (`run`); every other member is the box's. */
function withExec(
	box: Box,
	exec: (argv: readonly string[], run: () => ReturnType<Box["exec"]>) => ReturnType<Box["exec"]>,
): Box {
	return new Proxy(box, {
		get(target, key) {
			if (key === "exec")
				return (argv: readonly string[], options: Parameters<Box["exec"]>[1], at: Parameters<Box["exec"]>[2]) =>
					exec(argv, () => target.exec(argv, options, at));
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A short program in `box`, run to its end. */
async function inBoxRun(box: Box, argv: readonly string[]): Promise<void> {
	const done = await finish(getOrThrow(await box.exec(argv, undefined, context)));
	if (!done.ok || done.value.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed in the box`);
}

async function placeIn(
	made: World,
	more: { models?: Models; program?: RunnerProgram; receipts?: BoxReceipts; provider?: BoxProvider } = {},
): Promise<BoxPlace> {
	return getOrThrow(
		await boxPlace(
			{
				session: "run-1",
				provider: more.provider ?? made.provider,
				spec: made.setup.spec,
				environment: "box",
				ownership: leaseIn(dirStore(join(made.host, "lease"))),
				program: more.program ?? made.setup.program,
				models: more.models ?? createModels(),
				vault: localVault(join(made.host, "vault")),
				carry: ["CROSS_LOG"],
				recording: "RECORD_DIR",
				lines: (kind, data) => made.lines.push({ kind, data }),
				...(more.receipts === undefined ? {} : { receipts: more.receipts }),
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

/** Every value in the place's lines that names a box: each must be a label. */
function boxNames(made: World): unknown[] {
	return made.lines.flatMap(({ kind, data }) => {
		if (kind === "lease") return [(data.holder as { box?: unknown } | undefined)?.box];
		if (kind === "restore") return [(data.from as { box?: unknown }).box, (data.to as { box?: unknown }).box];
		return [data.box];
	});
}

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

/** The `transport.moves` records in the vault's log from commit `from`, each with the commit it is in. */
async function movesInLog(made: World, from = 1) {
	const log = getOrThrow(await localVault(join(made.host, "vault")).readLog("run-1", from, context));
	return log.entries.flatMap(({ commit, writes }) =>
		writes.flatMap((write) =>
			write.type === "document.create" && write.record.kind === "transport.moves"
				? [{ commit, key: write.record.key, value: write.content.value as Record<string, unknown> }]
				: [],
		),
	);
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

/** The first signal of a kind for attempt `gen` within `ms`, or `none`: the iterator is ended either way. */
async function signalWithin(
	place: BoxPlace,
	gen: number,
	kind: PlaceSignal["kind"],
	ms: number,
): Promise<PlaceSignal | "none"> {
	const iterator = place.signals(gen)[Symbol.asyncIterator]();
	const timer = setTimeout(() => void iterator.return?.(), ms);
	try {
		for (;;) {
			const next = await iterator.next();
			if (next.done) return "none";
			if (next.value.kind === kind) return next.value;
		}
	} finally {
		clearTimeout(timer);
		await iterator.return?.();
	}
}

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
					expect(holder).toEqual({ host: "box-1", bootId: "epoch-1" });
					await place.release();
					expect(getOrThrow(await made.provider.attach(made.ids[0] as string, context))).toBeUndefined();
					// The home box's life, by its label: made, then ended by the release, not killed.
					expect(
						made.lines.map(({ kind, data }) => [kind, data.box ?? (data.holder as { box: string }).box]),
					).toEqual([
						["box.created", "box-1"],
						["lease", "box-1"],
						["box.ended", "box-1"],
					]);
					expect(made.lines[2]?.data).toEqual({ box: "box-1", provider: made.provider.name, killed: false });
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
			"keeps a placement decision the host made in the session's store, through its runner, and refuses one it does not write",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "1" }));
					await firstSignal(place, 1, "kill-request");
					const decision = {
						v: 1 as const,
						id: "frame-3",
						session: "run-1",
						at: "2026-10-16T00:00:00.000Z",
						phase: "message" as const,
						what: "hands" as const,
						by: "jev" as const,
						current: "cpu",
						target: "gpu",
						moved: true,
						reason: "frame 3 is deep: it needs the GPU",
						latencyMs: 412,
					};
					await place.recordPlacement(decision);
					// In the store, in a commit of the runner: the vault's log has it as the session's document.
					const kept = (await logFrom1(made)).entries.flatMap(({ writes }) =>
						writes.flatMap((write) =>
							write.type === "document.create" && write.record.kind === "transport.placements"
								? [{ key: write.record.key, value: write.content.value }]
								: [],
						),
					);
					expect(kept).toEqual([{ key: "frame-3", value: decision }]);
					// Only jev or config chooses: any other record is refused, never written.
					const refused = await place.recordPlacement({ ...decision, id: "frame-4", by: "host" as "jev" }).then(
						() => "written",
						(error: { code?: string }) => error.code,
					);
					expect(refused).toBe("invalid");
					await place.kill(runner, "process");
					await runner.exited;
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
					expect(lost).toBe("box-1");
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
					expect((status.record.holder as { host: string }).host).toBe("box-2");
					expect(status.record.generation).toBe(2);
					expect(made.lines.find(({ kind }) => kind === "restore")?.data).toMatchObject({
						kind: "restore",
						epoch: 2,
						from: { environment: "box", box: "box-1" },
						to: { environment: "box", box: "box-2" },
						checkpoint: { n: expect.any(Number), head: expect.any(Number) },
					});
					// The restore's durable record, in the restored home's first commit: from box-1 to box-2, its checkpoint. The
					// log holds the commits from the checkpoint on.
					const moves = await movesInLog(made, recovered.restored?.head);
					expect(moves).toHaveLength(1);
					const [restore] = moves;
					expect(restore?.key).toBe("restore-2");
					expect(restore?.value).toMatchObject({
						v: 1,
						id: "restore-2",
						kind: "restore",
						epoch: 2,
						head: recovered.restored?.head,
						from: { environment: "box", provider: made.provider.name, box: "box-1" },
						to: { environment: "box", provider: made.provider.name, box: "box-2" },
						drainMs: null,
						shipMs: expect.any(Number),
						takeMs: expect.any(Number),
						bytes: expect.any(Number),
						stopped: [],
						checkpoint: {
							head: recovered.restored?.head,
							sha256: expect.any(String),
							bytes: expect.any(Number),
							at: expect.any(String),
						},
					});
					expect(restore?.commit).toBe(restore?.value.head);
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
					// The host's ledger, as the pool's: the home's boxes are labelled in its numbering and each gets its receipt.
					const receipts: BoxReceipt[] = [];
					const ledger = boxReceipts({
						prices: [
							{
								provider: made.provider.name,
								kind: "none",
								usdPerSecond: 0.0001,
								source: "test",
								priced: "2026-10-16",
							},
						],
						write: (receipt) => receipts.push(receipt),
					});
					const place = await placeIn(made, { receipts: ledger });
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
					// The home's lane and its hop, by labels only: made, killed, ended, the new box made, the lease moved, the restore.
					const home = made.lines.filter(({ kind }) => kind !== "lease" && kind !== "restore");
					expect(home.map(({ kind, data }) => [kind, data.box])).toEqual([
						["box.created", "box-1"],
						["box.killed", "box-1"],
						["box.ended", "box-1"],
						["box.created", "box-2"],
						["box.ended", "box-2"],
					]);
					expect(made.lines.filter(({ kind }) => kind === "lease").map(({ data }) => data)).toEqual([
						{ epoch: 1, holder: { environment: "box", provider: made.provider.name, box: "box-1" } },
						{ epoch: 2, holder: { environment: "box", provider: made.provider.name, box: "box-2" } },
					]);
					const hop = made.lines.find(({ kind }) => kind === "restore")?.data;
					expect(hop).toMatchObject({
						kind: "restore",
						epoch: 2,
						from: { environment: "box", box: "box-1" },
						to: { environment: "box", box: "box-2" },
						replayed: { from: 1, to: recovered.replayed?.to },
						head: (recovered.replayed?.to ?? 0) + 1,
					});
					expect(hop).not.toHaveProperty("checkpoint");
					// Every box-identifying field is a label, and no line, status or receipt names a provider's id.
					expect(made.ids).toHaveLength(2);
					for (const name of boxNames(made)) expect(name).toMatch(/^box-\d+$/);
					const told = JSON.stringify({ lines: made.lines, status: await place.status(), receipts });
					for (const id of made.ids) expect(told).not.toContain(id);
					// The receipts are the same boxes under the same labels.
					expect(receipts.map(({ box }) => box).sort()).toEqual(["box-1", "box-2"]);
					// The restore's durable record: from the log alone, so replayed from 1 and no checkpoint, at its head.
					const moves = await movesInLog(made);
					expect(moves).toHaveLength(1);
					const [restore] = moves;
					expect(restore?.value).toMatchObject({
						v: 1,
						kind: "restore",
						epoch: 2,
						head: (recovered.replayed?.to ?? 0) + 1,
						replayed: { from: 1, to: recovered.replayed?.to },
						from: { environment: "box", box: "box-1" },
						to: { environment: "box", box: "box-2" },
						stopped: [],
					});
					expect(restore?.value).not.toHaveProperty("checkpoint");
					// No pi task was running: pi commits nothing at open, and the record is the restored process's first commit.
					expect(restore?.commit).toBe(restore?.value.head);
					for (const id of made.ids) expect(JSON.stringify(restore)).not.toContain(id);
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
					// pi reopens a store whose generation was running and commits that once, at the store's next commit (the
					// record's head, `replayed.to + 1`), before anything of the runner's: the record is at head + 1 exactly.
					const [restore] = await movesInLog(made);
					const head = (recovered.replayed?.to ?? 0) + 1;
					expect(restore?.value).toMatchObject({ kind: "restore", head });
					expect(restore?.commit).toBe(head + 1);
					const opened = getOrThrow(await localVault(join(made.host, "vault")).readLog("run-1", head, context))
						.entries[0];
					// That one commit is pi's recovery of the generation: one task record, at head.
					expect({ commit: opened?.commit, writes: opened?.writes.map((write) => write.type) }).toEqual({
						commit: head,
						writes: ["task"],
					});
					await place.release();
				} finally {
					made.remove();
				}
			},
			(setup.timeoutMs ?? 60_000) * 1.5,
		);
		it(
			"brings a recording home once when two calls overlap: each line once, each blob whole",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					const runner = await place.start(orderOf(made, place, 1));
					await runner.exited;
					const recordHome = place.recordHome;
					if (recordHome === undefined) throw new Error("a place with a recording has recordHome");
					// A supervisor's tick and its final call, at once: the second reads what the first brought.
					await Promise.all([
						recordHome.bringHome(made.record, {}),
						recordHome.bringHome(made.record, { final: true }),
					]);
					const steps = spoolFiles(made).flatMap((name) =>
						lines(join(made.record, ".spool", name)).map((line) => line.step),
					);
					expect(steps).toEqual([1, 2, 3]);
					expect(readdirSync(join(made.record, "blobs")).sort()).toHaveLength(3);
					await place.release();
				} finally {
					made.remove();
				}
			},
			setup.timeoutMs ?? 60_000,
		);

		it(
			"brings home no line before its blob, though both were written while it read the recording",
			async () => {
				const made = world(setup);
				try {
					// A blob and its line the runner writes as the place reads the spool's sizes, before it lists the blobs or
					// after: in either order, the line comes home only with its blob.
					const text = "step 99";
					const hash = createHash("sha256").update(text).digest("hex");
					let dir: string | undefined;
					const provider = rigged(made.provider, (box) =>
						withExec(box, async (argv, run) => {
							if (dir !== undefined && argv.some((arg) => arg.includes("wc -c"))) {
								const at = dir;
								dir = undefined;
								await inBoxRun(box, [
									"sh",
									"-c",
									'mkdir -p "$1/blobs" "$1/.spool" && printf %s "$2" > "$1/blobs/$3" && printf "%s\\n" "$4" >> "$1/.spool/written-late.jsonl"',
									"sh",
									at,
									text,
									hash,
									JSON.stringify({ step: 99, blob: hash }),
								]);
							}
							return run();
						}),
					);
					const place = await placeIn(made, { provider });
					const runner = await place.start(orderOf(made, place, 1));
					await runner.exited;
					const recordHome = place.recordHome;
					if (recordHome === undefined) throw new Error("a place with a recording has recordHome");
					const homeLines = () => spoolFiles(made).flatMap((name) => lines(join(made.record, ".spool", name)));
					dir = recordHome.dir(1);
					await recordHome.bringHome(made.record, {});
					for (const line of homeLines())
						expect(readFileSync(join(made.record, "blobs", String(line.blob)), "utf8")).toBe(`step ${line.step}`);
					await recordHome.bringHome(made.record, { final: true });
					expect(
						homeLines()
							.map((line) => line.step)
							.sort((a, b) => Number(a) - Number(b)),
					).toEqual([1, 2, 3, 99]);
					expect(readFileSync(join(made.record, "blobs", hash), "utf8")).toBe(text);
					await place.release();
				} finally {
					made.remove();
				}
			},
			setup.timeoutMs ?? 60_000,
		);

		it(
			"says CARRY_FAILED when the spool cannot be listed in a box that is still there, and brings it on the next call",
			async () => {
				const made = world(setup);
				try {
					let refuse = false;
					const provider = rigged(made.provider, (box) =>
						withExec(box, async (argv, run) => {
							if (refuse && argv.some((arg) => arg.includes("wc -c"))) {
								refuse = false;
								return err(new BoxError("unknown", "the test refuses the listing"));
							}
							return run();
						}),
					);
					const place = await placeIn(made, { provider });
					const runner = await place.start(orderOf(made, place, 1));
					await runner.exited;
					const recordHome = place.recordHome;
					if (recordHome === undefined) throw new Error("a place with a recording has recordHome");
					refuse = true;
					expect(await codeOf(recordHome.bringHome(made.record, { final: true }))).toBe("CARRY_FAILED");
					await recordHome.bringHome(made.record, { final: true });
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
			"restores a lost box again after a restore that failed in its new box: from the lost box, never a fresh store",
			async () => {
				const made = world(setup);
				try {
					// The first box made in place of the lost one (the place's second) cannot take the restored store, once.
					let refused = 0;
					const provider = rigged(made.provider, (box, n) =>
						n !== 2
							? box
							: withExec(box, async (argv, run) => {
									if (refused === 0 && argv[0] === "sh" && argv.at(-1)?.endsWith("/session/run.sqlite")) {
										refused += 1;
										return err(new BoxError("unknown", "the test refuses the store"));
									}
									return run();
								}),
					);
					const place = await placeIn(made, { provider });
					const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "2" }));
					await firstSignal(place, 1, "kill-request");
					expect(await place.checkpoint()).toEqual({ taken: true });
					await place.kill(runner, "box");
					await runner.exited;
					const failed = await place.recover(runner, "box", orderOf(made, place, 2)).then(
						() => "restored",
						(error: Error) => error.message,
					);
					expect(failed).toContain("did not reach the new box");
					expect(refused).toBe(1);
					// The session is still the lost box's, and the box that failed is let go.
					expect(((await place.status()).record.holder as { host: string }).host).toBe("box-1");
					expect(made.lines.filter(({ kind }) => kind === "box.ended").map(({ data }) => data.box)).toEqual([
						"box-1",
						"box-2",
					]);
					const recovered = await place.recover(runner, "box", orderOf(made, place, 3));
					expect(recovered.runner.epoch).toBe(2);
					expect(recovered.restored).toEqual({ checkpoint: expect.any(String), head: expect.any(Number) });
					const exit = await recovered.runner.exited;
					expect(exit.outcome?.record).toMatchObject({ done: 3, resumedFrom: 2 });
					expect(((await place.status()).record.holder as { host: string }).host).toBe("box-3");
					await place.release();
				} finally {
					made.remove();
				}
			},
			(setup.timeoutMs ?? 60_000) * 2,
		);

		it(
			"finishes a restore in its new box when that box took the session and its runner did not start: no third box",
			async () => {
				const made = world(setup);
				try {
					// The place's second box takes the session at the next epoch, then cannot start its runner, once.
					let refused = 0;
					const provider = rigged(made.provider, (box, n) =>
						n !== 2
							? box
							: withExec(box, async (argv, run) => {
									if (refused === 0 && argv.includes("--session")) {
										refused += 1;
										return err(new BoxError("unknown", "the test refuses the runner"));
									}
									return run();
								}),
					);
					const place = await placeIn(made, { provider });
					const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "2" }));
					await firstSignal(place, 1, "kill-request");
					expect(await place.checkpoint()).toEqual({ taken: true });
					await place.kill(runner, "box");
					await runner.exited;
					const failed = await place.recover(runner, "box", orderOf(made, place, 2)).then(
						() => "restored",
						(error: Error) => error.message,
					);
					expect(failed).toContain("could not start the runner");
					expect(refused).toBe(1);
					// The lease names the new box: it is the place's, at the new epoch, and it is not let go.
					expect((await place.status()).record).toMatchObject({ generation: 2, holder: { host: "box-2" } });
					expect(made.lines.filter(({ kind }) => kind === "box.ended").map(({ data }) => data.box)).toEqual([
						"box-1",
					]);
					const recovered = await place.recover(runner, "box", orderOf(made, place, 3));
					expect(recovered.runner.epoch).toBe(2);
					const exit = await recovered.runner.exited;
					expect(exit.outcome?.record).toMatchObject({ done: 3, resumedFrom: 2 });
					expect((await place.status()).record).toMatchObject({ generation: 2, holder: { host: "box-2" } });
					// No third box: the restore finished where the session was taken, its hop said once, from box-1 to box-2.
					expect(made.lines.filter(({ kind }) => kind === "box.created").map(({ data }) => data.box)).toEqual([
						"box-1",
						"box-2",
					]);
					expect(
						made.lines
							.filter(({ kind }) => kind === "restore")
							.map(({ data }) => [(data.from as { box: string }).box, (data.to as { box: string }).box]),
					).toEqual([["box-1", "box-2"]]);
					await place.release();
				} finally {
					made.remove();
				}
			},
			(setup.timeoutMs ?? 60_000) * 2,
		);

		it(
			"restores into another box when the box that took the session is gone before its restore is finished",
			async () => {
				const made = world(setup);
				try {
					let refused = 0;
					const provider = rigged(made.provider, (box, n) =>
						n !== 2
							? box
							: withExec(box, async (argv, run) => {
									if (refused === 0 && argv.includes("--session")) {
										refused += 1;
										return err(new BoxError("unknown", "the test refuses the runner"));
									}
									return run();
								}),
					);
					const place = await placeIn(made, { provider });
					const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "2" }));
					await firstSignal(place, 1, "kill-request");
					expect(await place.checkpoint()).toEqual({ taken: true });
					await place.kill(runner, "box");
					await runner.exited;
					await place.recover(runner, "box", orderOf(made, place, 2)).catch(() => undefined);
					expect((await place.status()).record).toMatchObject({ generation: 2, holder: { host: "box-2" } });
					// The box that took the session is lost too, before the supervisor asks again.
					const second = getOrThrow(await made.provider.attach(made.ids[1] as string, context));
					getOrThrow((await second?.destroy(context)) ?? ok(undefined));
					const recovered = await place.recover(runner, "box", orderOf(made, place, 3));
					expect(recovered.runner.epoch).toBe(3);
					expect(recovered.restored).toEqual({ checkpoint: expect.any(String), head: expect.any(Number) });
					const exit = await recovered.runner.exited;
					expect(exit.outcome?.record).toMatchObject({ done: 3, resumedFrom: 2 });
					expect((await place.status()).record).toMatchObject({ generation: 3, holder: { host: "box-3" } });
					expect(
						made.lines
							.filter(({ kind }) => kind === "restore")
							.map(({ data }) => [(data.from as { box: string }).box, (data.to as { box: string }).box]),
					).toEqual([["box-2", "box-3"]]);
					await place.release();
				} finally {
					made.remove();
				}
			},
			(setup.timeoutMs ?? 60_000) * 2,
		);

		it(
			"reads a restored runner's kill request in its new box, from the request file the place named before the loss",
			async () => {
				const made = world(setup);
				try {
					const place = await placeIn(made);
					const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "2" }));
					await firstSignal(place, 1, "kill-request");
					expect(await place.checkpoint()).toEqual({ taken: true });
					await place.kill(runner, "box");
					await runner.exited;
					// The supervisor's order for the next attempt, made before the place has the new box.
					const recovered = await place.recover(runner, "box", orderOf(made, place, 2, { PARK_AT: "3" }));
					expect(await signalWithin(place, 2, "kill-request", 15_000)).toEqual({
						kind: "kill-request",
						crossing: { point: "fixture.step", n: 3 },
						nonce: "nonce-2",
					});
					await place.kill(recovered.runner, "process");
					await recovered.runner.exited;
					await place.release();
				} finally {
					made.remove();
				}
			},
			(setup.timeoutMs ?? 60_000) * 1.5,
		);
	});
}
