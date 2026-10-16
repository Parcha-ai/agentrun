import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Crossing, type CrossingCounter, crossingCounter } from "./crossing.ts";
import type { Drained, DrainOptions } from "./gate.ts";
import { type Frame, LINK_VERSION, type Link } from "./link.ts";
import { catalogOf, type ModelServer, serveModels } from "./models.ts";
import { inSinkOrder, type RecordSink, receiveRecords } from "./records.ts";
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
	/** Where the home is: its state, its epoch, and the seal of a store it sealed and has not opened again. */
	status(context: Context): Promise<Result<HomeStatus, RemoteError>>;
	/**
	 * The epoch of the lease that names this runner. A model frame from any other epoch is refused, and the runner
	 * then ends: a home the lease has left behind has no model.
	 */
	setEpoch(epoch: number): void;
	/** The host's side of the model proxy: what it paid for. */
	readonly models: ModelServer;
	/** Close the link, and the model server when this handle made it: a server the caller passed is the caller's. */
	close(reason: string): void;
}

/** How the host holds a runner. */
export type ConnectOptions = {
	readonly models: Models;
	readonly epoch: number;
	/**
	 * The model server to answer with, made by `serveModels` over the same `models`. Pass the same one to every link to
	 * one runner: a runner that comes back on a new link resumes an answer the host already paid for, and the provider
	 * is not called again. Without it each handle makes its own, and a new link starts with nothing kept.
	 */
	readonly server?: ModelServer;
	/**
	 * Where this session's record stream goes: with it the runner ships every commit's writes, and its recorder's lines,
	 * and a seal waits until they are all here.
	 */
	readonly records?: RecordSink;
	/**
	 * Announced when a tool call of this home starts (`transport.tool.started`, with the tool's name). The runner holds the
	 * tool until this returns (or `info.release()`), so a handler that kills the runner leaves the tool not started.
	 */
	readonly crossing?: Crossing;
	/** What `crossing` is told about this home: the session and its box. */
	readonly crossingFor?: { readonly session: string; readonly box: string };
	/** The place's counter, so that `n` counts across handles. Default: this handle's own. */
	readonly crossingCount?: CrossingCounter;
};

const MODEL_FRAMES = new Set(["model", "model-abort", "model-resume"]);
const RECORD_FRAMES = new Set(["record", "lines"]);
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

/**
 * A home's answer to `status`. `sealed` is there only for a home that holds a sealed store; `session` names the session
 * the note it keeps on disk is for, when the note names one.
 */
export type HomeStatus = {
	readonly state: HomeState;
	readonly epoch: number | null;
	readonly sealed?: Seal;
	readonly session?: string;
};

