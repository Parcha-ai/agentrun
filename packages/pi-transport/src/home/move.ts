import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box } from "../box/box.ts";
import { finish } from "../box/files.ts";
import { type Checkpoint, type CheckpointVault, restoreNotice } from "./checkpoint.ts";
import { replayCommits } from "./commit-log.ts";
import type { DrainOptions } from "./gate.ts";
import type { CallRecord, HomeHandle } from "./host.ts";
import type { Holder, LeaseRecord, Ownership } from "./ownership.ts";
import type { MoveFacts, MoveWhere } from "./run.ts";
import { type StopRunner, stopRunner } from "./stop.ts";
import { type Seal, sealStore, verifyStore } from "./store.ts";
import { manifestOf, moveFile, moveWorkspace, type WorkspaceOptions } from "./workspace.ts";

/** One place a session's home can be: an environment, its box, and where the store and the workspace are in it. */
export type Place = {
	readonly environment: string;
	readonly provider: string;
	readonly box: Box;
	/** The store's file in the box. Outside the workspace: the workspace moves on its own. */
	readonly store: string;
	readonly workspace: string;
	/**
	 * How a recording names the box: a label the host gives (`box-1`), never the provider's id. A move's durable record
	 * names its places by it. Default: the box's id, for a host that records nothing.
	 */
	readonly label?: string;
};

/** A place as a move's record names it. */
export function whereOf(place: Place): MoveWhere {
	return { environment: place.environment, provider: place.provider, box: place.label ?? place.box.id };
}

/** How a host starts the runner at a place and holds it, at the given epoch. */
export type StartRunner = (place: Place, epoch: number, context: Context) => Promise<Result<HomeHandle, MoveError>>;

/** The steps of a move, in order. */
export type MoveStep = "prepare" | "drain" | "seal" | "ship" | "take" | "resume" | "retire";

