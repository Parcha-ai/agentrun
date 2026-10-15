import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dirStore } from "../src/home/dir-store.ts";
import type { HomeHandle } from "../src/home/host.ts";
import { type Place, recoverHome, type StartRunner } from "../src/home/move.ts";
import { leaseIn, type Ownership } from "../src/home/ownership.ts";
import type { HomeState, ResumeOrder } from "../src/home/run.ts";
import type { StopRunner } from "../src/home/stop.ts";

const context = BACKGROUND_CONTEXT;
const SESSION = "s-1";
const NOTICE = "System notice: you now run in b.";
const SEAL = { head: 12, sha256: "a".repeat(64), bytes: 4096 };
/** The seal a sealed home says it holds: its own, not one a lease carried to it. */
const OWN_SEAL = { head: 30, sha256: "b".repeat(64), bytes: 8192 };

/** Recovery starts runners only through `start`: a place needs no box that does anything. */
const place = (environment: string): Place => ({
	environment,
	provider: "test",
	box: { id: `box-${environment}` } as unknown as Box,
	store: "/session/run.sqlite",
	workspace: `/workspace-${environment}`,
});
const places = { a: place("a"), b: place("b") };

/**
 * A runner that is ready in `state`, says it is at `homeEpoch` (and, sealed, that it holds `OWN_SEAL`), and writes down
 * every order it is given; `started` holds every stop and start in order, and every epoch and close the host gave its
 * handle. `stops` false: the runner that still runs there will not stop. `onStart` runs as the runner starts.
 */
function runnerIn(state: HomeState, homeEpoch: number | null = 1, stops = true, onStart?: () => Promise<void>) {
	const orders: unknown[] = [];
	const started: string[] = [];
	const stop: StopRunner = async (at) => {
		started.push(`stop ${at.environment}`);
		return stops ? ok(undefined) : err(new Error("it runs on"));
	};
	const start: StartRunner = async (at, epoch) => {
		started.push(`${at.environment}@${epoch}`);
		await onStart?.();
		const handle: Partial<HomeHandle> = {
			ready: Promise.resolve(ok({ session: SESSION, state })),
			setEpoch(next: number) {
				started.push(`epoch ${next}`);
			},
			close(reason: string) {
				started.push(`close: ${reason}`);
			},
			async resume(order: ResumeOrder) {
				orders.push({ resume: order });
				return ok(undefined);
			},
			async status() {
				return ok({ state, epoch: homeEpoch, ...(state === "sealed" ? { sealed: OWN_SEAL } : {}) });
			},
			async reopen(reopenEpoch: number) {
				orders.push({ reopen: reopenEpoch });
				return ok(undefined);
			},
		};
		return ok(handle as HomeHandle);
	};
	return { start, stop, orders, started };
}

