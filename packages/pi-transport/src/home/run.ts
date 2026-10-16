import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	configure,
	defineDoc,
	defineDocFamily,
	type Extension,
	Harness,
	type HarnessOptions,
	type JsonObject,
	type Storage,
} from "@earendil-works/pi-durable";
import { err, ok, type Result, toError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type App, type AppContext, type AppOptions, appOptions } from "./app.ts";
import { type CallEvent, callsExtension } from "./calls.ts";
import { createGate, type DrainError, type Drained, type DrainOptions, type Gate } from "./gate.ts";
import { holdStore, type StoreHold } from "./lock.ts";
import { checkpointStore, type Seal, sealStore, verifyStore } from "./store.ts";

/** The entry kind of the notice a session gets when its home moved. */
export const MOVE_ENTRY = "transport.move";
const CONVERSATION_PAGE = 200;

/** The workspace root the session's conversations point at: where the store last ran. */
const HomeDoc = defineDoc<{ root?: string }>({
	kind: "transport.home",
	version: 1,
	scope: "session",
	initial: () => ({}),
});

/** Where a session was or is, as a recording names it: its box by a label the host gives, never the provider's id. */
export type MoveWhere = { readonly environment: string; readonly provider: string; readonly box: string };

/** The part of a move's record only the host knows, carried in `ResumeOrder.move.record`. Times are on the host's clock. */
export type MoveFacts = {
	/** Where the session was; `null` when the host no longer knows (a target it resumes from the lease alone). */
	readonly from: MoveWhere | null;
	readonly to: MoveWhere;
	readonly drainMs: number | null;
	readonly shipMs: number | null;
	/** From the take's start to the lease written. */
	readonly takeMs: number | null;
	readonly bytes: number | null;
	/** The attempts of this hop that a kill or a failure stopped before this one landed. */
	readonly stopped: readonly {
		readonly code: string;
		readonly step: string;
		readonly kill?: { readonly who: "host" | "source" | "target"; readonly step: string };
	}[];
	/** A move: the sealed store it shipped. */
	readonly seal?: Seal;
	/** A restore from a checkpoint: the checkpoint's store, and when it was taken (ISO). */
	readonly checkpoint?: Seal & { readonly at: string };
	/** The decision that asked for the move. */
	readonly placement?: { readonly id: string; readonly by: string };
};

/**
 * A move's durable record (RECORDING.md 3.2): the document `transport.moves`, keyed by the move id, written once by the
 * target in the first commit it makes when it opens the moved store. `head` is the sequence that commit takes, after any
 * replay: a move's `seal.head`, a restore's `replayed.to + 1` or its checkpoint's head.
 */
export type MoveRecord = MoveFacts & {
	readonly v: 1;
	readonly id: string;
	readonly kind: "move" | "restore";
	readonly epoch: number;
	readonly head: number;
	readonly replayed?: { readonly from: number; readonly to: number };
};

/** The moves of the session, one document per move id. */
export const MovesDoc = defineDocFamily<JsonObject, null>({
	kind: "transport.moves",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({}),
});

/** The record an order's move asks the target to write, or `undefined` when its host sends none or no head is known. */
function moveRecordOf(order: ResumeOrder): MoveRecord | undefined {
	const move = order.move;
	const facts = move?.record;
	const head = move?.head ?? order.seal?.head;
	if (move === undefined || facts === undefined || typeof facts !== "object" || head === undefined) return undefined;
	const { seal, checkpoint, placement, ...rest } = facts;
	return {
		v: 1,
		id: move.id,
		kind: move.kind ?? "move",
		epoch: order.epoch,
		head,
		from: rest.from,
		to: rest.to,
		drainMs: rest.drainMs,
		shipMs: rest.shipMs,
		takeMs: rest.takeMs,
		bytes: rest.bytes,
		stopped: rest.stopped,
		...(seal === undefined ? {} : { seal }),
		...(checkpoint === undefined ? {} : { checkpoint }),
		...(placement === undefined ? {} : { placement }),
		...(move.replayed === undefined ? {} : { replayed: move.replayed }),
	};
}

