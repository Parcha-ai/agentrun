import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createSession } from "@earendil-works/pi-durable";
import { err, getOrThrow, ok, type Result } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, BoxError } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { checkpointStats, localVault, pullCheckpoint, restoreNotice } from "../src/home/checkpoint.ts";
import { dirStore } from "../src/home/dir-store.ts";
import { connectHome, type HomeHandle, RemoteError } from "../src/home/host.ts";
import { linkPair } from "../src/home/link.ts";
import { type MoveError, type Place, recoverHome, type StartRunner } from "../src/home/move.ts";
import { leaseIn } from "../src/home/ownership.ts";
import type { CheckpointTaken } from "../src/home/run.ts";
import { checkpointStore, sealStore } from "../src/home/store.ts";
import { walk } from "./home-support.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-ckpt-"));
const provider = localBoxes({ root });
const boxes: Box[] = [];
afterAll(async () => {
	for (const box of boxes) await box.destroy(context);
	rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
}, 120_000);

let counter = 0;
const fresh = (name: string) => join(root, `${name}-${counter++}`);

async function makeBox(): Promise<Box> {
	const box = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
	boxes.push(box);
	return box;
}

/** A store with `commits` entries, closed: a stand-in for a session's store at rest. */
async function writeStore(path: string, commits: number) {
	mkdirSync(join(path, ".."), { recursive: true });
	const session = createSession(await openNodeSqliteStorage(path));
	const conversation = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		context,
	);
	for (let index = 0; index < commits; index++) {
		await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "note", data: { index } }), context);
	}
	await session.close(context);
}

type Fixture = {
	readonly place: Place;
	readonly home: HomeHandle;
	/** Whether the home is held now, and every time it was let go. */
	state(): { held: boolean; released: number; checkpoints: number };
	/** Runs when the home is asked for a checkpoint, after it is held. */
	onHeld: (() => void) | undefined;
	/** Makes the next `checkpoint` order fail. */
	failWith: RemoteError | undefined;
};

/** A source box with a store and a workspace, and a home that does what `Home.checkpoint` does. */
async function source(commits = 5): Promise<Fixture> {
	const box = await makeBox();
	const workspace = join(box.facts().workspace, "work");
	mkdirSync(join(workspace, "dir"), { recursive: true });
	const place: Place = { environment: "a", provider: "local", box, workspace, store: join(fresh("s"), "run.sqlite") };
	await writeStore(place.store, commits);
	let held = false;
	let released = 0;
	let checkpoints = 0;
	const fixture: Fixture = {
		place,
		onHeld: undefined,
		failWith: undefined,
		state: () => ({ held, released, checkpoints }),
		home: {
			async checkpoint() {
				if (fixture.failWith !== undefined) return err(fixture.failWith);
				checkpoints += 1;
				const path = `${place.store}.checkpoint`;
				rmSync(path, { force: true });
				const copied = getOrThrow(await checkpointStore(place.store, path, context));
				held = true;
				fixture.onHeld?.();
				return ok({ seal: copied, path } satisfies CheckpointTaken);
			},
			async abandon() {
				held = false;
				released += 1;
				return ok(undefined);
			},
			calls: () => [],
		} as unknown as HomeHandle,
	};
	return fixture;
}

const noContext = context;

