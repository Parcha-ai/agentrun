import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import type { LogEntry } from "../src/home/commit-log.ts";
import { dirStore } from "../src/home/dir-store.ts";
import { moveHome, type Place } from "../src/home/move.ts";
import { leaseIn } from "../src/home/ownership.ts";
import type { RecordSink } from "../src/home/records.ts";
import { type HomeOptions, type MoveFacts, MovesDoc, openHome, type ResumeOrder } from "../src/home/run.ts";
import { boxRunner } from "../src/home/start.ts";
import { moveFile } from "../src/home/workspace.ts";
import { moveConformanceApp } from "../src/testing/move-conformance.ts";
import { tapStorage } from "./commit-tap.ts";

const context = BACKGROUND_CONTEXT;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "home-move-runner.fixture.ts");

/** The `transport.moves` documents a commit's writes create, with the move id each is keyed by. */
const movesIn = (writes: readonly StorageWrite[]) =>
	writes.flatMap((write) =>
		write.type === "document.create" && write.record.kind === "transport.moves"
			? [{ key: write.record.key, value: write.content.value }]
			: [],
	);

/** Two local boxes and the home of each, in-process, with every commit of a store reported. */
async function twoBoxes(directory: string) {
	const provider = localBoxes({ root: join(directory, "boxes") });
	const boxes: Box[] = [];
	const commits: LogEntry[] = [];
	const homeIn = async (environment: string): Promise<{ box: Box; options: HomeOptions }> => {
		const box = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000 }, context));
		boxes.push(box);
		const workspace = box.facts().workspace;
		return {
			box,
			options: {
				app: moveConformanceApp,
				session: "session-1",
				store: join(dirname(workspace), "session", "run.sqlite"),
				workspace,
				where: { environment, provider: "local" },
				models: createModels(),
				wrapStore: async (storage) => ({ storage: tapStorage(storage, (entry) => commits.push(entry)) }),
			},
		};
	};
	return { homeIn, commits, destroy: async () => Promise.all(boxes.map((box) => box.destroy(context))) };
}

/** What a host knows of a move: made up, with the boxes named by labels. */
const FACTS: MoveFacts = {
	from: { environment: "a", provider: "local", box: "box-1" },
	to: { environment: "b", provider: "local", box: "box-2" },
	drainMs: 12,
	shipMs: 34,
	takeMs: 5,
	bytes: 4096,
	stopped: [{ code: "ship", step: "ship" }],
};