/**
 * Why a move did not happen. `no_runtime`: the target's box has no Node, or one below 22.19. `prepare`: the target could
 * not be made ready. Nothing changed after either. `drain`: the session did
 * not come to rest in time (`holdouts` names what ran on); it works on where it was. `seal`, `ship`: the source was
 * told to run again, and the message says whether it did. `target`: the target's runner went away before the take; the
 * source was told to run again. `lost`: another host took the session first (a move's take, or a recovery's); `lease`
 * says where the session is now, when it could be read, and this host does nothing more with it.
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
	/** For `lost`: the lease the other host wrote, where the session is now, when it could be read. */
	public lease: LeaseRecord | undefined;

	constructor(code: MoveErrorCode, message: string, holdouts: MoveError["holdouts"] = [], lease?: LeaseRecord) {
		super(message);
		this.name = "MoveError";
		this.code = code;
		this.holdouts = holdouts;
		this.lease = lease;
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
	/**
	 * The session's environment for the target's app, in its resume order (`ResumeOrder.env`): a box inherits none of
	 * the host's, so a move without it opens the session with an empty one.
	 */
	readonly env?: Readonly<Record<string, string>>;
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
 *
 * A place the session left (retired at an earlier epoch) takes it back: its workspace, the copy the session left
 * behind, is emptied before the ship, and the shipped store comes with its seal like any other.
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
	/**
	 * Make the source run again after a failure before the take, and say whether it does. A source that sealed opens its
	 * store again; one whose seal failed after it closed the store holds it unsealed, and resumes at the same epoch.
	 */
	const rollBack = async (): Promise<string> => {
		const status = await from.home.status(cleanup);
		if (!status.ok)
			return `the source did not say its state (${status.error.message}); a host recovers it from the lease`;
		if (status.value.state === "open") return "the source runs on";
		const back =
			status.value.state === "closed"
				? await from.home.resume({ epoch, ...(options.env === undefined ? {} : { env: options.env }) }, cleanup)
				: await from.home.reopen(epoch, cleanup);
		return back.ok
			? "the source runs again"
			: `the source did not run again (${back.error.message}); a host recovers it from the lease`;
	};

	await step("prepare");
	const prepared = await start(to, epoch, context);
	if (!prepared.ok) return err(prepared.error);
	const target = prepared.value;
	const ready = await target.ready;
	if (!ready.ok) return giveUp(target, new MoveError("prepare", `the target did not answer: ${ready.error.message}`));
	// A place the session left takes it back at a later epoch: its note refuses only orders at its epoch or before.
	const returning = ready.value.state === "retired";
	if (returning) {
		const status = await target.status(context);
		if (!status.ok) {
			return giveUp(target, new MoveError("prepare", `the target did not say its epoch: ${status.error.message}`));
		}
		// Only this session's own note: the old workspace the ship empties must be the copy this session left.
		if (status.value.session !== session) {
			const whose = status.value.session === undefined ? "names no session" : `is for ${status.value.session}`;
			return giveUp(
				target,
				new MoveError(
					"prepare",
					`the target retired, and its note ${whose}, not ${session}: it takes nothing back`,
				),
			);
		}
		if (status.value.epoch !== null && status.value.epoch > epoch) {
			return giveUp(
				target,
				new MoveError(
					"prepare",
					`the target retired at epoch ${status.value.epoch}; this move would bring the session back at ${epoch + 1}`,
				),
			);
		}
	} else if (ready.value.state !== "closed") {
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
		const back = await rollBack();
		return giveUp(
			target,
			new MoveError("seal", `the source could not seal its store: ${sealed.error.message}; ${back}`),
		);
	}
	const seal: Seal = sealed.value;

	await step("ship");
	const shipStarted = performance.now();
	let shipped: Result<{ bytes: number }, Error> = err(new Error("not tried"));
	for (let attempt = 0; attempt < 2 && !shipped.ok; attempt += 1)
		shipped = await ship(from.place, to, seal, returning, options, context);
	if (!shipped.ok) {
		const back = await rollBack();
		return giveUp(
			target,
			new MoveError("ship", `the store and workspace did not move: ${shipped.error.message}; ${back}`),
		);
	}
	const shipMs = Math.round(performance.now() - shipStarted);

	await step("take");
	const takeStarted = performance.now();
	// The point of no return: only with a target that still answers.
	const alive = await target.status(context);
	if (!alive.ok) {
		const back = await rollBack();
		return giveUp(
			target,
			new MoveError("target", `the target went away before the take: ${alive.error.message}; ${back}`),
		);
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
				return giveUp(
					target,
					new MoveError(
						"lost",
						`another host took the session first: ${taken.error.message}`,
						[],
						now.ok ? now.value : undefined,
					),
				);
			}
			if (now.ok && now.value?.epoch === epoch) {
				const back = await rollBack();
				return giveUp(target, new MoveError("take", `the lease was not written: ${taken.error.message}; ${back}`));
			}
			// Neither written for sure nor not: the source stays sealed and a host recovers the session from the lease.
			return giveUp(target, new MoveError("take", `the lease cannot be read back: ${taken.error.message}`));
		}
	}
	const next = epoch + 1;
	const takeMs = Math.round(performance.now() - takeStarted);
	const bytes = seal.bytes + (shipped.ok ? shipped.value.bytes : 0);

	await step("resume");
	target.setEpoch(next);
	const record: MoveFacts = {
		from: whereOf(from.place),
		to: whereOf(to),
		drainMs,
		shipMs,
		takeMs,
		bytes,
		stopped: [],
		seal,
	};
	const resumed = await target.resume(
		{
			epoch: next,
			seal,
			move: { id, notice: options.notice, kind: "move", head: seal.head, record },
			...(options.env === undefined ? {} : { env: options.env }),
		},
		context,
	);
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
		bytes,
		retired: retired.ok,
		home: target,
	});
}