describe("pulling a checkpoint", () => {
	it("takes the store and the workspace of one moment, holds the session until both are on the host, and lets it go", async () => {
		const fx = await source();
		writeFileSync(join(fx.place.workspace, "a.txt"), "alpha");
		writeFileSync(join(fx.place.workspace, "dir", "b.bin"), Buffer.alloc(3000, 7));
		const vault = localVault(fresh("vault"));
		const stats = checkpointStats();
		const seenHeldDuringPull: boolean[] = [];
		const watching: Box = {
			...fx.place.box,
			id: fx.place.box.id,
			facts: () => fx.place.box.facts(),
			upload: (files, ctx) => fx.place.box.upload(files, ctx),
			download: (paths, ctx) => fx.place.box.download(paths, ctx),
			status: (ctx) => fx.place.box.status(ctx),
			destroy: (ctx) => fx.place.box.destroy(ctx),
			exec: (command, options, ctx) => {
				seenHeldDuringPull.push(fx.state().held);
				return fx.place.box.exec(command, options, ctx);
			},
		};
		const taken = getOrThrow(
			await pullCheckpoint(
				{ session: "s", place: { ...fx.place, box: watching }, home: fx.home, epoch: 1, vault, stats },
				noContext,
			),
		);
		expect(taken.n).toBe(1);
		expect(taken.epoch).toBe(1);
		expect(walk(taken.filesRoot)).toEqual(walk(fx.place.workspace));
		const sealed = getOrThrow(await sealStore(taken.storeFile, context));
		expect(sealed).toEqual(taken.seal);
		// Every program the pull ran in the box ran while the session was held, and the session is let go after.
		expect(seenHeldDuringPull.length).toBeGreaterThan(2);
		expect(seenHeldDuringPull.every(Boolean)).toBe(true);
		expect(fx.state()).toMatchObject({ held: false, released: 1 });
		expect(stats.taken).toBe(1);
		expect(stats.last?.n).toBe(1);
		expect(getOrThrow(await vault.latest("s", context))?.n).toBe(1);
	});

	it("moves only what changed after the first, keeps the older generation as it was, and keeps the newest `keep`", async () => {
		const fx = await source();
		writeFileSync(join(fx.place.workspace, "a.txt"), "alpha");
		writeFileSync(join(fx.place.workspace, "big.bin"), Buffer.alloc(200_000, 1));
		const vault = localVault(fresh("vault"));
		const stats = checkpointStats();
		const pull = async (keep = 2) =>
			getOrThrow(
				await pullCheckpoint(
					{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats, keep },
					noContext,
				),
			);
		const first = await pull();
		const firstBytes = stats.last?.bytes ?? 0;
		writeFileSync(join(fx.place.workspace, "a.txt"), "alpha edited");
		const second = await pull();
		const secondBytes = stats.last?.bytes ?? 0;
		// The big file was not sent again; the store copy and the one small file were.
		expect(secondBytes).toBeLessThan(firstBytes - 150_000);
		expect(readFileSync(join(second.filesRoot, "a.txt"), "utf8")).toBe("alpha edited");
		expect(readFileSync(join(first.filesRoot, "a.txt"), "utf8")).toBe("alpha");
		writeFileSync(join(fx.place.workspace, "c.txt"), "third");
		const third = await pull();
		expect(third.n).toBe(3);
		// Two kept: the first generation is gone, and its record with it.
		expect(getOrThrow(await vault.get("s", 1, context))).toBeUndefined();
		expect(getOrThrow(await vault.get("s", 2, context))?.n).toBe(2);
		expect(readdirSync(join(fx.place.workspace, "..")).length).toBeGreaterThan(0);
	});

	it("is skipped as busy, with what held the session, and leaves the previous checkpoint the latest", async () => {
		const fx = await source();
		const vault = localVault(fresh("vault"));
		const stats = checkpointStats();
		const first = getOrThrow(
			await pullCheckpoint({ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats }, noContext),
		);
		const holdouts = [{ kind: "ToolTask", count: 1 }];
		fx.failWith = new RemoteError(
			"timeout",
			"the session did not come to rest in 10000 ms: still running, 1 ToolTask",
			"DrainError",
			holdouts,
		);
		const skipped = await pullCheckpoint(
			{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats },
			noContext,
		);
		expect(skipped.ok ? "" : skipped.error.reason).toBe("busy");
		expect(skipped.ok ? [] : skipped.error.holdouts).toEqual(holdouts);
		expect(stats.skipped.busy).toBe(1);
		expect(stats.lastSkip?.reason).toBe("busy");
		expect(stats.lastSkip?.holdouts).toEqual(holdouts);
		expect(stats.taken).toBe(1);
		expect(getOrThrow(await vault.latest("s", context))?.n).toBe(first.n);
	});

	it("is skipped as changed when a file moves on while it is pulled, leaves no half generation, and lets the session go", async () => {
		const fx = await source();
		writeFileSync(join(fx.place.workspace, "a.txt"), "alpha");
		const vault = localVault(fresh("vault"));
		const stats = checkpointStats();
		const first = getOrThrow(
			await pullCheckpoint({ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats }, noContext),
		);
		writeFileSync(join(fx.place.workspace, "a.txt"), "beta!");
		// After the manifest is taken and before the files move, the file changes (a session that was not held would do so).
		let first_exec = true;
		const racing: Box = {
			id: fx.place.box.id,
			facts: () => fx.place.box.facts(),
			upload: (files, ctx) => fx.place.box.upload(files, ctx),
			download: (paths, ctx) => fx.place.box.download(paths, ctx),
			status: (ctx) => fx.place.box.status(ctx),
			destroy: (ctx) => fx.place.box.destroy(ctx),
			exec: (command, options, ctx) => {
				if (command.some((part) => part.includes("tar -c")) && first_exec) {
					first_exec = false;
					writeFileSync(join(fx.place.workspace, "a.txt"), "gamma");
				}
				return fx.place.box.exec(command, options, ctx);
			},
		};
		const skipped = await pullCheckpoint(
			{ session: "s", place: { ...fx.place, box: racing }, home: fx.home, epoch: 1, vault, stats },
			noContext,
		);
		expect(skipped.ok ? "" : skipped.error.reason).toBe("changed");
		expect(skipped.ok ? "" : skipped.error.message).toMatch(/a\.txt/);
		expect(getOrThrow(await vault.latest("s", context))?.n).toBe(first.n);
		expect(readFileSync(join(first.filesRoot, "a.txt"), "utf8")).toBe("alpha");
		// The generation that was begun is gone, and its number is not reused for a record.
		expect(fx.state().held).toBe(false);
		const again = getOrThrow(
			await pullCheckpoint({ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats }, noContext),
		);
		expect(again.n).toBeGreaterThan(first.n);
		expect(readFileSync(join(again.filesRoot, "a.txt"), "utf8")).toBe("gamma");
	});

	it("is skipped as too_large over maxBytes, and as failed for a store copy that does not match its seal", async () => {
		const fx = await source();
		writeFileSync(join(fx.place.workspace, "big.bin"), Buffer.alloc(50_000, 2));
		const vault = localVault(fresh("vault"));
		const stats = checkpointStats();
		const big = await pullCheckpoint(
			{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats, workspace: { maxBytes: 1000 } },
			noContext,
		);
		expect(big.ok ? "" : big.error.reason).toBe("too_large");
		expect(fx.state().held).toBe(false);
		// A home whose seal does not describe the copy it made.
		const lying = {
			...fx.home,
			async checkpoint(options: unknown, ctx: typeof context) {
				const taken = await (fx.home as HomeHandle).checkpoint(options as never, ctx);
				if (!taken.ok) return taken;
				return ok({ ...taken.value, seal: { ...taken.value.seal, sha256: "0".repeat(64) } });
			},
		} as unknown as HomeHandle;
		const bad = await pullCheckpoint(
			{ session: "s", place: fx.place, home: lying, epoch: 1, vault, stats },
			noContext,
		);
		expect(bad.ok ? "" : bad.error.reason).toBe("failed");
		expect(getOrThrow(await vault.latest("s", context))).toBeUndefined();
		expect(stats.skipped).toMatchObject({ too_large: 1, failed: 1 });
	});

	it("tells the model server to let go of the paid answers below the oldest generation it keeps", async () => {
		const fx = await source();
		const vault = localVault(fresh("vault"));
		const covered: number[] = [];
		const heads: number[] = [];
		for (let round = 0; round < 3; round++) {
			const taken = getOrThrow(
				await pullCheckpoint(
					{
						session: "s",
						place: fx.place,
						home: fx.home,
						epoch: 1,
						vault,
						keep: 2,
						answers: { covered: (head) => covered.push(head) },
					},
					noContext,
				),
			);
			heads.push(taken.seal.head);
			await writeStore(fx.place.store, 2);
		}
		// With two kept, the oldest kept is the first generation after the first pull, the second after the third.
		expect(covered).toEqual([heads[0], heads[0], heads[1]]);
		expect(heads[1]).toBeGreaterThan(heads[0] as number);
	});

	it("never pulls an excluded path, however large, and keeps the pull's hold and bytes small", async () => {
		const fx = await source();
		mkdirSync(join(fx.place.workspace, "media", "cache"), { recursive: true });
		writeFileSync(join(fx.place.workspace, "media", "cache", "footage.bin"), Buffer.alloc(50_000_000, 9));
		writeFileSync(join(fx.place.workspace, "notes.txt"), "keep me");
		const pulled = async (workspace: { exclude?: string[] }) => {
			const stats = checkpointStats();
			const vault = localVault(fresh("vault"));
			const taken = getOrThrow(
				await pullCheckpoint(
					{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats, workspace },
					noContext,
				),
			);
			return { taken, stats, vault };
		};
		const control = await pulled({});
		expect(control.stats.last?.bytes).toBeGreaterThan(50_000_000);
		const left = await pulled({ exclude: ["media"] });
		expect(readdirSync(left.taken.filesRoot).sort()).toEqual(["dir", "notes.txt"]);
		expect(left.taken.manifest.entries.map((entry) => entry.path).sort()).toEqual(["dir", "notes.txt"]);
		expect(left.stats.last?.bytes).toBeLessThan(1_000_000);
		expect(left.stats.last?.heldMs).toBeLessThan(5_000);
		expect(left.taken.excluded).toMatchObject({
			patterns: ["media"],
			entries: ["media"],
			more: 0,
			files: 1,
			bytes: 50_000_000,
		});
		// The record survives the vault: a later reader sees what was left out.
		expect(getOrThrow(await left.vault.latest("s", context))?.excluded).toEqual(left.taken.excluded);
	});

	it("skips a pull over maxPullBytes as too_large before any file moves, and lets the session go", async () => {
		const fx = await source();
		const vault = localVault(fresh("vault"));
		const stats = checkpointStats();
		const first = getOrThrow(
			await pullCheckpoint({ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats }, noContext),
		);
		writeFileSync(join(fx.place.workspace, "new.bin"), Buffer.alloc(2_000_000, 3));
		const over = await pullCheckpoint(
			{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats, maxPullBytes: 1_000_000 },
			noContext,
		);
		expect(over.ok ? "" : over.error.reason).toBe("too_large");
		expect(over.ok ? "" : over.error.message).toMatch(/limit is 1000000/);
		expect(fx.state().held).toBe(false);
		expect(getOrThrow(await vault.latest("s", context))?.n).toBe(first.n);
		// Inside the budget, the same pull goes through.
		const inside = await pullCheckpoint(
			{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, stats, maxPullBytes: 10_000_000 },
			noContext,
		);
		expect(inside.ok).toBe(true);
	});

	it("does not call a generation latest before its record is written", async () => {
		const vault = localVault(fresh("vault"));
		const pending = getOrThrow(await vault.begin("s", context));
		writeFileSync(pending.storeFile, "half");
		// The host dies here: nothing was committed.
		expect(getOrThrow(await vault.latest("s", context))).toBeUndefined();
		const next = getOrThrow(await vault.begin("s", context));
		expect(next.n).toBeGreaterThan(pending.n);
	});
});