/**
 * Why a home refused an order. `wrong_state`: the order does not fit what the home is doing. `stale_epoch`: the
 * order is for an epoch this home has left behind. `not_verified`: a store is here that no seal vouches for.
 * `seal_mismatch`: the store here is not the one the seal names. `app`: the app did not load or build. `store`: the
 * store could not be opened, sealed or removed. `busy`: another runner at this place holds the store. `invalid`: the
 * order's arguments have the wrong shape.
 */
export type HomeErrorCode =
	| "wrong_state"
	| "stale_epoch"
	| "not_verified"
	| "seal_mismatch"
	| "app"
	| "store"
	| "busy"
	| "invalid";

/** An order a home did not carry out. Returned, never thrown. */
export class HomeError extends Error {
	public code: HomeErrorCode;

	constructor(code: HomeErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "HomeError";
		this.code = code;
	}
}

/** What a home is told when it is to run the session. */
export type ResumeOrder = {
	/** The epoch of the lease that names this home. */
	readonly epoch: number;
	/** The seal in the lease record: the store this home must open. Absent for a session that starts here. */
	readonly seal?: Seal;
	/** The move that brought the session here. The store knows where it ran before: no root travels with the order. */
	readonly move?: {
		readonly id: string;
		/** What the agent is told, once. */
		readonly notice: string;
		/** `restore`: the session continues from a checkpoint of a box that is gone; absent or `move` is a handoff. */
		readonly kind?: "move" | "restore";
		/**
		 * A restore only: the checkpoint's head (`Seal.head`, the sequence number its next commit would take). Commits
		 * of the lost box at or after it are gone and their numbers are taken again, so a recorder of moves and
		 * commits drops that branch.
		 */
		readonly head?: number;
		/**
		 * A restore only: the commits of the lost box that were shipped to the host and applied to the checkpoint's store
		 * before it opened, `from` to `to` inclusive. `head` is then `to + 1`.
		 */
		readonly replayed?: { readonly from: number; readonly to: number };
		/**
		 * What the host knows of the move, for its durable record: the target writes `transport.moves` with it in its first
		 * commit, once. Absent: no record.
		 */
		readonly record?: MoveFacts;
	};
	/**
	 * The session's environment for the app, handed to it as `AppContext.env`: over the link, never in argv, and a box
	 * inherits none of the host's. Names and values are strings.
	 */
	readonly env?: Readonly<Record<string, string>>;
};

/** `closed`: nothing is open. `open`: the session runs. `sealed`: closed and sealed, waiting for the host's word. */
export type HomeState = "closed" | "open" | "sealed" | "retired";

/** What `openHome` needs. Nothing here is a secret. */
export type HomeOptions = {
	readonly app: App;
	readonly session: string;
	/** The SQLite file of the session's store on this machine. */
	readonly store: string;
	readonly workspace: string;
	readonly where: AppContext["where"];
	/** The host's own models, or the link's proxy in a box. */
	readonly models: HarnessOptions["models"];
	/** Where the session's tools run. Default: pi's own environment in `workspace`. */
	readonly env?: HarnessOptions["env"];
	/** Told when a tool call begins and ends (name and replay flag only). */
	readonly onCall?: (event: CallEvent) => void | Promise<void>;
	/**
	 * Called with the store each time the home opens it, before pi does: the Harness runs over the storage it returns.
	 * `opened` runs with the Harness before anything commits through it; `closed` after the Harness closed. A runner
	 * ships its commits this way.
	 */
	readonly wrapStore?: (storage: Storage, context: Context) => Promise<WrappedStore>;
	/** Extensions the home installs in the app's registry, beside its gate. */
	readonly extensions?: readonly Extension[];
	/**
	 * Called each time this home takes the store into its hold, before the order runs: a runner process names itself
	 * there as the one that holds the store. A failure here fails no order.
	 */
	readonly onHold?: () => void | Promise<void>;
};

/**
 * What `wrapStore` gives the home. `opened` runs once the Harness has the store, before anything else commits through
 * it; when it fails, the order fails and `closed` runs.
 */