/** Directories whose contents no move empties, whatever a place says its workspace is. */
const NEVER_EMPTIED: ReadonlySet<string> = new Set([
	"/",
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/home",
	"/lib",
	"/lib64",
	"/media",
	"/mnt",
	"/opt",
	"/proc",
	"/root",
	"/run",
	"/sbin",
	"/srv",
	"/sys",
	"/tmp",
	"/usr",
	"/var",
]);

/**
 * Why a place's workspace may not be emptied for a session that comes back, or `undefined` when it may: it must be an
 * absolute path in normal form, none of the system's own directories, and hold neither the store nor be it. The box
 * itself refuses its home directory, one above it, and a workspace that is a link (`EMPTY_WORKSPACE_SH`).
 */
export function workspaceNotEmptiable(place: Pick<Place, "workspace" | "store">): string | undefined {
	const { workspace, store } = place;
	if (workspace === "") return "the workspace is an empty path";
	if (!posix.isAbsolute(workspace)) return `the workspace ${workspace} is not an absolute path`;
	if (posix.normalize(workspace) !== workspace || (workspace !== "/" && workspace.endsWith("/"))) {
		return `the workspace ${workspace} is not a path in normal form`;
	}
	if (NEVER_EMPTIED.has(workspace)) return `the workspace ${workspace} is a directory of the system`;
	if (store === workspace || store.startsWith(`${workspace}/`)) return `the workspace ${workspace} holds the store`;
	return undefined;
}

/**
 * Empties a workspace in the box and keeps the directory: its entries go, links as links, and nothing above it or
 * outside it. `$1` is the workspace, `$2` the store. Every check is on the paths as the box resolves them, so no link
 * on the way changes what is removed. Exit 9, and nothing removed, for a workspace whose path holds a link anywhere
 * (the resolved path must be the written one), that is the box's home or a directory above it, or that holds the
 * store's directory; and for a box with no home to compare with. A workspace that is not there is nothing to empty.
 */
export const EMPTY_WORKSPACE_SH = [
	'w=$1; s=$2; [ -n "$HOME" ] || exit 9',
	'[ -e "$w" ] || [ -L "$w" ] || exit 0',
	'p=$(cd -P -- "$w" 2>/dev/null && pwd -P) || exit 9',
	'[ "$p" = "$w" ] || exit 9',
	'h=$(cd -P -- "$HOME" 2>/dev/null && pwd -P) || h=$HOME',
	'case "$h/" in "$w"/*) exit 9;; esac',
	'd=$(cd -P -- "$(dirname -- "$s")" 2>/dev/null && pwd -P) && case "$d/" in "$w"/*) exit 9;; esac',
	'find "$w" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
].join("\n");

/**
 * The store, then the workspace, from one place to the other, each checked on the target. A place the session comes
 * back to has its old workspace emptied first, before anything lands: the copy it holds is the one the session left,
 * not the one it brings. Only the workspace's entries go, and only a workspace that `workspaceNotEmptiable` and the
 * box both allow.
 */
