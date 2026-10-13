import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	configure,
	defineDoc,
	Harness,
	type HarnessOptions,
} from "@earendil-works/pi-durable";
import { err, ok, type Result, toError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type App, type AppContext, type AppOptions, appOptions } from "./app.ts";
import { createGate, type DrainError, type Drained, type DrainOptions, type Gate } from "./gate.ts";
import { type Seal, sealStore, verifyStore } from "./store.ts";

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

/**
 * Why a home refused an order. `wrong_state`: the order does not fit what the home is doing. `stale_epoch`: the
 * order is for an epoch this home has left behind. `not_verified`: a store is here that no seal vouches for.
 * `seal_mismatch`: the store here is not the one the seal names. `app`: the app did not load or build. `store`: the
 * store could not be opened, sealed or removed.
 */
export type HomeErrorCode = "wrong_state" | "stale_epoch" | "not_verified" | "seal_mismatch" | "app" | "store";

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
	};
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
};

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
	/** After a drain: close the Harness and seal the store. From then on only `reopen` or `retire` is taken. */
	seal(context: Context): Promise<Result<Seal, HomeError>>;
	/** The move was abandoned and the lease still names this home at `epoch`: open the sealed store again. */
	reopen(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>>;
	/** The session lives elsewhere from `epoch` on: stop if anything runs, and delete this copy. */
	retire(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>>;
	/** Stop without sealing, as a kill would but in order. The next `resume` at the same epoch opens the store again. */
	close(context: Context): Promise<void>;
}

/** What a home remembers on disk beside its store: which epoch's store it verified here, and whether it sealed it. */
type Marker = {
	readonly v: 1;
	readonly epoch: number;
	readonly seal?: Seal;
	readonly move?: string;
	readonly sealed?: Seal;
};

class SessionHome implements Home {
	readonly #options: HomeOptions;
	readonly #markerPath: string;
	#harness: Harness | undefined;
	#gate: Gate | undefined;
	#app: AppOptions | undefined;
	#marker: Marker | undefined;
	#drained = false;
	#retired = false;

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
		if (this.#retired) return "retired";
		if (this.#harness !== undefined) return "open";
		return this.#marker?.sealed === undefined ? "closed" : "sealed";
	}

	get epoch(): number | undefined {
		return this.#marker?.epoch;
	}

	get harness(): Harness | undefined {
		return this.#harness;
	}

	async resume(order: ResumeOrder, context: Context): Promise<Result<void, HomeError>> {
		if (this.#harness !== undefined) return err(new HomeError("wrong_state", "the session already runs here"));
		const marker = await this.#readMarker();
		if (!marker.ok) return marker;
		const known = marker.value;
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

	async seal(context: Context): Promise<Result<Seal, HomeError>> {
		const harness = this.#harness;
		const marker = this.#marker;
		if (harness === undefined || marker === undefined) {
			return err(new HomeError("wrong_state", "the session does not run here"));
		}
		if (!this.#drained) return err(new HomeError("wrong_state", "a seal follows a drain that completed"));
		await this.close(context);
		const sealed = await sealStore(this.#options.store, context);
		// The store is closed and whole either way. Without a seal the host tells this home to resume.
		if (!sealed.ok) return err(new HomeError("store", `could not seal the store: ${sealed.error.message}`));
		const written = await this.#writeMarker({ ...marker, sealed: sealed.value });
		if (!written.ok) return written;
		return sealed;
	}

	async reopen(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>> {
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

	async retire(order: { readonly epoch: number }, context: Context): Promise<Result<void, HomeError>> {
		const marker = await this.#readMarker();
		if (!marker.ok) return marker;
		if (marker.value !== undefined && order.epoch <= marker.value.epoch) {
			return err(
				new HomeError(
					"stale_epoch",
					`this home is at epoch ${marker.value.epoch}; only a later epoch retires it, and the order is for ${order.epoch}`,
				),
			);
		}
		// The lease names another home. Whatever still runs here runs for nobody.
		await this.close(context);
		const { store } = this.#options;
		try {
			for (const path of [store, `${store}-wal`, `${store}-shm`, this.#markerPath]) await rm(path, { force: true });
		} catch (cause) {
			return err(new HomeError("store", `could not delete this home's copy: ${toError(cause).message}`, cause));
		}
		this.#marker = undefined;
		this.#retired = true;
		return ok(undefined);
	}

	async close(context: Context): Promise<void> {
		const harness = this.#harness;
		this.#harness = undefined;
		this.#gate = undefined;
		this.#drained = false;
		await harness?.close(context);
	}

	/** Open the store, bring the conversations here, admit the notice, resume. Every step is safe to repeat. */
	async #open(order: ResumeOrder, context: Context): Promise<Result<void, HomeError>> {
		const { app, session, store, workspace, where, models } = this.#options;
		const built = await appOptions(app, { session, workspace, store, models, where });
		if (!built.ok) return err(new HomeError("app", built.error.message, built.error));
		const { root: _root, onOpen, registry, ...rest } = built.value;
		const gate = createGate();
		registry.install(gate.extension);
		const env: HarnessOptions["env"] =
			this.#options.env ?? (async (target) => new NodeExecutionEnv({ cwd: target.cwd ?? workspace }));
		let harness: Harness;
		try {
			await mkdir(dirname(store), { recursive: true });
			harness = await Harness.open(await openNodeSqliteStorage(store), { ...rest, registry, models, env }, context);
		} catch (cause) {
			return err(new HomeError("store", `could not open the store: ${toError(cause).message}`, cause));
		}
		gate.attach(harness);
		try {
			await bringHere(harness, workspace, context);
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
			return err(new HomeError("store", `could not prepare the session: ${toError(cause).message}`, cause));
		}
		harness.resume();
		this.#harness = harness;
		this.#gate = gate;
		this.#app = built.value;
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

	/** Written whole beside the store and renamed into place, so a reader finds the old marker or the new one. */
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
async function bringHere(harness: Harness, to: string, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const home = await tx.doc(HomeDoc);
		const from = home.root;
		if (from === to) return;
		if (from === undefined) {
			home.root = to;
			return;
		}
		// Every read comes before the first write: a transaction refuses a table read after one.
		const changes: [ConversationId, string][] = [];
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
		for (const [id, cwd] of changes) await configure(tx, id, { cwd });
		home.root = to;
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