describe("the calls a host saw", () => {
	it("are kept as they are reported, with their end, and a report from another epoch is ignored", async () => {
		const [left, right] = linkPair();
		const handle = connectHome(left, { models: createModels(), epoch: 3 });
		right.send({ t: "call", epoch: 3, phase: "start", id: "c1", tool: "bash", replay: "unsafe" });
		right.send({ t: "call", epoch: 3, phase: "start", id: "c2", tool: "read", replay: "safe" });
		right.send({ t: "call", epoch: 3, phase: "end", id: "c2", tool: "read", replay: "safe" });
		right.send({ t: "call", epoch: 2, phase: "start", id: "old", tool: "write", replay: "unsafe" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const calls = handle.calls();
		expect(calls.map((call) => [call.id, call.tool, call.replay, call.endedAt !== undefined])).toEqual([
			["c1", "bash", "unsafe", false],
			["c2", "read", "safe", true],
		]);
		handle.close("done");
	});
});

describe("the notice a restored session gets", () => {
	const at = Date.parse("2026-10-14T12:00:00.000Z");
	it("says when the checkpoint was taken and what did not survive", () => {
		const text = restoreNotice({ at }, []);
		expect(text).toContain("restored from a checkpoint taken at 2026-10-14T12:00:00.000Z");
		expect(text).toContain("did not survive");
		expect(text).toContain("check before you repeat one");
		expect(text).not.toContain("tool call");
	});

	it("names the calls since: those that may have had an effect and those safe to run again, and not the ones before", () => {
		const text = restoreNotice({ at }, [
			{ id: "1", tool: "old", replay: "unsafe", startedAt: at - 1000 },
			{ id: "2", tool: "bash", replay: "unsafe", startedAt: at + 1000 },
			{ id: "3", tool: "bash", replay: "unsafe", startedAt: at + 2000 },
			{ id: "4", tool: "read", replay: "safe", startedAt: at + 3000 },
		]);
		expect(text).toContain("3 tool calls");
		expect(text).toMatch(/may have had an effect[^.]*: bash\./);
		expect(text).toMatch(/safe to run again: read\./);
		expect(text).not.toContain("old");
	});
});

describe("recovering a session whose box is gone", () => {
	const NOTICE = "restored";
	const holder = (box: Box, environment: string) => ({ environment, provider: "local", box: box.id, host: "host-1" });

	async function lost() {
		const fx = await source();
		writeFileSync(join(fx.place.workspace, "a.txt"), "alpha");
		const vault = localVault(fresh("vault"));
		getOrThrow(await pullCheckpoint({ session: "s", place: fx.place, home: fx.home, epoch: 1, vault }, noContext));
		const directory = fresh("lease");
		const lease = leaseIn(dirStore(directory));
		getOrThrow(await lease.take("s", holder(fx.place.box, "a"), 0, undefined, context));
		const box = await makeBox();
		const target: Place = {
			environment: "x",
			provider: "local",
			box,
			workspace: join(box.facts().workspace, "work"),
			store: join(fresh("t"), "run.sqlite"),
		};
		const orders: unknown[] = [];
		const start: StartRunner = async (at, epoch) =>
			ok({
				ready: Promise.resolve(ok({ session: "s", state: "closed" as const })),
				async resume(order: unknown) {
					orders.push({ at: at.environment, epoch, order });
					return ok(undefined);
				},
				async status() {
					return ok({ state: "closed" as const, epoch: null });
				},
			} as unknown as HomeHandle);
		let replaced = 0;
		const replace = async (): Promise<Result<Place, MoveError>> => {
			replaced += 1;
			return ok(target);
		};
		return { fx, vault, lease, target, orders, start, replace, replaced: () => replaced };
	}

	it("rebuilds it in the box the caller makes: store and files copied and checked, the lease taken one epoch on with the checkpoint's seal", async () => {
		const r = await lost();
		getOrThrow(await r.fx.place.box.destroy(context));
		const recovered = getOrThrow(
			await recoverHome(
				{
					session: "s",
					ownership: r.lease,
					places: { a: r.fx.place },
					start: r.start,
					notice: "unused",
					vault: r.vault,
					replace: r.replace,
					noticeOfRestore: () => NOTICE,
				},
				context,
			),
		);
		const checkpoint = recovered.restored;
		expect(checkpoint?.n).toBe(1);
		expect(recovered.lease).toMatchObject({ epoch: 2, holder: { box: r.target.box.id }, seal: checkpoint?.seal });
		expect(recovered.lease.move).toBe("restore-2");
		expect(readFileSync(join(r.target.workspace, "a.txt"), "utf8")).toBe("alpha");
		expect(getOrThrow(await sealStore(r.target.store, context))).toEqual(checkpoint?.seal);
		expect(r.orders).toEqual([
			{
				at: "x",
				epoch: 2,
				order: {
					epoch: 2,
					seal: checkpoint?.seal,
					move: { id: "restore-2", notice: NOTICE, kind: "restore", head: checkpoint?.seal.head },
				},
			},
		]);
	});

	it("tells the restored session what was left out of its checkpoints, and does not bring it back", async () => {
		const fx = await source();
		mkdirSync(join(fx.place.workspace, "media"), { recursive: true });
		writeFileSync(join(fx.place.workspace, "media", "footage.bin"), Buffer.alloc(1_000_000, 5));
		writeFileSync(join(fx.place.workspace, "a.txt"), "alpha");
		const vault = localVault(fresh("vault"));
		getOrThrow(
			await pullCheckpoint(
				{ session: "s", place: fx.place, home: fx.home, epoch: 1, vault, workspace: { exclude: ["media"] } },
				noContext,
			),
		);
		const directory = fresh("lease");
		const lease = leaseIn(dirStore(directory));
		getOrThrow(await lease.take("s", holder(fx.place.box, "a"), 0, undefined, context));
		const box = await makeBox();
		const target: Place = {
			environment: "x",
			provider: "local",
			box,
			workspace: join(box.facts().workspace, "work"),
			store: join(fresh("t"), "run.sqlite"),
		};
		const orders: { order: { move?: { notice: string } } }[] = [];
		getOrThrow(await fx.place.box.destroy(context));
		getOrThrow(
			await recoverHome(
				{
					session: "s",
					ownership: lease,
					places: { a: fx.place },
					start: async () =>
						ok({
							ready: Promise.resolve(ok({ session: "s", state: "closed" as const })),
							async resume(order: unknown) {
								orders.push({ order: order as { move?: { notice: string } } });
								return ok(undefined);
							},
							async status() {
								return ok({ state: "closed" as const, epoch: null });
							},
						} as unknown as HomeHandle),
					notice: "unused",
					vault,
					replace: async (): Promise<Result<Place, MoveError>> => ok(target),
				},
				context,
			),
		);
		const notice = orders[0]?.order.move?.notice ?? "";
		expect(notice).toContain("Not restored: media (1 file, 1000000 bytes)");
		expect(notice).toContain("Fetch them again");
		expect(readFileSync(join(target.workspace, "a.txt"), "utf8")).toBe("alpha");
		expect(readdirSync(target.workspace).sort()).toEqual(["a.txt", "dir"]);
	});

	it("restores from the previous generation when the latest no longer checks out", async () => {
		const r = await lost();
		writeFileSync(join(r.fx.place.workspace, "a.txt"), "second");
		const second = getOrThrow(
			await pullCheckpoint(
				{ session: "s", place: r.fx.place, home: r.fx.home, epoch: 1, vault: r.vault },
				noContext,
			),
		);
		// The newest generation's file is damaged on the host's disk.
		writeFileSync(join(second.filesRoot, "a.txt"), "dama!");
		getOrThrow(await r.fx.place.box.destroy(context));
		const recovered = getOrThrow(
			await recoverHome(
				{
					session: "s",
					ownership: r.lease,
					places: { a: r.fx.place },
					start: r.start,
					notice: "unused",
					vault: r.vault,
					replace: r.replace,
				},
				context,
			),
		);
		expect(recovered.restored?.n).toBe(1);
		expect(readFileSync(join(r.target.workspace, "a.txt"), "utf8")).toBe("alpha");
	});

	it("restores from the previous generation when the latest store no longer matches its seal", async () => {
		const r = await lost();
		const second = getOrThrow(
			await pullCheckpoint(
				{ session: "s", place: r.fx.place, home: r.fx.home, epoch: 1, vault: r.vault },
				noContext,
			),
		);
		appendFileSync(second.storeFile, "damage");
		getOrThrow(await r.fx.place.box.destroy(context));
		const recovered = getOrThrow(
			await recoverHome(
				{
					session: "s",
					ownership: r.lease,
					places: { a: r.fx.place },
					start: r.start,
					notice: "unused",
					vault: r.vault,
					replace: r.replace,
				},
				context,
			),
		);
		expect(recovered.restored?.n).toBe(1);
	});

	it("says no_checkpoint when none checks out, makes no box and leaves the lease", async () => {
		const r = await lost();
		const only = getOrThrow(await r.vault.latest("s", context));
		writeFileSync(join(only?.filesRoot ?? "", "a.txt"), "dama!");
		getOrThrow(await r.fx.place.box.destroy(context));
		const recovered = await recoverHome(
			{
				session: "s",
				ownership: r.lease,
				places: { a: r.fx.place },
				start: r.start,
				notice: "unused",
				vault: r.vault,
				replace: r.replace,
			},
			context,
		);
		expect(recovered.ok ? "" : recovered.error.code).toBe("no_checkpoint");
		expect(r.replaced()).toBe(0);
		expect(getOrThrow(await r.lease.current("s", context))?.epoch).toBe(1);
	});

	it("does not rebuild a box that is only slow to answer, or one that lives", async () => {
		const r = await lost();
		const slow: Box = {
			...r.fx.place.box,
			id: r.fx.place.box.id,
			facts: () => r.fx.place.box.facts(),
			upload: (files, ctx) => r.fx.place.box.upload(files, ctx),
			download: (paths, ctx) => r.fx.place.box.download(paths, ctx),
			exec: (command, options, ctx) => r.fx.place.box.exec(command, options, ctx),
			destroy: (ctx) => r.fx.place.box.destroy(ctx),
			status: async () => err(new BoxError("timeout", "the provider did not answer")),
		};
		const started: string[] = [];
		const recovered = await recoverHome(
			{
				session: "s",
				ownership: r.lease,
				places: { a: { ...r.fx.place, box: slow } },
				start: async (at, epoch) => {
					started.push(`${at.environment}@${epoch}`);
					return r.start(at, epoch, context);
				},
				stop: async () => ok(undefined),
				notice: "unused",
				vault: r.vault,
				replace: r.replace,
			},
			context,
		);
		expect(recovered.ok).toBe(true);
		expect(r.replaced()).toBe(0);
		expect(started).toEqual(["a@1"]);
		expect(getOrThrow(await r.lease.current("s", context))?.epoch).toBe(1);
	});
});
