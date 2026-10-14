import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box } from "../box/box.ts";
import { type Checkpoint, type CheckpointVault, restoreNotice } from "./checkpoint.ts";
import type { DrainOptions } from "./gate.ts";
import type { CallRecord, HomeHandle } from "./host.ts";
import type { Holder, LeaseRecord, Ownership } from "./ownership.ts";
import { type StopRunner, stopRunner } from "./stop.ts";
import { type Seal, verifyStore } from "./store.ts";
import { manifestOf, moveFile, moveWorkspace, type WorkspaceOptions } from "./workspace.ts";

/** One place a session's home can be: an environment, its box, and where the store and the workspace are in it. */
export type Place = {
	readonly environment: string;
	readonly provider: string;
	readonly box: Box;
	/** The store's file in the box. Outside the workspace: the workspace moves on its own. */
	readonly store: string;
	readonly workspace: string;
};

/** How a host starts the runner at a place and holds it, at the given epoch. */
export type StartRunner = (place: Place, epoch: number, context: Context) => Promise<Result<HomeHandle, MoveError>>;

/** The steps of a move, in order. */
export type MoveStep = "prepare" | "drain" | "seal" | "ship" | "take" | "resume" | "retire";

/**
 * Why a move did not happen. `no_runtime`: the target's box has no Node, or one below 22.19. `prepare`: the target could
 * not be made ready. Nothing changed after either. `drain`: the session did
 * not come to rest in time (`holdouts` names what ran on); it works on where it was. `seal`, `ship`: the source was
 * told to open its store again. `target`: the target's runner went away before the take; the source was told to open
 * its store again. `lost`: another host took the session first; this host does nothing more with it.
 * `take`: the lease could not be written and could not be read back; the source stays sealed until a host recovers
 * the session; the copy shipped to the target is deleted, unless the lease names the target's own place. `resume`:
 * after the take, the target did not resume; the session is the target's, and a host recovers
 * it from the lease.
 */
export type MoveErrorCode =
	| "no_runtime"
	| "prepare"
	| "drain"
	| "seal"
	| "ship"
	| "target"
	| "lost"
	| "take"
	| "resume"
	| "no_checkpoint";

/** A move that did not complete, and where it stopped. Returned, never thrown. */
export class MoveError extends Error {
	public code: MoveErrorCode;
	public holdouts: readonly { readonly kind: string; readonly count: number }[];

	constructor(code: MoveErrorCode, message: string, holdouts: MoveError["holdouts"] = []) {
		super(message);
		this.name = "MoveError";
		this.code = code;
		this.holdouts = holdouts;
	}
}

/** What a move did, with its times. */
export type MoveReceipt = {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly epoch: number;
	readonly drainMs: number;
	readonly shipMs: number;
	readonly totalMs: number;
	readonly bytes: number;
	/** Whether the source took the order to retire. A source that did not is fenced by the epoch all the same. */
	readonly retired: boolean;
	/** The host's hold on the session's new home. */
	readonly home: HomeHandle;
};

export type MoveOptions = {
	readonly session: string;
	/** Who this host is, for the lease. */
	readonly host: string;
	readonly ownership: Ownership;
	/** The home now: its place, the host's hold on it, and the epoch it runs at. */
	readonly from: { readonly place: Place; readonly home: HomeHandle; readonly epoch: number };
	readonly to: Place;
	readonly start: StartRunner;
	/** What the agent is told when it runs at its new home. */
	readonly notice: string;
	readonly drain?: DrainOptions;
	readonly workspace?: WorkspaceOptions & { readonly maxBytes?: number };
	readonly id?: string;
	/** Called before each step. A test stops a move here. */
	readonly onStep?: (step: MoveStep) => void | Promise<void>;
};

function holderOf(place: Place, host: string): Holder {
	return { environment: place.environment, provider: place.provider, box: place.box.id, host };
}

/**
 * Move a session's home from one place to another with no disk the two share. The seven steps of the handoff:
 * prepare the target, drain the source, seal it, ship store and workspace, take the lease, resume the target,
 * retire the source.
 *
 * Invariants: nothing is cut (a drain that does not complete gives the move up and the session works on); before the
 * take, a failure leaves the session where it was; the take is the one step that changes who holds the session, and
 * after it nothing makes the source run again.
 */