export type WrappedStore = {
	readonly storage: Storage;
	readonly opened?: (harness: Harness) => void | Promise<void>;
	readonly closed?: () => Promise<void>;
};

/** A copy of the store taken while the session is held, and the seal that vouches for it. */
export type CheckpointTaken = { readonly seal: Seal; readonly path: string };

/**
 * One place a session can run: its store, its workspace and the Harness over them, driven by orders. The host gives
 * the orders, in process or over the link.
 *
 * Invariants: a home opens a store only on an order, never by itself, so a home with no host does nothing. It opens
 * a store only when a seal vouches for it or it has opened that store before in the same epoch. A home that sealed
 * stays closed until it is told `reopen` or `retire`.
 */
export interface Home {
	readonly state: HomeState;
	/** The epoch of the lease this home last ran at, or `undefined` for a home that never ran. */
	readonly epoch: number | undefined;
	/** The seal of the store this home sealed and has not opened again: what a recovery's take carries forward. */
	readonly sealed: Seal | undefined;
	/** The session the note this home keeps on disk is for, when the note names one. */
	readonly noteSession: string | undefined;
	/** The open Harness: for submissions, aborts and events. `undefined` unless `open`. */
	readonly harness: Harness | undefined;
	/**
	 * Run the session here. Verifies the store against the order's seal, opens it, brings the conversations to this
	 * workspace, admits the move's notice once and resumes. Safe to repeat after a crash at any point.
	 */
	resume(order: ResumeOrder, context: Context): Promise<Result<void, HomeError>>;
	/** The root conversation, made as the app says when the session is new. */
	root(context: Context): Promise<Result<Conversation, HomeError>>;
	/** Hold new work and wait until what runs is held. On failure the gate is open again and nothing was cut. */
	drain(options: DrainOptions | undefined, context: Context): Promise<Result<Drained, DrainError | HomeError>>;
	/** Give a drain up: held work goes on. */
	abandon(): void;
	/**
	 * Hold the session (a drain) and take a consistent copy of the store beside it, at `<store>.checkpoint`. The gate stays
	 * closed afterwards, so that the caller can read the workspace at the same moment; `abandon` opens it. On failure the
	 * gate is open again.
	 */
	checkpoint(
		options: DrainOptions | undefined,
		context: Context,
	): Promise<Result<CheckpointTaken, DrainError | HomeError>>;
	/** After a drain: close the Harness and seal the store. From then on only `reopen` or `retire` is taken. */
	seal(context: Context): Promise<Result<Seal, HomeError>>;
	/** The move was abandoned and the lease still names this home at `epoch`: open the sealed store again. */
	reopen(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>>;
	/**
	 * The session lives elsewhere from `epoch` on: stop if anything runs, delete this copy, and keep a note of `epoch`
	 * beside the store, so that no order at it or before opens a store here again, in this process or a new one.
	 */
	retire(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>>;
	/** Stop without sealing, as a kill would but in order. The next `resume` at the same epoch opens the store again. */
	close(context: Context): Promise<void>;
}

/**
 * What a home remembers on disk beside its store: which epoch's store it verified here, whether it sealed it, and
 * whether it retired at that epoch, after which no order at it or before opens a store here again.
 */
type Marker = {
	readonly v: 1;
	readonly epoch: number;
	readonly seal?: Seal;
	readonly move?: string;
	readonly sealed?: Seal;
	readonly retired?: true;
	/** The session the note is for. A note written before it was kept names none. */
	readonly session?: string;
};

class SessionHome implements Home {
	readonly #options: HomeOptions;
	readonly #markerPath: string;
	#harness: Harness | undefined;
	#gate: Gate | undefined;
	#app: AppOptions | undefined;
	#wrapped: WrappedStore | undefined;
	#marker: Marker | undefined;
	#drained = false;
	/** The orders that open, close or delete, one at a time: none finds another half done. */
	#queue: Promise<unknown> = Promise.resolve();
	/** This home's hold on the store, from an order that opens it until the store is closed. */
	#hold: StoreHold | undefined;

	constructor(options: HomeOptions) {
		this.#options = options;
		this.#markerPath = `${options.store}.home.json`;
	}

	/** Read the marker an earlier process left, if any. */
	async load(): Promise<Result<void, HomeError>> {
		const marker = await this.#readMarker();
		return marker.ok ? ok(undefined) : marker;
	}

	get state(): HomeState {
		if (this.#marker?.retired === true) return "retired";
		if (this.#harness !== undefined) return "open";
		return this.#marker?.sealed === undefined ? "closed" : "sealed";
	}

	get epoch(): number | undefined {
		return this.#marker?.epoch;
	}

	get sealed(): Seal | undefined {
		return this.#marker?.sealed;
	}

	get noteSession(): string | undefined {
		return this.#marker?.session;
	}

	get harness(): Harness | undefined {
		return this.#harness;
	}

	resume(order: ResumeOrder, context: Context): Promise<Result<void, HomeError>> {
		return this.#serial(() => this.#holding(() => this.#resume(order, context)));
	}

	async #resume(order: ResumeOrder, context: Context): Promise<Result<void, HomeError>> {
		if (this.#harness !== undefined) return err(new HomeError("wrong_state", "the session already runs here"));
		const marker = await this.#readMarker();
		if (!marker.ok) return marker;
		const known = marker.value;
		if (known?.retired === true) {
			if (order.epoch <= known.epoch) {
				return err(
					new HomeError(
						"stale_epoch",
						`this home retired at epoch ${known.epoch}; the order is for ${order.epoch}`,
					),
				);
			}
			// The session left this place: it comes back only as a copy that a seal vouches for, never as a new store.
			if (order.seal === undefined) {
				return err(
					new HomeError(
						"not_verified",
						`this home retired at epoch ${known.epoch}; a resume at a later epoch needs the seal of the copy it brings`,
					),
				);
			}
		}
		if (known !== undefined && order.epoch < known.epoch) {
			return err(
				new HomeError("stale_epoch", `this home is at epoch ${known.epoch}; the order is for ${order.epoch}`),
			);
		}
		const own = known !== undefined && known.epoch === order.epoch;
		if (own && known.sealed !== undefined) {
			return err(
				new HomeError(
					"wrong_state",
					`this home sealed its store at epoch ${known.epoch}; it opens it again only on reopen`,
				),
			);
		}
		// A store this home opened before in the same epoch is its own: the open moved its head past the seal.
		if (!own) {
			const { store } = this.#options;
			if (order.seal !== undefined) {
				const verified = await verifyStore(store, order.seal, context);
				if (!verified.ok) {
					const code = verified.error.code === "mismatch" ? "seal_mismatch" : "store";
					return err(new HomeError(code, `the store here is not the sealed one: ${verified.error.message}`));
				}
			} else if (existsSync(store)) {
				return err(new HomeError("not_verified", `a store is at ${store} and the order names no seal for it`));
			}
			const written = await this.#writeMarker({
				v: 1,
				epoch: order.epoch,
				session: this.#options.session,
				...(order.seal === undefined ? {} : { seal: order.seal }),
				...(order.move === undefined ? {} : { move: order.move.id }),
			});
			if (!written.ok) return written;
		}
		return this.#open(order, context);
	}

	async root(context: Context): Promise<Result<Conversation, HomeError>> {
		if (this.#harness === undefined) return err(new HomeError("wrong_state", "the session does not run here"));
		try {
			return ok(await this.#harness.root(context, this.#app?.root));
		} catch (cause) {
			return err(new HomeError("store", `could not open the root conversation: ${toError(cause).message}`, cause));
		}
	}

	async drain(options: DrainOptions | undefined, context: Context): Promise<Result<Drained, DrainError | HomeError>> {
		if (this.#gate === undefined) return err(new HomeError("wrong_state", "the session does not run here"));
		const drained = await this.#gate.drain(options, context);
		this.#drained = drained.ok;
		return drained;
	}

	abandon(): void {
		this.#drained = false;
		this.#gate?.open();
	}

	async checkpoint(
		options: DrainOptions | undefined,
		context: Context,
	): Promise<Result<CheckpointTaken, DrainError | HomeError>> {
		const drained = await this.drain(options, context);
		if (!drained.ok) return drained;
		const path = `${this.#options.store}.checkpoint`;
		await rm(path, { force: true });
		const copied = await checkpointStore(this.#options.store, path, context);
		if (!copied.ok) {
			this.abandon();
			return err(new HomeError("store", `could not take the checkpoint: ${copied.error.message}`, copied.error));
		}
		return ok({ seal: copied.value, path });
	}

	seal(context: Context): Promise<Result<Seal, HomeError>> {
		return this.#serial(() => this.#seal(context));
	}

	async #seal(context: Context): Promise<Result<Seal, HomeError>> {
		const harness = this.#harness;
		const marker = this.#marker;
		if (harness === undefined || marker === undefined) {
			return err(new HomeError("wrong_state", "the session does not run here"));
		}
		if (!this.#drained) return err(new HomeError("wrong_state", "a seal follows a drain that completed"));
		// Closing is not cut by an abort: an abort stops the seal, and the store stays whole and closed for a resume.
		await this.#close(withoutAbortSignal(context));
		const sealed = await sealStore(this.#options.store, context);
		// The store is closed and whole either way. Without a seal the host tells this home to resume.
		if (!sealed.ok) return err(new HomeError("store", `could not seal the store: ${sealed.error.message}`));
		const written = await this.#writeMarker({ ...marker, sealed: sealed.value });
		if (!written.ok) return written;
		return sealed;
	}

	reopen(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>> {
		return this.#serial(() => this.#holding(() => this.#reopen(order, context)));
	}

	async #reopen(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>> {
		if (this.#harness !== undefined) return err(new HomeError("wrong_state", "the session already runs here"));
		const marker = await this.#readMarker();
		if (!marker.ok) return marker;
		const known = marker.value;
		if (known?.sealed === undefined) return err(new HomeError("wrong_state", "this home holds no sealed store"));
		if (order.epoch !== known.epoch) {
			return err(
				new HomeError("stale_epoch", `this home sealed at epoch ${known.epoch}; the order is for ${order.epoch}`),
			);
		}
		const { sealed: _sealed, ...rest } = known;
		const written = await this.#writeMarker(rest);
		if (!written.ok) return written;
		return this.#open({ epoch: order.epoch }, context);
	}

	retire(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>> {
		return this.#serial(() => this.#retire(order, context));
	}

	async #retire(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>> {
		const marker = await this.#readMarker();
		if (!marker.ok) return marker;
		const known = marker.value;
		// The same retire again finishes a deletion that a stop or a failed delete left undone; it opens nothing.
		const again = known?.retired === true && order.epoch === known.epoch;
		if (!again && known !== undefined && order.epoch <= known.epoch) {
			return err(
				new HomeError(
					"stale_epoch",
					`this home is at epoch ${known.epoch}; only a later epoch retires it, and the order is for ${order.epoch}`,
				),
			);
		}
		// The lease names another home. Whatever still runs here runs for nobody.
		await this.#close(context);
		// The note goes first: a home that dies while it deletes still refuses every order at this epoch or before.
		const noted: Result<void, HomeError> = again
			? ok(undefined)
			: await this.#writeMarker({ v: 1, epoch: order.epoch, retired: true, session: this.#options.session });
		if (!noted.ok) return noted;
		const { store } = this.#options;
		try {
			for (const path of [store, `${store}-wal`, `${store}-shm`, `${store}.lock`]) await rm(path, { force: true });
		} catch (cause) {
			return err(new HomeError("store", `could not delete this home's copy: ${toError(cause).message}`, cause));
		}
		return ok(undefined);
	}

	close(context: Context): Promise<void> {
		return this.#serial(() => this.#close(context));
	}

	/** An order runs once every order given before it has ended, whatever they returned. */
	#serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(work, work);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #close(context: Context): Promise<void> {
		const harness = this.#harness;
		const wrapped = this.#wrapped;
		this.#harness = undefined;
		this.#gate = undefined;
		this.#wrapped = undefined;
		this.#drained = false;
		try {
			await harness?.close(context);
		} finally {
			// The store is let go whatever the recorder's stop does.
			try {
				await wrapped?.closed?.();
			} finally {
				this.#letGo();
			}
		}
	}

	/**
	 * Runs an order that opens the store while this home holds it alone. When another runner at this place has it, the
	 * order is `busy` and nothing here changes. An order that leaves no Harness open lets the store go again.
	 */
	async #holding(work: () => Promise<Result<void, HomeError>>): Promise<Result<void, HomeError>> {
		if (this.#hold === undefined && this.#harness === undefined) {
			const { store } = this.#options;
			try {
				await mkdir(dirname(store), { recursive: true });
				this.#hold = holdStore(store);
			} catch (cause) {
				return err(
					new HomeError("store", `could not hold the store at ${store}: ${toError(cause).message}`, cause),
				);
			}
			if (this.#hold === undefined) return err(new HomeError("busy", `another runner holds the store at ${store}`));
			try {
				await this.#options.onHold?.();
			} catch {
				// Naming the holder serves a later stop; the order goes on without it.
			}
		}
		const done = await work();
		if (this.#harness === undefined) this.#letGo();
		return done;
	}

	#letGo(): void {
		this.#hold?.release();
		this.#hold = undefined;
	}

	/** Open the store, bring the conversations here, admit the notice, resume. Every step is safe to repeat. */
	async #open(order: ResumeOrder, context: Context): Promise<Result<void, HomeError>> {
		const { app, session, store, workspace, where, models } = this.#options;
		const orderEnv = order.env ?? {};
		if (
			typeof orderEnv !== "object" ||
			orderEnv === null ||
			Object.values(orderEnv).some((value) => typeof value !== "string")
		) {
			return err(new HomeError("invalid", "the resume order's env must map names to strings"));
		}
		const built = await appOptions(app, {
			session,
			workspace,
			store,
			models,
			where,
			root: dirname(workspace),
			epoch: order.epoch,
			env: { ...orderEnv },
		});
		if (!built.ok) return err(new HomeError("app", built.error.message, built.error));
		const { root: _root, onOpen, onResumed, registry, ...rest } = built.value;
		const gate = createGate();
		registry.install(gate.extension);
		const { onCall } = this.#options;
		if (onCall !== undefined) registry.install(callsExtension(registry, onCall));
		for (const extension of this.#options.extensions ?? []) registry.install(extension);
		const env: HarnessOptions["env"] =
			this.#options.env ?? (async (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }));
		let harness: Harness;
		let storage: Storage | undefined;
		let wrapped: WrappedStore | undefined;
		try {
			await mkdir(dirname(store), { recursive: true });
			storage = await openNodeSqliteStorage(store);
			wrapped = await this.#options.wrapStore?.(storage, context);
			harness = await Harness.open(wrapped?.storage ?? storage, { ...rest, registry, models, env }, context);
		} catch (cause) {
			await wrapped?.closed?.().catch(() => {});
			// No Harness took the storage: it is this home's to close.
			await storage?.close(withoutAbortSignal(context)).catch(() => {});
			return err(new HomeError("store", `could not open the store: ${toError(cause).message}`, cause));
		}
		try {
			// Before anything commits through it: the recorder, bringing the session here, the app's own opening, the
			// move's notice.
			await wrapped?.opened?.(harness);
			gate.attach(harness);
			await bringHere(harness, workspace, moveRecordOf(order), context);
			await onOpen?.(harness, context);
			const { move } = order;
			if (move !== undefined) {
				// pi admits a request id once for each conversation, so a second open adds no second notice.
				const root = await harness.root(context, built.value.root);
				await root.submit(
					{
						type: "write",
						requestId: `${MOVE_ENTRY}:${move.id}`,
						entry: {
							kind: MOVE_ENTRY,
							model: [{ role: "user", content: move.notice, timestamp: Date.now() }],
							data: { move: move.id },
						},
					},
					context,
				);
			}
		} catch (cause) {
			await harness.close(context).catch(() => {});
			await wrapped?.closed?.().catch(() => {});
			return err(new HomeError("store", `could not prepare the session: ${toError(cause).message}`, cause));
		}
		harness.resume();
		this.#harness = harness;
		this.#gate = gate;
		this.#wrapped = wrapped;
		this.#app = built.value;
		if (onResumed !== undefined) {
			// Not the order's to wait for: the app's own work goes on after the order answered.
			const resumedContext = withoutAbortSignal(context);
			void Promise.resolve()
				.then(() => onResumed(harness, resumedContext))
				.catch((cause) => {
					process.stderr.write(`pi-transport: the app's onResumed failed: ${toError(cause).message}\n`);
				});
		}
		return ok(undefined);
	}

	async #readMarker(): Promise<Result<Marker | undefined, HomeError>> {
		try {
			this.#marker = JSON.parse(await readFile(this.#markerPath, "utf8")) as Marker;
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
				return err(new HomeError("store", `could not read this home's marker: ${toError(cause).message}`, cause));
			}
			this.#marker = undefined;
		}
		return ok(this.#marker);
	}

	/**
	 * Written whole beside the store and renamed into place, so a reader finds the old marker or the new one. The note
	 * never travels with the store: a move ships the store and the workspace only, and a target writes its own note on
	 * its first resume.
	 */
	async #writeMarker(marker: Marker): Promise<Result<void, HomeError>> {
		const temp = `${this.#markerPath}.tmp`;
		try {
			await mkdir(dirname(this.#markerPath), { recursive: true });
			const file = await open(temp, "w");
			try {
				await file.writeFile(JSON.stringify(marker));
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temp, this.#markerPath);
			// The rename changes the directory: synced too, so a marker that was written stays written after a power cut.
			const folder = await open(dirname(this.#markerPath), "r");
			try {
				await folder.sync();
			} finally {
				await folder.close();
			}
		} catch (cause) {
			return err(new HomeError("store", `could not write this home's marker: ${toError(cause).message}`, cause));
		}
		this.#marker = marker;
		return ok(undefined);
	}
}

/**
 * One commit that points every conversation whose directory lies under the root the store last ran in at the same
 * place under `to`, and records `to` as the root. Nothing changes when the store last ran here, so a second call
 * after a crash is a no-op, also when `to` lies under the old root.
 */
async function bringHere(
	harness: Harness,
	to: string,
	record: MoveRecord | undefined,
	context: Context,
): Promise<void> {
	await harness.commit(async (tx) => {
		const home = await tx.doc(HomeDoc);
		const from = home.root;
		// Every read comes before the first write: a transaction refuses a table read after one.
		const changes: [ConversationId, string][] = [];
		if (from !== undefined && from !== to) {
			for (let cursor: Parameters<typeof tx.scanConversations>[2]; ; ) {
				const page = await tx.scanConversations({}, CONVERSATION_PAGE, cursor);
				for (const conversation of page.items) {
					const cwd = (await tx.doc(AgentDoc, conversation.id)).cwd;
					if (cwd === from) changes.push([conversation.id, to]);
					else if (cwd?.startsWith(`${from}/`)) changes.push([conversation.id, `${to}${cwd.slice(from.length)}`]);
				}
				if (page.next === undefined) break;
				cursor = page.next;
			}
		}
		// The move's record, once: the first open of the moved store writes it, and an open after that finds it there.
		const moved = record === undefined ? undefined : await tx.doc(MovesDoc, record.id, null);
		for (const [id, cwd] of changes) await configure(tx, id, { cwd });
		if (from !== to) home.root = to;
		if (moved !== undefined && record !== undefined && moved.v === undefined) Object.assign(moved, record);
	}, context);
}

/**
 * A place a session can run. It opens nothing: it reads what an earlier process of this home left beside the store,
 * so its `state` is `sealed` when that process had sealed, and waits for an order.
 */
export async function openHome(options: HomeOptions): Promise<Result<Home, HomeError>> {
	const home = new SessionHome(options);
	const marker = await home.load();
	return marker.ok ? ok(home) : marker;
}