async function ship(
	from: Place,
	to: Place,
	seal: Seal,
	returning: boolean,
	options: MoveOptions,
	context: Context,
): Promise<Result<{ bytes: number }, Error>> {
	if (returning) {
		const refused = workspaceNotEmptiable(to);
		if (refused !== undefined) return err(new Error(`the old workspace may not be emptied: ${refused}`));
		const started = await to.box.exec(
			["sh", "-c", EMPTY_WORKSPACE_SH, "sh", to.workspace, to.store],
			undefined,
			context,
		);
		if (!started.ok) return err(new Error(`could not empty the old workspace: ${started.error.message}`));
		const emptied = await finish(started.value);
		if (!emptied.ok) return err(new Error(`could not empty the old workspace: ${emptied.error.message}`));
		if (emptied.value.exitCode === 9) {
			return err(
				new Error(
					`the old workspace may not be emptied: ${to.workspace} has a link in its path, is the box's home or above it, or holds the store`,
				),
			);
		}
		if (emptied.value.exitCode !== 0) {
			return err(new Error(`could not empty the old workspace: exit ${emptied.value.exitCode}`));
		}
	}
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
	/**
	 * With no checkpoint that checks out, restore from the host's log alone: an empty store with every shipped commit from
	 * the first replayed into it, an empty workspace, and a notice that says so. Needs a log whole from commit 1; any other
	 * log is `no_checkpoint`. Default false: a host that needs the files keeps the error.
	 */
	readonly restoreFromLog?: boolean;
	readonly replace?: (place: Place, context: Context) => Promise<Result<Place, MoveError>>;
	/** Who this host is, for the lease it takes when it restores. Default `host`. */
	readonly host?: string;
	/** The tool calls the host saw begin, from the dead home's handle: the restored session is told of those since the checkpoint. */
	readonly calls?: readonly CallRecord[];
	/** The text of the notice a restored session gets. Default `restoreNotice`. */
	readonly noticeOfRestore?: (
		checkpoint: Checkpoint | undefined,
		calls: readonly CallRecord[],
		replayed?: { readonly from: number; readonly to: number; readonly count: number },
	) => string;
	/** The files of a restore are copied with these limits. */
	readonly workspace?: WorkspaceOptions & { readonly maxBytes?: number };
	/** The session's environment for the runner it starts, in its resume order (`ResumeOrder.env`). */
	readonly env?: Readonly<Record<string, string>>;
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
	/** Only a checkpoint whose store ends at or before this head: the one a restore at that head started from. */
	upToHead?: number,
): Promise<Checkpoint | undefined> {
	const latest = await vault.latest(session, context);
	if (!latest.ok || latest.value === undefined) return undefined;
	for (let n = latest.value.n; n >= 1; n -= 1) {
		const got = await vault.get(session, n, context);
		const checkpoint = got.ok ? got.value : undefined;
		if (checkpoint === undefined) continue;
		if (upToHead !== undefined && checkpoint.seal.head > upToHead) continue;
		if (!(await verifyStore(checkpoint.storeFile, checkpoint.seal, context)).ok) continue;
		const tree = await manifestOf(vault.box, checkpoint.filesRoot, undefined, context);
		if (!tree.ok) continue;
		const mine = (
			entries: readonly {
				path: string;
				kind: string;
				bytes: number;
				mode?: number;
				target?: string;
				sha256?: string;
			}[],
		) =>
			JSON.stringify(
				entries.map((e) => [e.path, e.kind, e.bytes, e.mode ?? null, e.target ?? null, e.sha256 ?? null]),
			);
		if (mine(tree.value.entries) === mine(checkpoint.manifest.entries)) return checkpoint;
	}
	return undefined;
}

/**
 * A store made of the host's log alone: an empty store with every commit from the first replayed into it, sealed. `undefined`
 * unless the log starts at commit 1 and replays whole.
 */