function isStatus(value: unknown): value is HomeStatus {
	const status = value as { state?: unknown; epoch?: unknown; sealed?: unknown; session?: unknown } | null;
	return (
		typeof status === "object" &&
		status !== null &&
		HOME_STATES.has(status.state) &&
		(status.epoch === null || Number.isSafeInteger(status.epoch)) &&
		(status.sealed === undefined || isSeal(status.sealed)) &&
		(status.session === undefined || typeof status.session === "string")
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
export function connectHome(link: Link, options: ConnectOptions): HomeHandle {
	let epoch = options.epoch;
	let counter = 0;
	const pending = new Map<number, (answer: Result<unknown, RemoteError>) => void>();
	const server = options.server ?? serveModels(options.models);
	const owned = options.server === undefined;
	let settleReady: (ready: Result<Ready, RemoteError>) => void = () => {};
	const ready = new Promise<Result<Ready, RemoteError>>((resolve) => {
		settleReady = resolve;
	});
	const reply = (frame: Frame) => link.send(frame);
	const ledger: CallRecord[] = [];

	const { records } = options;
	const count = options.crossingCount ?? crossingCounter();
	/** What the runner's ready says: the home's state, or why it is not ready. Needs nothing from the log. */
	const readyOf = (frame: Frame): Result<Ready, RemoteError> => {
		if (frame.ok !== true) return err(fromWire(frame.error));
		if (!HOME_STATES.has(frame.state)) {
			return err(
				new RemoteError("invalid", `the runner said it is ready in no known state: ${String(frame.state)}`),
			);
		}
		return ok({ session: String(frame.session), state: frame.state as HomeState });
	};
	// Received and not yet acted on: the runner's ready, and how many answers each order has in the queue.
	let readyHeard: Result<Ready, RemoteError> | undefined;
	const answersQueued = new Map<number, number>();
	const handle = async (frame: Frame): Promise<void> => {
		if (frame.t === "call") {
			// A report from another epoch is a home the lease left behind: its calls are ignored.
			if (frame.epoch !== epoch || typeof frame.id !== "string" || typeof frame.tool !== "string") return;
			const at = Date.now();
			if (frame.phase === "start" && options.crossing !== undefined) {
				// Detached: a handler that sleeps must not hold up this link's other frames (the record stream's acknowledgements).
				const id = String(frame.id);
				let released = false;
				const release = () => {
					if (released) return;
					released = true;
					link.send({ t: "call-ack", id });
				};
				const where = options.crossingFor;
				void Promise.resolve()
					.then(() =>
						options.crossing?.("transport.tool.started", {
							session: where?.session ?? "",
							epoch,
							box: where?.box ?? "",
							tool: frame.tool as string,
							n: count("transport.tool.started"),
							release,
						}),
					)
					.catch(() => {})
					.finally(release);
			}
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
		if (MODEL_FRAMES.has(frame.t) || RECORD_FRAMES.has(frame.t)) {
			// A home the lease left behind has no model, and writes nothing to the session's log.
			if (frame.epoch !== epoch) {
				link.send({
					t: "refused",
					reason: `this home runs at epoch ${String(frame.epoch)}; the lease is at ${epoch}`,
				});
				return;
			}
			if (MODEL_FRAMES.has(frame.t)) server.receive(frame, reply);
			else if (records !== undefined) await receiveRecords(records, frame, reply);
		} else if (frame.t === "ready") {
			const ready = readyOf(frame);
			// Where the host's log is, once every append begun on it from any link settled: the runner sends what it
			// holds from there, then what follows.
			if (ready.ok && records !== undefined) {
				const held = await inSinkOrder(records, async () => records.held());
				link.send({ t: "resend-after", ...held });
			}
			settleReady(ready);
		} else if (frame.t === "answer") {
			const id = Number(frame.id);
			const left = (answersQueued.get(id) ?? 1) - 1;
			if (left > 0) answersQueued.set(id, left);
			else answersQueued.delete(id);
			const settle = pending.get(id);
			pending.delete(id);
			settle?.(frame.ok === true ? ok(frame.value) : err(fromWire(frame.error)));
		}
	};
	// One frame after another: a commit is in the log before any later frame of the link is acted on.
	let handled: Promise<void> = Promise.resolve();
	link.onFrame((frame) => {
		if (frame.t === "ready") readyHeard ??= readyOf(frame);
		else if (frame.t === "answer")
			answersQueued.set(Number(frame.id), (answersQueued.get(Number(frame.id)) ?? 0) + 1);
		handled = handled
			.then(() => handle(frame))
			.catch((cause) => {
				link.close(
					`the host could not keep the record stream: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			});
	});
	link.onClose((reason) => {
		server.down(reply);
		const lost = (): Result<never, RemoteError> => err(new RemoteError("link_lost", `the link went down: ${reason}`));
		// At once, whatever the log is doing: the runner's ready is what it said, and an order it did not answer is lost.
		settleReady(readyHeard ?? lost());
		for (const [id, settle] of pending) {
			if (answersQueued.has(id)) continue;
			pending.delete(id);
			settle(lost());
		}
		// An answer the runner sent before it closed is still its answer, after the frames that came before it: a commit
		// is in the log before an answer that followed it is acted on.
		handled = handled.then(() => {
			for (const settle of pending.values()) settle(lost());
			pending.clear();
		});
	});
	link.send({
		t: "hello",
		v: LINK_VERSION,
		catalog: catalogOf(options.models),
		...(records === undefined ? {} : { records: true }),
		...(options.crossing === undefined ? {} : { crossing: true }),
	});

	const order = <T>(name: string, args: Readonly<Record<string, unknown>>, context: Context) =>
		new Promise<Result<T, RemoteError>>((resolve) => {
			if (link.closed) {
				resolve(err(new RemoteError("link_lost", "the link is down")));
				return;
			}
			// A context that ended already: nothing is sent, so nothing starts in the runner.
			if (context.abortSignal?.aborted) {
				resolve(err(new RemoteError("aborted", `the host gave up on ${name} before sending it`)));
				return;
			}
			counter += 1;
			const id = counter;
			const onAbort = () => {
				pending.delete(id);
				// The runner stops the order too, as a caller's abort stops it in the host's own process: a drain it
				// gives up opens the gate again.
				link.send({ t: "cancel", id });
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
			if (owned) server.close();
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