async function withLease(use: (lease: Ownership) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-recover-"));
	try {
		await use(leaseIn(dirStore(directory)));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const holder = (environment: string) => ({ environment, provider: "test", box: `box-${environment}`, host: "host-1" });

describe("recovering a session from its lease", () => {
	it("resumes a target that took the session and never resumed, with the lease's seal and move and the host's notice", async () => {
		await withLease(async (lease) => {
			getOrThrow(await lease.take(SESSION, holder("a"), 0, undefined, context));
			getOrThrow(await lease.take(SESSION, holder("b"), 1, { move: "move-1", seal: SEAL }, context));
			const runner = runnerIn("closed");
			const recovered = getOrThrow(
				await recoverHome(
					{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
					context,
				),
			);
			expect(recovered.lease.epoch).toBe(2);
			expect(runner.started).toEqual(["stop b", "b@2"]);
			expect(runner.orders).toEqual([
				{ resume: { epoch: 2, seal: SEAL, move: { id: "move-1", notice: NOTICE, kind: "move", head: SEAL.head } } },
			]);
		});
	});

	it("takes the next epoch for a home sealed at the lease's epoch, with that home's seal, and resumes it there", async () => {
		await withLease(async (lease) => {
			getOrThrow(await lease.take(SESSION, holder("a"), 0, undefined, context));
			const runner = runnerIn("sealed");
			const recovered = getOrThrow(
				await recoverHome(
					{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
					context,
				),
			);
			expect(recovered.lease).toMatchObject({ epoch: 2, holder: holder("a"), seal: OWN_SEAL });
			expect(runner.started).toEqual(["stop a", "a@1", "epoch 2"]);
			expect(runner.orders).toEqual([{ resume: { epoch: 2, seal: OWN_SEAL } }]);
			// A move that sealed this home and comes to take that epoch for another place now loses.
			const late = await lease.take(SESSION, holder("b"), 1, { move: "move-1", seal: SEAL }, context);
			expect(late.ok ? "" : late.error.code).toBe("lost");
			expect(getOrThrow(await lease.current(SESSION, context))).toMatchObject({ epoch: 2, holder: holder("a") });
		});
	});

	it("opens nothing when a move took the next epoch first, and says where the lease puts the session", async () => {
		await withLease(async (lease) => {
			getOrThrow(await lease.take(SESSION, holder("a"), 0, undefined, context));
			// After recovery read the lease: the move that sealed `a` takes the next epoch for `b`.
			const runner = runnerIn("sealed", 1, true, async () => {
				getOrThrow(await lease.take(SESSION, holder("b"), 1, { move: "move-1", seal: SEAL }, context));
			});
			const lost = await recoverHome(
				{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
				context,
			);
			expect(lost.ok ? "" : lost.error.code).toBe("lost");
			expect(lost.ok ? undefined : lost.error.lease).toMatchObject({
				epoch: 2,
				holder: holder("b"),
				move: "move-1",
			});
			expect(lost.ok ? "" : lost.error.message).toContain("the lease names b at epoch 2");
			expect(runner.orders).toEqual([]);
			expect(runner.started).toEqual(["stop a", "a@1", "close: the session is not this place's"]);
			expect(getOrThrow(await lease.current(SESSION, context))).toMatchObject({ epoch: 2, holder: holder("b") });
		});
	});

	it("resumes a home sealed below a lease that a recovery took forward for it, with that seal, and takes nothing", async () => {
		await withLease(async (lease) => {
			getOrThrow(await lease.take(SESSION, holder("a"), 0, undefined, context));
			// A recovery took the next epoch and stopped before the home ran.
			getOrThrow(await lease.take(SESSION, holder("a"), 1, { seal: OWN_SEAL }, context));
			const runner = runnerIn("sealed", 1);
			const recovered = getOrThrow(
				await recoverHome(
					{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
					context,
				),
			);
			expect(recovered.lease.epoch).toBe(2);
			expect(runner.started).toEqual(["stop a", "a@2"]);
			expect(runner.orders).toEqual([{ resume: { epoch: 2, seal: OWN_SEAL } }]);
		});
	});

	it("resumes a sealed home that the lease names at a later epoch with the lease's seal, and does not reopen it", async () => {
		await withLease(async (lease) => {
			getOrThrow(await lease.take(SESSION, holder("a"), 0, undefined, context));
			// Another host moved the session back to the place it was sealed in.
			getOrThrow(await lease.take(SESSION, holder("a"), 1, { move: "move-back", seal: SEAL }, context));
			const runner = runnerIn("sealed", 1);
			getOrThrow(
				await recoverHome(
					{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
					context,
				),
			);
			expect(runner.orders).toEqual([
				{
					resume: {
						epoch: 2,
						seal: SEAL,
						move: { id: "move-back", notice: NOTICE, kind: "move", head: SEAL.head },
					},
				},
			]);
		});
	});

	it("resumes a session that never moved with no seal and no notice", async () => {
		await withLease(async (lease) => {
			getOrThrow(await lease.take(SESSION, holder("a"), 0, undefined, context));
			const runner = runnerIn("closed");
			getOrThrow(
				await recoverHome(
					{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
					context,
				),
			);
			expect(runner.orders).toEqual([{ resume: { epoch: 1 } }]);
		});
	});

	it("starts nothing where a runner that still runs will not stop", async () => {
		await withLease(async (lease) => {
			getOrThrow(await lease.take(SESSION, holder("a"), 0, undefined, context));
			const runner = runnerIn("closed", 1, false);
			const refused = await recoverHome(
				{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
				context,
			);
			expect(refused.ok ? "" : refused.error.code).toBe("resume");
			expect(runner.started).toEqual(["stop a"]);
		});
	});

	it("starts nothing for a session with no lease, or a lease that names an environment it does not know", async () => {
		await withLease(async (lease) => {
			const runner = runnerIn("closed");
			const none = await recoverHome(
				{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
				context,
			);
			expect(none.ok ? "" : none.error.code).toBe("take");
			getOrThrow(await lease.take(SESSION, holder("gpu"), 0, undefined, context));
			const unknown = await recoverHome(
				{ session: SESSION, ownership: lease, places, start: runner.start, stop: runner.stop, notice: NOTICE },
				context,
			);
			expect(unknown.ok ? "" : unknown.error.code).toBe("resume");
			expect(runner.started).toEqual([]);
		});
	});
});
