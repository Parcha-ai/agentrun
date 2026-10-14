import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Drained, DrainOptions } from "./gate.ts";
import { type Frame, LINK_VERSION, type Link } from "./link.ts";
import { catalogOf, type ModelServer, serveModels } from "./models.ts";
import type { CheckpointTaken, HomeState, ResumeOrder } from "./run.ts";
import type { Seal } from "./store.ts";

/** What a runner said when the link came up. */
export type Ready = { readonly session: string; readonly state: HomeState };

/**
 * A failure on the far side, or of the link itself. `code` is the runner's own code (a `HomeError`'s or a
 * `DrainError`'s), or `link_lost` when the link went down before the answer came.
 */
export class RemoteError extends Error {
	public code: string;
	public remote: string;
	public holdouts: readonly { readonly kind: string; readonly count: number }[];

	constructor(code: string, message: string, remote = "RemoteError", holdouts: RemoteError["holdouts"] = []) {
		super(message);
		this.name = "RemoteError";
		this.code = code;
		this.remote = remote;
		this.holdouts = holdouts;
	}
}

/** A tool call a runner reported: when it began, and when it ended if it did. Times are the host's own clock. */
export type CallRecord = {
	readonly id: string;
	readonly tool: string;
	readonly replay: "safe" | "unsafe";
	readonly startedAt: number;
	readonly endedAt?: number;
};

const CALL_LEDGER_LIMIT = 1_000;

/** The host's hold on one runner: orders out, answers back, and the runner's model requests served. */
export interface HomeHandle {
	/** Settles when the runner said it is ready, or the link went down first. */
	readonly ready: Promise<Result<Ready, RemoteError>>;
	resume(order: ResumeOrder, context: Context): Promise<Result<void, RemoteError>>;
	drain(options: DrainOptions | undefined, context: Context): Promise<Result<Drained, RemoteError>>;
	abandon(context: Context): Promise<Result<void, RemoteError>>;
	seal(context: Context): Promise<Result<Seal, RemoteError>>;
	reopen(epoch: number, context: Context): Promise<Result<void, RemoteError>>;
	retire(epoch: number, context: Context): Promise<Result<void, RemoteError>>;
	/**
	 * Hold the session and have the runner copy its store beside it (`Home.checkpoint`). The session stays held until
	 * `abandon`, so the caller can read the workspace at the same moment.
	 */
	checkpoint(options: DrainOptions | undefined, context: Context): Promise<Result<CheckpointTaken, RemoteError>>;
	/** The tool calls this runner reported, oldest first, the last 1,000. Kept in this process only. */
	calls(): readonly CallRecord[];
	submit(
		content: string,
		requestId: string | undefined,
		context: Context,
	): Promise<Result<{ readonly submission: string }, RemoteError>>;
	/** Settles when the root conversation is idle. */
	idle(context: Context): Promise<Result<void, RemoteError>>;
	status(context: Context): Promise<Result<{ readonly state: HomeState; readonly epoch: number | null }, RemoteError>>;
	/**
	 * The epoch of the lease that names this runner. A model frame from any other epoch is refused, and the runner
	 * then ends: a home the lease has left behind has no model.
	 */
	setEpoch(epoch: number): void;
	/** The host's side of the model proxy: what it paid for. */
	readonly models: ModelServer;
	close(reason: string): void;
}

const MODEL_FRAMES = new Set(["model", "model-abort", "model-resume"]);
const HOME_STATES: ReadonlySet<unknown> = new Set<HomeState>(["closed", "open", "sealed", "retired"]);

/** Whether `value` is a whole number at least 0. */
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** A seal as the host checks copies against it: a head, a SHA-256 in lowercase hex, a size. */
function isSeal(value: unknown): value is Seal {
	const seal = value as Partial<Seal> | null;
	return (
		typeof seal === "object" &&
		seal !== null &&
		count(seal.head) &&
		count(seal.bytes) &&
		typeof seal.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(seal.sha256)
	);
}

function isCheckpoint(value: unknown): value is CheckpointTaken {
	const taken = value as { seal?: unknown; path?: unknown } | null;
	return typeof taken === "object" && taken !== null && isSeal(taken.seal) && typeof taken.path === "string";
}

function isStatus(value: unknown): value is { readonly state: HomeState; readonly epoch: number | null } {
	const status = value as { state?: unknown; epoch?: unknown } | null;
	return (
		typeof status === "object" &&
		status !== null &&
		HOME_STATES.has(status.state) &&
		(status.epoch === null || Number.isSafeInteger(status.epoch))
	);
}

/** An answer the host acts on, refused when its shape is not what the runner owes: the runner is not trusted. */
function checked<T>(
	answer: Result<unknown, RemoteError>,
	is: (value: unknown) => value is T,
	what: string,
): Result<T, RemoteError> {
	if (!answer.ok) return answer;
	if (is(answer.value)) return ok(answer.value);
	const shown = JSON.stringify(answer.value)?.slice(0, 200);
	return err(new RemoteError("invalid", `the runner's ${what} has the wrong shape: ${shown}`));
}

