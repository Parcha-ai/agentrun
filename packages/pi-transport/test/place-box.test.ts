import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { localBoxes } from "../src/box/local.ts";
import { localVault } from "../src/home/checkpoint.ts";
import { dirStore } from "../src/home/dir-store.ts";
import { leaseIn } from "../src/home/ownership.ts";
import {
	type BoxPlace,
	boxPlace,
	type CarriedPath,
	type PlaceSignal,
	type RunnerOrder,
} from "../src/place/box-place.ts";

const context = BACKGROUND_CONTEXT;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "place-box-runner.fixture.ts");
const STARTED = "2026-10-16T00:00:00.000Z";
const CARRY: readonly CarriedPath[] = [
	{ env: "CROSS_LOG", kind: "file" },
	{ env: "RECORD_DIR", kind: "dir", in: [".spool/started"], once: ["blobs"], append: [".spool"] },
];

/** A host's directory (lease, vault, the recording's spool with its clock) and a provider of local boxes. */
function world() {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-place-"));
	const host = join(root, "host");
	const record = join(host, "record");
	mkdirSync(join(record, ".spool"), { recursive: true });
	writeFileSync(join(record, ".spool", "started"), `${STARTED}\n`);
	const provider = localBoxes({ root: join(root, "boxes") });
	return {
		host,
		record,
		provider,
		remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
	};
}
type World = ReturnType<typeof world>;

async function placeIn(made: World): Promise<BoxPlace> {
	return getOrThrow(
		await boxPlace(
			{
				session: "run-1",
				provider: made.provider,
				spec: { maxLifetimeMs: 10 * 60_000 },
				environment: "box",
				ownership: leaseIn(dirStore(join(made.host, "lease"))),
				program: { argv: [process.execPath, "--experimental-strip-types", "--no-warnings", FIXTURE] },
				models: createModels(),
				vault: localVault(join(made.host, "vault")),
				carry: CARRY,
				followMs: 0,
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
		KILL_REQUEST: place.requestFile(gen),
		KILL_NONCE: `nonce-${gen}`,
		...more,
	},
});

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

describe("a session's place in a box", () => {
	it("runs a runner in the box until it reports its outcome, carries its files both ways, and lets the box go", async () => {
		const made = world();
		try {
			const place = await placeIn(made);
			const runner = await place.start(orderOf(made, place, 1));
			expect(runner.epoch).toBe(1);
			const exit = await runner.exited;
			expect({ exit: exit.exit, signal: exit.signal, status: exit.outcome?.status }).toEqual({
				exit: 0,
				signal: null,
				status: "complete",
			});
			// The recording's clock went in before the runner started; the session's paths are the place's.
			expect(exit.outcome?.record).toEqual({ done: 3, resumedFrom: 0, started: STARTED, root: place.paths.root });
			// What the runner wrote came back to the host paths the order named: the crossings, then the blobs and the lines.
			expect(lines(join(made.host, "crossings-1.jsonl")).map((line) => line.n)).toEqual([1, 2, 3]);
			const spool = readdirSync(join(made.record, ".spool")).filter((name) => name.endsWith(".jsonl"));
			expect(spool).toHaveLength(1);
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
	}, 60_000);

	it("kills a runner by its process at its request, and starts the next in the same box where the store left off", async () => {
		const made = world();
		try {
			const place = await placeIn(made);
			const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "2" }));
			expect(await firstSignal(place, 1, "kill-request")).toEqual({
				kind: "kill-request",
				crossing: { point: "fixture.step", n: 2 },
				nonce: "nonce-1",
			});
			// At rest at its request, the session is open.
			expect((await place.status()).record).toMatchObject({ run: "run-1", generation: 1, status: "open" });
			await place.kill(runner, "process");
			const killed = await runner.exited;
			expect({ signal: killed.signal, outcome: killed.outcome }).toEqual({ signal: "SIGKILL", outcome: undefined });
			const recovered = await place.recover(runner, "process", orderOf(made, place, 2));
			expect({ epoch: recovered.runner.epoch, restored: recovered.restored }).toEqual({
				epoch: 1,
				restored: undefined,
			});
			const exit = await recovered.runner.exited;
			expect(exit.outcome?.record).toMatchObject({ done: 3, resumedFrom: 2 });
			// return() ends a pending next(): the supervisor stops reading when a runner has exited.
			const iterator = place.signals(3)[Symbol.asyncIterator]();
			const pending = iterator.next();
			await iterator.return?.();
			expect(await pending).toEqual({ done: true, value: undefined });
			await place.release();
		} finally {
			made.remove();
		}
	}, 60_000);

	it("takes a checkpoint at rest and, when the box is lost, restores it into a new box at the next epoch", async () => {
		const made = world();
		try {
			const place = await placeIn(made);
			const runner = await place.start(orderOf(made, place, 1, { PARK_AT: "2" }));
			await firstSignal(place, 1, "kill-request");
			const lost = ((await place.status()).record.holder as { host: string }).host;
			expect(await place.checkpoint()).toEqual({ taken: true });
			expect(await firstSignal(place, 1, "crossing")).toMatchObject({
				kind: "crossing",
				crossing: { point: "transport.checkpoint.taken", n: 1, info: { session: "run-1", epoch: 1, box: lost } },
			});
			await place.kill(runner, "box");
			await runner.exited;
			const recovered = await place.recover(runner, "box", orderOf(made, place, 2));
			expect(recovered.runner.epoch).toBe(2);
			expect(recovered.restored).toEqual({ checkpoint: expect.any(String), head: expect.any(Number) });
			const exit = await recovered.runner.exited;
			// The new box holds the store as the checkpoint had it: two steps done, the third run there, at the new epoch.
			expect(exit.outcome?.record).toMatchObject({ done: 3, resumedFrom: 2, started: STARTED });
			expect(exit.outcome?.generation).toBe(2);
			const status = await place.status();
			expect((status.record.holder as { host: string }).host).not.toBe(lost);
			expect(status.record.generation).toBe(2);
			await place.release();
		} finally {
			made.remove();
		}
	}, 90_000);
});