export async function moveHome(options: MoveOptions, context: Context): Promise<Result<MoveReceipt, MoveError>> {
	const { session, host, ownership, from, to, start } = options;
	const id = options.id ?? `move-${randomUUID()}`;
	const epoch = from.epoch;
	const started = performance.now();
	const step = async (name: MoveStep) => options.onStep?.(name);
	// What runs after a failure must not be stopped by the abort that caused it.
	const cleanup = withoutAbortSignal(context);
	const giveUp = async (target: HomeHandle | undefined, error: MoveError) => {
		target?.close(`the move ${id} was given up`);
		return err<MoveReceipt, MoveError>(error);
	};

	await step("prepare");
	const prepared = await start(to, epoch, context);
	if (!prepared.ok) return err(prepared.error);
	const target = prepared.value;
	const ready = await target.ready;
	if (!ready.ok) return giveUp(target, new MoveError("prepare", `the target did not answer: ${ready.error.message}`));
	if (ready.value.state !== "closed") {
		return giveUp(
			target,
			new MoveError("prepare", `the target already holds a session that is ${ready.value.state}`),
		);
	}

	await step("drain");
	const drainStarted = performance.now();
	const drained = await from.home.drain(options.drain, context);
	if (!drained.ok) {
		// A drain that failed has opened the gate again by itself: nothing is held.
		const message = `the session did not come to rest: ${drained.error.message}`;
		return giveUp(target, new MoveError("drain", message, drained.error.holdouts));
	}
	const drainMs = Math.round(performance.now() - drainStarted);

	await step("seal");
	const sealed = await from.home.seal(context);
	if (!sealed.ok) {
		await from.home.reopen(epoch, cleanup);
		return giveUp(target, new MoveError("seal", `the source could not seal its store: ${sealed.error.message}`));
	}
	const seal: Seal = sealed.value;

	await step("ship");
	const shipStarted = performance.now();
	let shipped: Result<{ bytes: number }, Error> = err(new Error("not tried"));
	for (let attempt = 0; attempt < 2 && !shipped.ok; attempt += 1)
		shipped = await ship(from.place, to, seal, options, context);
	if (!shipped.ok) {
		await from.home.reopen(epoch, cleanup);
		return giveUp(target, new MoveError("ship", `the store and workspace did not move: ${shipped.error.message}`));
	}
	const shipMs = Math.round(performance.now() - shipStarted);

	await step("take");
	// The point of no return: only with a target that still answers.
	const alive = await target.status(context);
	if (!alive.ok) {
		await from.home.reopen(epoch, cleanup);
		return giveUp(target, new MoveError("target", `the target went away before the take: ${alive.error.message}`));
	}
	const taken = await ownership.take(session, holderOf(to, host), epoch, { move: id, seal }, context);
	if (!taken.ok) {
		// A write whose answer was lost may have landed: the lease says.
		const now = await ownership.current(session, cleanup);
		const ours = now.ok && now.value?.move === id && now.value.epoch === epoch + 1;
		if (!ours) {
			if (taken.error.code === "lost") {
				// Another host acted. The copy this move shipped goes, unless the lease names this very place: then it is
				// that host's copy too.
				const holder = now.ok ? now.value?.holder : undefined;
				if (holder !== undefined && (holder.environment !== to.environment || holder.box !== to.box.id)) {
					await target.retire(epoch + 1, cleanup);
				}
				return giveUp(target, new MoveError("lost", `another host took the session first: ${taken.error.message}`));
			}
			if (now.ok && now.value?.epoch === epoch) {
				await from.home.reopen(epoch, cleanup);
				return giveUp(target, new MoveError("take", `the lease was not written: ${taken.error.message}`));
			}
			// Neither written for sure nor not: the source stays sealed and a host recovers the session from the lease.
			return giveUp(target, new MoveError("take", `the lease cannot be read back: ${taken.error.message}`));
		}
	}
	const next = epoch + 1;

	await step("resume");
	target.setEpoch(next);
	const resumed = await target.resume({ epoch: next, seal, move: { id, notice: options.notice } }, context);
	if (!resumed.ok) {
		return err(new MoveError("resume", `the target took the session and did not resume: ${resumed.error.message}`));
	}

	await step("retire");
	const retired = await from.home.retire(next, cleanup);
	return ok({
		id,
		from: from.place.environment,
		to: to.environment,
		epoch: next,
		drainMs,
		shipMs,
		totalMs: Math.round(performance.now() - started),
		bytes: seal.bytes + (shipped.ok ? shipped.value.bytes : 0),
		retired: retired.ok,
		home: target,
	});
}