async function storeFromLog(vault: CheckpointVault, session: string, context: Context): Promise<Replayed | undefined> {
	const log = await vault.readLog(session, 1, context);
	// A log with a hole holds commits that cannot be replayed: restoring its prefix would drop them and let what they
	// admitted run again, so it is not a log to restore from.
	if (!log.ok || log.value.entries.length === 0 || log.value.gap) return undefined;
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-log-restore-"));
	const file = join(directory, "store.db");
	try {
		const applied = await replayCommits(file, 1, log.value.entries, context);
		if (!applied.ok) throw applied.error;
		const seal = await sealStore(file, context);
		if (!seal.ok) throw seal.error;
		return { file, seal: seal.value, from: 1, to: applied.value.to, count: applied.value.count };
	} catch {
		rmSync(directory, { recursive: true, force: true });
		return undefined;
	}
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
	Result<
		{
			readonly lease: LeaseRecord;
			readonly home: HomeHandle;
			readonly restored?: Checkpoint;
			readonly replayed?: { readonly from: number; readonly to: number; readonly count: number };
		},
		MoveError
	>
> {
	const { session, vault } = options;
	const checkpoint = await usableCheckpoint(vault, session, context);
	if (checkpoint === undefined) {
		const none = new MoveError("no_checkpoint", `the box of ${session} is gone and no checkpoint of it checks out`);
		if (options.restoreFromLog !== true) return err(none);
		// No checkpoint: the host's log is the session, if it holds every commit from the first.
		const whole = await storeFromLog(vault, session, context);
		if (whole === undefined) return err(none);
		try {
			const made = await options.replace(gone, context);
			if (!made.ok) return made;
			return await restoreInto(options, record, undefined, whole, made.value, gone, context);
		} finally {
			rmSync(dirname(whole.file), { recursive: true, force: true });
		}
	}
	// The commits the runner shipped after the checkpoint are applied to a copy of its store on the host, through the
	// store's own Storage and before any Harness opens it: the session then has the admissions it made since.
	const replay = await replayedStore(vault, session, checkpoint, context);
	try {
		const made = await options.replace(gone, context);
		if (!made.ok) return made;
		return await restoreInto(options, record, checkpoint, replay, made.value, gone, context);
	} finally {
		if (replay !== undefined) rmSync(replay.file, { force: true });
	}
}

type Replayed = {
	readonly file: string;
	readonly seal: Seal;
	readonly from: number;
	readonly to: number;
	readonly count: number;
};

/** A copy of the checkpoint's store with the shipped commits since applied, or `undefined` when there are none to apply. */
async function replayedStore(
	vault: CheckpointVault,
	session: string,
	checkpoint: Checkpoint,
	context: Context,
): Promise<Replayed | undefined> {
	const log = await vault.readLog(session, checkpoint.seal.head, context);
	if (!log.ok || log.value.entries.length === 0) return undefined;
	const file = `${checkpoint.storeFile}.replay-${randomUUID()}`;
	try {
		copyFileSync(checkpoint.storeFile, file);
		const applied = await replayCommits(file, checkpoint.seal.head, log.value.entries, context);
		// An error leaves the commits before it applied: the store is a whole prefix of the session's.
		const to = applied.ok ? applied.value.to : applied.error.applied;
		if (to < checkpoint.seal.head) {
			rmSync(file, { force: true });
			return undefined;
		}
		const seal = await sealStore(file, context);
		if (!seal.ok) {
			rmSync(file, { force: true });
			return undefined;
		}
		return { file, seal: seal.value, from: checkpoint.seal.head, to, count: to - checkpoint.seal.head + 1 };
	} catch {
		rmSync(file, { force: true });
		return undefined;
	}
}

async function restoreInto(
	options: RecoverOptions & {
		readonly vault: CheckpointVault;
		readonly replace: NonNullable<RecoverOptions["replace"]>;
	},
	record: LeaseRecord,
	checkpoint: Checkpoint | undefined,
	replay: Replayed | undefined,
	place: Place,
	gone: Place,
	context: Context,
): Promise<
	Result<
		{
			readonly lease: LeaseRecord;
			readonly home: HomeHandle;
			readonly restored?: Checkpoint;
			readonly replayed?: { readonly from: number; readonly to: number; readonly count: number };
		},
		MoveError
	>
> {
	const { session, vault, ownership } = options;
	const id = `restore-${record.epoch + 1}`;
	const seal = replay?.seal ?? checkpoint?.seal;
	if (seal === undefined)
		return err(new MoveError("no_checkpoint", "there is neither a checkpoint nor a log to restore from"));
	// The commits the lost box shipped and this restore did not replay are a branch that no longer exists: the runner at
	// the new epoch commits those numbers again, so the log must not say it holds them.
	const dropped = await vault.dropLogAbove(session, seal.head - 1, context);
	if (!dropped.ok) return err(new MoveError("ship", `the host's log could not be rewound: ${dropped.error.message}`));
	const storeFile = replay?.file ?? checkpoint?.storeFile;
	if (storeFile === undefined) return err(new MoveError("no_checkpoint", "there is no store to restore"));
	const shipStarted = performance.now();
	let treeBytes = 0;
	const file = await moveFile(vault.box, storeFile, place.box, place.store, seal, undefined, context);
	if (!file.ok)
		return err(new MoveError("ship", `the restored store did not reach the new box: ${file.error.message}`));
	if (checkpoint !== undefined) {
		const tree = await moveWorkspace(
			vault.box,
			place.box,
			{ fromRoot: checkpoint.filesRoot, toRoot: place.workspace, ...options.workspace },
			context,
		);
		if (!tree.ok)
			return err(new MoveError("ship", `the checkpoint's files did not reach the new box: ${tree.error.message}`));
		treeBytes = tree.value.bytes;
	} else {
		// From the log alone no file comes back: the workspace is an empty directory.
		// The directory is made if it is not there, and must hold nothing: the notice says no file came back.
		const made = await place.box.exec(
			["sh", "-c", 'mkdir -p -- "$1" && ls -A -- "$1"', "sh", place.workspace],
			undefined,
			context,
		);
		const done = made.ok ? await finish(made.value) : made;
		if (!done.ok || done.value.exitCode !== 0) {
			return err(new MoveError("ship", `the new box has no workspace directory ${place.workspace}`));
		}
		if (new TextDecoder().decode(done.value.stdout).trim() !== "") {
			return err(
				new MoveError(
					"ship",
					`the new box's workspace ${place.workspace} is not empty: a restore from the log needs it empty`,
				),
			);
		}
	}
	const shipMs = Math.round(performance.now() - shipStarted);
	const host = options.host ?? "host";
	const holder = { environment: place.environment, provider: place.provider, box: place.box.id, host };
	const takeStarted = performance.now();
	const taken = await ownership.take(session, holder, record.epoch, { move: id, seal }, context);
	if (!taken.ok) {
		const code = taken.error.code === "lost" ? "lost" : "take";
		return err(new MoveError(code, `the lease was not taken: ${taken.error.message}`));
	}
	const takeMs = Math.round(performance.now() - takeStarted);
	const epoch = taken.value.epoch;
	const started = await options.start(place, epoch, context);
	if (!started.ok) return started;
	const home = started.value;
	const ready = await home.ready;
	if (!ready.ok) return err(new MoveError("resume", `the restored home did not answer: ${ready.error.message}`));
	const notice = (options.noticeOfRestore ?? restoreNotice)(checkpoint, options.calls ?? [], replay);
	const resumed = await home.resume(
		{
			epoch,
			seal,
			move: {
				id,
				notice,
				kind: "restore",
				head: seal.head,
				...(replay === undefined ? {} : { replayed: { from: replay.from, to: replay.to } }),
				// The restore's durable record: from the lost place to this one, and the checkpoint it came from, if any.
				record: {
					from: whereOf(gone),
					to: whereOf(place),
					drainMs: null,
					shipMs,
					takeMs,
					bytes: seal.bytes + treeBytes,
					stopped: [],
					...(checkpoint === undefined
						? {}
						: { checkpoint: { ...checkpoint.seal, at: new Date(checkpoint.at).toISOString() } }),
				},
			},
			...(options.env === undefined ? {} : { env: options.env }),
		},
		context,
	);
	if (!resumed.ok) return err(new MoveError("resume", `the restored home did not run: ${resumed.error.message}`));
	return ok({
		lease: taken.value,
		home,
		...(checkpoint === undefined ? {} : { restored: checkpoint }),
		...(replay === undefined ? {} : { replayed: { from: replay.from, to: replay.to, count: replay.count } }),
	});
}

/**
 * What a host that starts again does: read the lease, stop a runner that still runs where it says, start one there,
 * and make that home run. A target that took the session and never resumed is told to resume with the lease's seal and
 * move, and its store says which workspace its conversations pointed at. Safe to repeat.
 *
 * A home sealed at the lease's epoch may be the source of a move that is about to take the next epoch for another
 * place. The lease decides, never a second read: recovery takes that next epoch for this same place, with the home's
 * own seal, and resumes the home there. When the move took it first, the take is `lost`: recovery opens nothing and
 * says where the lease puts the session. So recovering a sealed home moves the epoch.
 */
export async function recoverHome(
	options: RecoverOptions,
	context: Context,
): Promise<
	Result<
		{
			readonly lease: LeaseRecord;
			readonly home: HomeHandle;
			readonly restored?: Checkpoint;
			readonly replayed?: { readonly from: number; readonly to: number; readonly count: number };
		},
		MoveError
	>
> {
	const found = await options.ownership.current(options.session, context);
	if (!found.ok) return err(new MoveError("take", `the lease cannot be read: ${found.error.message}`));
	const record = found.value;
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
	let lease = record;
	if (ready.value.state === "sealed") {
		const status = await home.status(context);
		if (!status.ok) return err(new MoveError("resume", `the home did not say its epoch: ${status.error.message}`));
		// Sealed at the lease's epoch: take the next one for this place, with the home's own seal, before it runs again.
		// Named by the lease at a later epoch, it resumes with the lease's seal, which vouches for the store it holds.
		if (status.value.epoch === record.epoch) {
			const sealed = status.value.sealed;
			if (sealed === undefined) {
				home.close("the home did not say its seal");
				return err(new MoveError("resume", "the home sealed its store and did not say its seal"));
			}
			const taken = await options.ownership.take(
				options.session,
				record.holder,
				record.epoch,
				{ seal: sealed },
				context,
			);
			if (!taken.ok) {
				home.close("the session is not this place's");
				if (taken.error.code !== "lost") {
					return err(new MoveError("take", `the lease could not be taken forward: ${taken.error.message}`));
				}
				const now = await options.ownership.current(options.session, withoutAbortSignal(context));
				const where = now.ok ? now.value : undefined;
				const named =
					where === undefined ? "" : `: the lease names ${where.holder.environment} at epoch ${where.epoch}`;
				return err(new MoveError("lost", `another host took the session first${named}`, [], where));
			}
			lease = taken.value;
			home.setEpoch(lease.epoch);
		}
	}
	// A restore the host did not finish (the start or the readiness failed after the take) is finished here: the model is
	// still told it was restored, from the checkpoint the lease's seal came from.
	let notice = options.notice;
	if (lease.move?.startsWith("restore-") && lease.seal !== undefined && options.vault !== undefined) {
		// Verified again, not only read: a checkpoint whose files failed the check was not what the restore used.
		const from = await usableCheckpoint(options.vault, options.session, context, lease.seal.head);
		const made = (options.noticeOfRestore ?? restoreNotice)(
			from,
			options.calls ?? [],
			from === undefined && lease.seal.head > 1
				? { from: 1, to: lease.seal.head - 1, count: lease.seal.head - 1 }
				: undefined,
		);
		if (from !== undefined || options.restoreFromLog === true) notice = made;
	}
	const resumed = await home.resume(
		{
			epoch: lease.epoch,
			...(lease.seal === undefined ? {} : { seal: lease.seal }),
			...(lease.move === undefined
				? {}
				: {
						move: {
							id: lease.move,
							notice,
							kind: lease.move.startsWith("restore-") ? "restore" : "move",
							...(lease.seal === undefined ? {} : { head: lease.seal.head }),
							// A target that took the session and never opened writes the record from here: the host knows only
							// where the lease puts it. A target that wrote it keeps its own.
							record: {
								from: null,
								to: whereOf(place),
								drainMs: null,
								shipMs: null,
								takeMs: null,
								bytes: null,
								stopped: [],
							},
						},
					}),
			...(options.env === undefined ? {} : { env: options.env }),
		},
		context,
	);
	if (!resumed.ok) return err(new MoveError("resume", `the home did not run again: ${resumed.error.message}`));
	return ok({ lease, home });
}