describe("a move's durable record (transport.moves)", () => {
	it("is written by the target in its first commit, at the order's head, once; and not at all when the host sends none", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-moves-"));
		const made = await twoBoxes(directory);
		try {
			const a = await made.homeIn("a");
			const source = getOrThrow(await openHome(a.options));
			getOrThrow(await source.resume({ epoch: 1 }, context));
			getOrThrow(await source.drain({ timeoutMs: 5_000 }, context));
			const seal = getOrThrow(await source.seal(context));
			const b = await made.homeIn("b");
			getOrThrow(await moveFile(a.box, a.options.store, b.box, b.options.store, seal, undefined, context));
			const order: ResumeOrder = {
				epoch: 2,
				seal,
				move: { id: "move-1", notice: "You moved.", kind: "move", head: seal.head, record: { ...FACTS, seal } },
			};
			made.commits.length = 0;
			const target = getOrThrow(await openHome(b.options));
			getOrThrow(await target.resume(order, context));
			// The target's first commit is at the seal's head, and it holds the record, once.
			expect(made.commits[0]?.commit).toBe(seal.head);
			expect(
				made.commits.flatMap(({ commit, writes }) => movesIn(writes).map((move) => ({ commit, ...move }))),
			).toEqual([
				{
					commit: seal.head,
					key: "move-1",
					value: { v: 1, id: "move-1", kind: "move", epoch: 2, head: seal.head, ...FACTS, seal },
				},
			]);
			expect(await target.harness?.snapshot(MovesDoc, "move-1", context)).toEqual({
				v: 1,
				id: "move-1",
				kind: "move",
				epoch: 2,
				head: seal.head,
				...FACTS,
				seal,
			});
			await target.close(context);
			// Opened again in its epoch, by a host that knows less (a recovery's retry: from null, no times): the record
			// the first open wrote is kept, and nothing writes it again.
			made.commits.length = 0;
			const again = getOrThrow(await openHome(b.options));
			const retry = {
				from: null,
				to: FACTS.to,
				drainMs: null,
				shipMs: null,
				takeMs: null,
				bytes: null,
				stopped: [],
			};
			getOrThrow(
				await again.resume(
					{ ...order, move: { ...order.move, id: "move-1", notice: "You moved.", record: retry } },
					context,
				),
			);
			expect(made.commits.flatMap(({ writes }) => movesIn(writes))).toEqual([]);
			expect(await again.harness?.snapshot(MovesDoc, "move-1", context)).toMatchObject({
				from: FACTS.from,
				drainMs: 12,
			});
			await again.close(context);
			// A host that sends no record gets none.
			const plain = getOrThrow(await openHome(b.options));
			getOrThrow(await plain.resume({ epoch: 2, move: { id: "move-2", notice: "You moved." } }, context));
			expect(await plain.harness?.snapshot(MovesDoc, "move-2", context)).toBeUndefined();
			await plain.close(context);
			await source.close(context).catch(() => {});
		} finally {
			await made.destroy();
			rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);

	it("comes from moveHome with the places by their labels, its times and its seal, and is in the host's log once", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-moves-"));
		const provider = localBoxes({ root: join(directory, "boxes") });
		const boxes: Box[] = [];
		const place = async (environment: string, label: string): Promise<Place> => {
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000 }, context));
			boxes.push(box);
			const workspace = box.facts().workspace;
			return {
				environment,
				provider: "local",
				box,
				workspace,
				store: join(dirname(workspace), "session", "run.sqlite"),
				label,
			};
		};
		// The host's log of the session's commits, with their writes, as a recorder of the stream reads them.
		const log: LogEntry[] = [];
		const sink: RecordSink = {
			held: () => {
				const after = log.at(-1)?.commit ?? 0;
				return { after, linesAfter: after };
			},
			async append(commit, writes) {
				log.push({ commit, writes });
			},
			async lines() {},
		};
		try {
			const a = await place("a", "box-1");
			const b = await place("b", "box-2");
			const start = boxRunner({
				program: { argv: [process.execPath, "--experimental-strip-types", "--no-warnings", FIXTURE] },
				session: "session-1",
				models: createModels(),
				records: sink,
			});
			const lease = leaseIn(dirStore(join(directory, "lease")));
			getOrThrow(
				await lease.take(
					"session-1",
					{ environment: "a", provider: "local", box: a.box.id, host: "host-1" },
					0,
					undefined,
					context,
				),
			);
			const home = getOrThrow(await start(a, 1, context));
			getOrThrow(await home.ready);
			getOrThrow(await home.resume({ epoch: 1 }, context));
			const moved = getOrThrow(
				await moveHome(
					{
						session: "session-1",
						host: "host-1",
						ownership: lease,
						from: { place: a, home, epoch: 1 },
						to: b,
						start,
						notice: "You moved.",
					},
					context,
				),
			);
			getOrThrow(await moved.home.idle(context));
			const records = log.flatMap(({ commit, writes }) => movesIn(writes).map((move) => ({ commit, ...move })));
			expect(records).toHaveLength(1);
			const [record] = records;
			const value = record?.value as Record<string, unknown>;
			expect(record?.key).toBe(moved.id);
			expect(value).toMatchObject({
				v: 1,
				id: moved.id,
				kind: "move",
				epoch: 2,
				from: { environment: "a", provider: "local", box: "box-1" },
				to: { environment: "b", provider: "local", box: "box-2" },
				drainMs: moved.drainMs,
				shipMs: moved.shipMs,
				takeMs: expect.any(Number),
				bytes: moved.bytes,
				stopped: [],
			});
			// Its head is its seal's, and the commit it is in: the target's first.
			expect(value.head).toBe((value.seal as { head: number }).head);
			expect(record?.commit).toBe(value.head);
			expect(log.filter(({ commit }) => commit < (value.head as number)).length).toBe((value.head as number) - 1);
			for (const box of boxes) expect(JSON.stringify(value)).not.toContain(box.id);
			moved.home.close("the test is done");
		} finally {
			for (const box of boxes) await box.destroy(context);
			rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	}, 60_000);
});