/** The store, then the workspace, from one place to the other, each checked on the target. */
async function ship(
	from: Place,
	to: Place,
	seal: Seal,
	options: MoveOptions,
	context: Context,
): Promise<Result<{ bytes: number }, Error>> {
	const file = await moveFile(from.box, from.store, to.box, to.store, seal, undefined, context);
	if (!file.ok) return file;
	const tree = await moveWorkspace(
		from.box,
		to.box,
		{ fromRoot: from.workspace, toRoot: to.workspace, ...options.workspace },
		context,
	);
	if (!tree.ok) return tree;
	return ok({ bytes: tree.value.bytes });
}

export type RecoverOptions = {
	readonly session: string;
	readonly ownership: Ownership;
	/** Every place the session can be, by environment. */
	readonly places: Readonly<Record<string, Place>>;
	readonly start: StartRunner;
	/**
	 * What the agent is told when the lease names a move whose new home had not resumed yet. The lease keeps the move's
	 * id, not its text; a home that already admitted the move's notice admits no second one.
	 */
	readonly notice: string;
	/**
	 * How the runner that may still run at the lease's place is stopped before a new one starts there. Default
	 * `stopRunner`: the process named in `<store>.pid`. A host whose runners a launcher keeps passes the launcher's stop.
	 */
	readonly stop?: StopRunner;
	/**
	 * Where the host keeps checkpoints, and how it makes a box to restore one into. Together they let a session whose
	 * box is gone live again: both are needed, and `recoverHome` never makes a box itself.
	 */
	readonly vault?: CheckpointVault;
	readonly replace?: (place: Place, context: Context) => Promise<Result<Place, MoveError>>;
	/** Who this host is, for the lease it takes when it restores. Default `host`. */
	readonly host?: string;
	/** The tool calls the host saw begin, from the dead home's handle: the restored session is told of those since the checkpoint. */
	readonly calls?: readonly CallRecord[];
	/** The text of the notice a restored session gets. Default `restoreNotice`. */
	readonly noticeOfRestore?: (checkpoint: Checkpoint, calls: readonly CallRecord[]) => string;
	/** The files of a restore are copied with these limits. */
	readonly workspace?: WorkspaceOptions & { readonly maxBytes?: number };
};

/** Whether a box is gone for good: its provider says it ended, or does not know it. An error that is not that is not an answer. */
async function boxGone(box: Box, context: Context): Promise<boolean> {
	const status = await box.status(context);
	if (status.ok) return status.value.state === "ended";
	return status.error.code === "gone" || status.error.code === "not_found";
}

/** The newest checkpoint whose store and tree are what its record says, or `undefined`. */
async function usableCheckpoint(
	vault: CheckpointVault,
	session: string,
	context: Context,
): Promise<Checkpoint | undefined> {
	const latest = await vault.latest(session, context);
	if (!latest.ok || latest.value === undefined) return undefined;
	for (let n = latest.value.n; n >= 1; n -= 1) {
		const got = await vault.get(session, n, context);
		const checkpoint = got.ok ? got.value : undefined;
		if (checkpoint === undefined) continue;
		if (!(await verifyStore(checkpoint.storeFile, checkpoint.seal, context)).ok) continue;
		const tree = await manifestOf(vault.box, checkpoint.filesRoot, undefined, context);
		if (!tree.ok) continue;
		const mine = (entries: readonly { path: string; kind: string; bytes: number; sha256?: string }[]) =>
			JSON.stringify(entries.map((e) => [e.path, e.kind, e.bytes, e.sha256 ?? null]));
		if (mine(tree.value.entries) === mine(checkpoint.manifest.entries)) return checkpoint;
	}
	return undefined;
}

/**
 * The session's box is gone: build its home again in a box the caller makes, from the latest checkpoint that still
 * checks out, and take the lease at the next epoch. A home at the old epoch that was only unreachable is refused at its
 * next model request and ends.
 */
async function restoreHome(
	options: RecoverOptions & {
		readonly vault: CheckpointVault;
		readonly replace: NonNullable<RecoverOptions["replace"]>;
	},
	record: LeaseRecord,
	gone: Place,
	context: Context,
): Promise<
	Result<{ readonly lease: LeaseRecord; readonly home: HomeHandle; readonly restored: Checkpoint }, MoveError>
