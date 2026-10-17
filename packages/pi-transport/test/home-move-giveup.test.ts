import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dirStore } from "../src/home/dir-store.ts";
import { type HomeHandle, RemoteError } from "../src/home/host.ts";
import { moveHome, type Place, type StartRunner } from "../src/home/move.ts";
import { leaseIn, type Ownership } from "../src/home/ownership.ts";
import type { HomeState, ResumeOrder } from "../src/home/run.ts";

const context = BACKGROUND_CONTEXT;
const SESSION = "s-1";
const SEAL = { head: 12, sha256: "a".repeat(64), bytes: 4096 };

/** A box whose every call fails: a move that reaches the ship cannot ship. */
const deadBox = (id: string) =>
	({ id, exec: async () => err(new Error("the box is gone")), facts: () => ({ workspace: "/w" }) }) as unknown as Box;
const place = (environment: string): Place => ({
	environment,
	provider: "test",
	box: deadBox(`box-${environment}`),
	store: "/session/run.sqlite",
	workspace: `/workspace-${environment}`,
});

/**
 * The source of a move: it drains, its seal answers `seal`, it is in `state` when asked afterwards, and its resume
 * answers `resumed`. Every order it is given after the seal is written down.
 */
function sourceThat(
	seal: "fails" | "works",
	state: HomeState,
	resumed: "works" | "fails" = "works",
): { home: HomeHandle; orders: unknown[] } {
	const orders: unknown[] = [];
	const home: Partial<HomeHandle> = {
		async drain() {
			return ok({ held: 0, closeable: 0, ms: 0 });
		},
		async seal() {
			return seal === "works" ? ok(SEAL) : err(new RemoteError("store", "could not seal the store: aborted"));
		},
		async status() {
			return ok({ state, epoch: 1 });
		},
		async resume(order: ResumeOrder) {
			orders.push({ resume: order });
			return resumed === "works" ? ok(undefined) : err(new RemoteError("store", "could not open the store"));
		},
		async reopen(epoch: number) {
			orders.push({ reopen: epoch });
			return ok(undefined);
		},
	};
	return { home: home as HomeHandle, orders };
}

/**
 * A target that is ready in `state` (retired at `retiredAt`, by the note of `noteFor`; `null`: a note that names no
 * session), and writes down that it was closed.
 */
function target(
	state: HomeState = "closed",
	retiredAt = 0,
	noteFor: string | null = SESSION,
): { start: StartRunner; closed: string[] } {
	const closed: string[] = [];
	const start: StartRunner = async () => {
		const handle: Partial<HomeHandle> = {
			ready: Promise.resolve(ok({ session: SESSION, state })),
			async status() {
				return ok({ state, epoch: retiredAt, ...(noteFor === null ? {} : { session: noteFor }) });
			},
			close(reason: string) {
				closed.push(reason);
			},
		};
		return ok(handle as HomeHandle);
	};
	return { start, closed };
}