/** Hold a runner on `link`: say hello with the host's models, then give orders and serve its model requests. */
export function connectHome(link: Link, options: { readonly models: Models; readonly epoch: number }): HomeHandle {
	let epoch = options.epoch;
	let counter = 0;
	const pending = new Map<number, (answer: Result<unknown, RemoteError>) => void>();
	const server = serveModels(options.models);
	let settleReady: (ready: Result<Ready, RemoteError>) => void = () => {};
	const ready = new Promise<Result<Ready, RemoteError>>((resolve) => {
		settleReady = resolve;
	});
	const reply = (frame: Frame) => link.send(frame);
	const ledger: CallRecord[] = [];

	link.onFrame((frame) => {
		if (frame.t === "call") {
			// A report from another epoch is a home the lease left behind: its model requests are refused, its calls ignored.
			if (frame.epoch !== epoch || typeof frame.id !== "string" || typeof frame.tool !== "string") return;
			const at = Date.now();
			if (frame.phase === "start") {
				ledger.push({
					id: frame.id,
					tool: frame.tool,
					replay: frame.replay === "safe" ? "safe" : "unsafe",
					startedAt: at,
				});
				if (ledger.length > CALL_LEDGER_LIMIT) ledger.shift();
			} else if (frame.phase === "end") {
				const at_ = ledger.findLastIndex((record) => record.id === frame.id);
				if (at_ >= 0) ledger[at_] = { ...(ledger[at_] as CallRecord), endedAt: at };
			}
			return;
		}
		if (MODEL_FRAMES.has(frame.t)) {
			if (frame.epoch !== epoch) {
				link.send({
					t: "refused",
					reason: `this home runs at epoch ${String(frame.epoch)}; the lease is at ${epoch}`,
				});
				return;
			}
			server.receive(frame, reply);
		} else if (frame.t === "ready") {
			if (frame.ok !== true) settleReady(err(fromWire(frame.error)));
			else if (!HOME_STATES.has(frame.state)) {
				settleReady(
					err(new RemoteError("invalid", `the runner said it is ready in no known state: ${String(frame.state)}`)),
				);
			} else settleReady(ok({ session: String(frame.session), state: frame.state as HomeState }));
		} else if (frame.t === "answer") {
			const settle = pending.get(Number(frame.id));
			pending.delete(Number(frame.id));
			settle?.(frame.ok === true ? ok(frame.value) : err(fromWire(frame.error)));
		}
	});
	link.onClose((reason) => {
		server.down();
		settleReady(err(new RemoteError("link_lost", `the link went down: ${reason}`)));
		for (const settle of pending.values()) settle(err(new RemoteError("link_lost", `the link went down: ${reason}`)));
		pending.clear();
	});
	server.up(reply);
	link.send({ t: "hello", v: LINK_VERSION, catalog: catalogOf(options.models) });

	const order = <T>(name: string, args: Readonly<Record<string, unknown>>, context: Context) =>
		new Promise<Result<T, RemoteError>>((resolve) => {
			if (link.closed) {
				resolve(err(new RemoteError("link_lost", "the link is down")));
				return;
			}
			counter += 1;
			const id = counter;
			const onAbort = () => {
				pending.delete(id);
				resolve(err(new RemoteError("aborted", `the host gave up waiting for ${name}`)));
			};
			context.abortSignal?.addEventListener("abort", onAbort, { once: true });
			pending.set(id, (answer) => {
				context.abortSignal?.removeEventListener("abort", onAbort);
				resolve(answer as Result<T, RemoteError>);
			});
			link.send({ t: "order", id, order: name, args });
		});

	return {
		ready,
		resume: (resumeOrder, context) => order("resume", resumeOrder, context),
		drain: (drainOptions, context) => order("drain", drainOptions ?? {}, context),
		abandon: (context) => order("abandon", {}, context),
		checkpoint: async (checkpointOptions, context) =>
			checked(await order<unknown>("checkpoint", checkpointOptions ?? {}, context), isCheckpoint, "checkpoint"),
		calls: () => [...ledger],
		seal: async (context) => checked(await order<unknown>("seal", {}, context), isSeal, "seal"),
		reopen: (to, context) => order("reopen", { epoch: to }, context),
		retire: (to, context) => order("retire", { epoch: to }, context),
		submit: (content, requestId, context) =>
			order("submit", { content, ...(requestId === undefined ? {} : { requestId }) }, context),
		idle: (context) => order("idle", {}, context),
		status: async (context) => checked(await order<unknown>("status", {}, context), isStatus, "status"),
		setEpoch(to) {
			epoch = to;
		},
		models: server,
		close(reason) {
			server.close();
			link.close(reason);
		},
	};
}

function fromWire(error: unknown): RemoteError {
	const sent = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown; holdouts?: unknown };
	return new RemoteError(
		typeof sent.code === "string" ? sent.code : "unknown",
		typeof sent.message === "string" ? sent.message : "the runner failed",
		typeof sent.name === "string" ? sent.name : "Error",
		Array.isArray(sent.holdouts) ? (sent.holdouts as RemoteError["holdouts"]) : [],
	);
}