> {
	const { session, vault, ownership } = options;
	const checkpoint = await usableCheckpoint(vault, session, context);
	if (checkpoint === undefined) {
		return err(new MoveError("no_checkpoint", `the box of ${session} is gone and no checkpoint of it checks out`));
	}
	const made = await options.replace(gone, context);
	if (!made.ok) return made;
	const place = made.value;
	const id = `restore-${record.epoch + 1}`;
	const file = await moveFile(
		vault.box,
		checkpoint.storeFile,
		place.box,
		place.store,
		checkpoint.seal,
		undefined,
		context,
	);
	if (!file.ok)
		return err(new MoveError("ship", `the checkpoint's store did not reach the new box: ${file.error.message}`));
	const tree = await moveWorkspace(
		vault.box,
		place.box,
		{ fromRoot: checkpoint.filesRoot, toRoot: place.workspace, ...options.workspace },
		context,
	);
	if (!tree.ok)
		return err(new MoveError("ship", `the checkpoint's files did not reach the new box: ${tree.error.message}`));
	const host = options.host ?? "host";
	const holder = { environment: place.environment, provider: place.provider, box: place.box.id, host };
	const taken = await ownership.take(session, holder, record.epoch, { move: id, seal: checkpoint.seal }, context);
	if (!taken.ok) {
		const code = taken.error.code === "lost" ? "lost" : "take";
		return err(new MoveError(code, `the lease was not taken: ${taken.error.message}`));
	}
	const epoch = taken.value.epoch;
	const started = await options.start(place, epoch, context);
	if (!started.ok) return started;
	const home = started.value;
	const ready = await home.ready;
	if (!ready.ok) return err(new MoveError("resume", `the restored home did not answer: ${ready.error.message}`));
	const notice = (options.noticeOfRestore ?? restoreNotice)(checkpoint, options.calls ?? []);
	const resumed = await home.resume({ epoch, seal: checkpoint.seal, move: { id, notice } }, context);
	if (!resumed.ok) return err(new MoveError("resume", `the restored home did not run: ${resumed.error.message}`));
	return ok({ lease: taken.value, home, restored: checkpoint });
}

/**
 * What a host that starts again does: read the lease, stop a runner that still runs where it says, start one there,
 * and make that home run. A home that sealed at the lease's epoch is told to open its store again; a target that took
 * the session and never resumed is told to resume with the lease's seal and move, and its store says which workspace
 * its conversations pointed at. Safe to repeat.
 */
export async function recoverHome(
	options: RecoverOptions,
	context: Context,
): Promise<
	Result<{ readonly lease: LeaseRecord; readonly home: HomeHandle; readonly restored?: Checkpoint }, MoveError>
> {
	const lease = await options.ownership.current(options.session, context);
	if (!lease.ok) return err(new MoveError("take", `the lease cannot be read: ${lease.error.message}`));
	const record = lease.value;
	if (record === undefined) return err(new MoveError("take", `the session ${options.session} has no lease`));
	const place = Object.hasOwn(options.places, record.holder.environment)
		? options.places[record.holder.environment]
		: undefined;
	if (place === undefined) {
		return err(
			new MoveError("resume", `the lease names the environment "${record.holder.environment}", which is not known`),
		);
	}
	// A box that is gone cannot be stopped or reopened: the session lives again from the latest checkpoint, if the host
	// keeps them and can make a box.
	if (options.vault !== undefined && options.replace !== undefined && (await boxGone(place.box, context))) {
		return restoreHome({ ...options, vault: options.vault, replace: options.replace }, record, place, context);
	}
	// Never two runners on one store: one that still runs there is stopped first, and its call in flight is cut.
	const stopped = await (options.stop ?? stopRunner)(place, context);
	if (!stopped.ok) {
		return err(
			new MoveError(
				"resume",
				`the runner still running in ${place.environment} did not stop: ${stopped.error.message}`,
			),
		);
	}
	const started = await options.start(place, record.epoch, context);
	if (!started.ok) return started;
	const home = started.value;
	const ready = await home.ready;
	if (!ready.ok) return err(new MoveError("resume", `the home did not answer: ${ready.error.message}`));
	// A sealed home reopens only at the epoch it sealed at. Named by the lease at a later one, it resumes with the
	// lease's seal, which vouches for the store it holds.
	let reopen = false;
	if (ready.value.state === "sealed") {
		const status = await home.status(context);
		if (!status.ok) return err(new MoveError("resume", `the home did not say its epoch: ${status.error.message}`));
		reopen = status.value.epoch === record.epoch;
	}
	const resumed = reopen
		? await home.reopen(record.epoch, context)
		: await home.resume(
				{
					epoch: record.epoch,
					...(record.seal === undefined ? {} : { seal: record.seal }),
					...(record.move === undefined ? {} : { move: { id: record.move, notice: options.notice } }),
				},
				context,
			);
	if (!resumed.ok) return err(new MoveError("resume", `the home did not run again: ${resumed.error.message}`));
	return ok({ lease: record, home });
}