async function withLease(use: (lease: Ownership) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-giveup-"));
	try {
		const lease = leaseIn(dirStore(directory));
		getOrThrow(
			await lease.take(
				SESSION,
				{ environment: "a", provider: "test", box: "box-a", host: "h" },
				0,
				undefined,
				context,
			),
		);
		await use(lease);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const moveFrom = (lease: Ownership, home: HomeHandle, start: StartRunner, to: Place = place("b")) =>
	moveHome(
		{
			session: SESSION,
			host: "h",
			ownership: lease,
			from: { place: place("a"), home, epoch: 1 },
			to,
			start,
			notice: "unused",
		},
		context,
	);

/** A place whose box writes down every program it is asked to run, and runs none. */
function watched(workspace: string, store: string): { place: Place; calls: unknown[] } {
	const calls: unknown[] = [];
	const box = {
		id: "box-b",
		exec: async (argv: readonly string[]) => {
			calls.push(argv);
			return err(new Error("the box runs nothing"));
		},
	} as unknown as Box;
	return { place: { environment: "b", provider: "test", box, store, workspace }, calls };
}

describe("a move back to a place the session left", () => {
	it("refuses, before the drain, a retired place whose note is another session's or names none", async () => {
		for (const noteFor of ["s-other", null]) {
			await withLease(async (lease) => {
				const source = sourceThat("works", "open");
				const to = target("retired", 1, noteFor);
				const moved = await moveFrom(lease, source.home, to.start);
				expect(moved.ok ? "" : moved.error.code, String(noteFor)).toBe("prepare");
				expect(moved.ok ? "" : moved.error.message).toContain("it takes nothing back");
				expect(source.orders).toEqual([]);
			});
		}
	});

	it("empties nothing, and asks the box nothing, for a workspace that is the root or holds the store", async () => {
		for (const [workspace, store] of [
			["/", "/session/run.sqlite"],
			["/srv/b", "/srv/b/session/run.sqlite"],
		] as const) {
			await withLease(async (lease) => {
				const source = sourceThat("works", "sealed");
				const to = watched(workspace, store);
				const moved = await moveFrom(lease, source.home, target("retired", 1).start, to.place);
				expect(moved.ok ? "" : moved.error.code, workspace).toBe("ship");
				expect(moved.ok ? "" : moved.error.message).toContain("the old workspace may not be emptied");
				expect(to.calls, workspace).toEqual([]);
				expect(source.orders).toEqual([{ reopen: 1 }]);
			});
		}
	});
});

describe("a move given up before the take", () => {
	it("refuses, before the drain, a place that retired at the epoch the move would bring the session at or later", async () => {
		await withLease(async (lease) => {
			const source = sourceThat("works", "open");
			let drained = false;
			const home = {
				...source.home,
				async drain() {
					drained = true;
					return ok({ held: 0, closeable: 0, ms: 0 });
				},
			};
			const to = target("retired", 2);
			const moved = await moveFrom(lease, home as HomeHandle, to.start);
			expect(moved.ok ? "" : moved.error.code).toBe("prepare");
			expect(moved.ok ? "" : moved.error.message).toContain("retired at epoch 2");
			expect(drained).toBe(false);
			expect(to.closed).toHaveLength(1);
		});
	});

	it("resumes a source whose seal failed after it closed its store, at its own epoch, and says it runs again", async () => {
		await withLease(async (lease) => {
			const source = sourceThat("fails", "closed");
			const to = target();
			const moved = await moveFrom(lease, source.home, to.start);
			expect(moved.ok ? "" : moved.error.code).toBe("seal");
			expect(moved.ok ? "" : moved.error.message).toContain("the source runs again");
			expect(source.orders).toEqual([{ resume: { epoch: 1 } }]);
			expect(to.closed).toHaveLength(1);
			expect(getOrThrow(await lease.current(SESSION, context))?.epoch).toBe(1);
		});
	});

	it("says so when that source does not run again, so a host recovers it from the lease", async () => {
		await withLease(async (lease) => {
			const source = sourceThat("fails", "closed", "fails");
			const moved = await moveFrom(lease, source.home, target().start);
			expect(moved.ok ? "" : moved.error.code).toBe("seal");
			expect(moved.ok ? "" : moved.error.message).toContain(
				"the source did not run again (could not open the store)",
			);
			expect(moved.ok ? "" : moved.error.message).toContain("a host recovers it from the lease");
		});
	});

	it("tells a source that did seal to open its store again when the ship fails", async () => {
		await withLease(async (lease) => {
			const source = sourceThat("works", "sealed");
			const moved = await moveFrom(lease, source.home, target().start);
			expect(moved.ok ? "" : moved.error.code).toBe("ship");
			expect(moved.ok ? "" : moved.error.message).toContain("the source runs again");
			expect(source.orders).toEqual([{ reopen: 1 }]);
		});
	});

	it("orders nothing when a source whose seal failed is still open", async () => {
		await withLease(async (lease) => {
			const source = sourceThat("fails", "open");
			const moved = await moveFrom(lease, source.home, target().start);
			expect(moved.ok ? "" : moved.error.message).toContain("the source runs on");
			expect(source.orders).toEqual([]);
		});
	});
});
