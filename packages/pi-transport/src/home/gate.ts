import type { Context } from "@earendil-works/chord";
import {
	CompactionTask,
	type ConversationId,
	defineExtension,
	type Extension,
	GenerationTask,
	type Harness,
	type HookApi,
	hook,
	type TaskId,
	ToolTask,
} from "@earendil-works/pi-durable";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";

/** The name the gate's extension is installed under, the same in every home, so a store opens with it anywhere. */
export const GATE_EXTENSION = "transport";

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const DRAIN_POLL_MS = 5;
/** A drain is done when this many reads in a row find everything that runs held. */
const STABLE_READS = 2;

/** `timeout`: something ran on and was not held in time. `aborted`: the caller's context ended the wait. */
export type DrainErrorCode = "timeout" | "aborted";

/** A task kind and how many tasks of it were running and not held. */
export type Holdout = { readonly kind: string; readonly count: number };

/**
 * A drain that did not complete. The gate is open again and nothing was cut: the session works on where it is.
 * `holdouts` names what ran on, so an app whose own task never ends learns which kind to list as closeable.
 */
export class DrainError extends Error {
	public code: DrainErrorCode;
	public holdouts: readonly Holdout[];

	constructor(code: DrainErrorCode, message: string, holdouts: readonly Holdout[] = []) {
		super(message);
		this.name = "DrainError";
		this.code = code;
		this.holdouts = holdouts;
	}
}

/** A drain that completed: every task that still runs is held at the gate, and the Harness may be closed. */
export type Drained = {
	/** Tasks held at the gate. `0` means the session was idle. */
	readonly held: number;
	/** Running tasks of closeable kinds, which the close will stop and the next opener resumes. */
	readonly closeable: number;
	readonly ms: number;
};

export type DrainOptions = {
	/** How long running work may take to reach the gate. Default 60 s. */
	readonly timeoutMs?: number;
	/**
	 * Task kinds the drain does not wait for. The close stops such a task as a crash would, and the next opener
	 * resumes it from its checkpoint, so the task must make its own effect safe to repeat. Default: none.
	 */
	readonly closeable?: readonly string[];
};

/**
 * What holds a session still for a move, with no change to pi.
 *
 * While a drain is pending the gate's hooks hold new work: a tool call before its intent is written, a model
 * request before it is sent, a compaction before it selects. A held task has written nothing, so closing the Harness
 * leaves no outcome for it and the next opener runs it from the start. Work of a conversation whose owner task is
 * running is let through: the owner, a tool that waits for its child conversation, can only finish when the child
 * does.
 *
 * Invariant: the gate never cuts. A drain that cannot complete opens the gate again and says what held it.
 */
export interface Gate {
	/** The gate's hooks, to install in the registry under `GATE_EXTENSION`. */
	readonly extension: Extension;
	/** The Harness the gate guards. Call once, after `Harness.open` and before `resume()`. */
	attach(harness: Harness): void;
	/**
	 * Hold new work, then wait until every running task is held. On success the caller closes the Harness. On failure
	 * the gate is already open again.
	 */
	drain(options: DrainOptions | undefined, context: Context): Promise<Result<Drained, DrainError>>;
	/** Let held work go on and stop holding new work: the move was abandoned. Safe to call at any time. */
	open(): void;
	/** Tasks held at the gate now. */
	readonly held: number;
}

function abortError(): Error {
	return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** Make a gate. One for each Harness. */
export function createGate(): Gate {
	/** Held tasks, each with the call that lets it go on. */
	const held = new Map<string, () => void>();
	/** Each conversation's owner task, or `null` for one with no owner. Learned once: an owner never changes. */
	const owners = new Map<ConversationId, TaskId | null>();
	let holding = false;
	let harness: Harness | undefined;

	const park = (taskId: TaskId, context: Context): Promise<undefined> =>
		new Promise<undefined>((resolve, reject) => {
			const id = String(taskId);
			const signal = context.abortSignal;
			const abort = () => {
				held.delete(id);
				reject(abortError());
			};
			held.set(id, () => {
				signal?.removeEventListener("abort", abort);
				held.delete(id);
				resolve(undefined);
			});
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});

	/** Whether the conversation belongs to a task that is running now, so that task waits for this work. */
	const ownerRuns = async (conversationId: ConversationId, guarded: Harness, context: Context): Promise<boolean> => {
		let owner = owners.get(conversationId);
		if (owner === undefined) {
			const record = await guarded.commit((tx) => tx.conversation(conversationId), context);
			owner = record?.owner?.taskId ?? null;
			owners.set(conversationId, owner);
		}
		if (owner === null) return false;
		return (await guarded.getTask(owner, context))?.state.status === "running";
	};

	const at = async (api: HookApi, context: Context): Promise<undefined> => {
		if (!holding || harness === undefined) return undefined;
		let passes: boolean;
		try {
			passes = await ownerRuns(api.conversationId, harness, context);
		} catch (cause) {
			// The Harness is closing under the hook: the same as an abort while held.
			if (context.abortSignal?.aborted) throw abortError();
			throw cause;
		}
		// The gate may have opened while the owner was looked up.
		if (passes || !holding) return undefined;
		return park(api.taskId, context);
	};

	const open = (): void => {
		holding = false;
		for (const release of [...held.values()]) release();
	};

	return {
		extension: defineExtension({
			name: GATE_EXTENSION,
			hooks: [
				hook(ToolTask, { beforeTool: (_call, api, context) => at(api, context) }),
				hook(GenerationTask, { beforeRequest: (_request, api, context) => at(api, context) }),
				hook(CompactionTask, { beforeCompact: (_compaction, api, context) => at(api, context) }),
			],
		}),
		attach(opened) {
			harness = opened;
		},
		async drain(options, context) {
			const guarded = harness;
			if (guarded === undefined) throw new Error("the gate has no Harness: call attach() after Harness.open");
			const timeoutMs = options?.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
			const closeable = new Set(options?.closeable ?? []);
			const started = performance.now();
			holding = true;
			let stable = 0;
			let holdouts: Holdout[] = [];
			for (;;) {
				if (context.abortSignal?.aborted) {
					open();
					return err(new DrainError("aborted", "the drain was aborted; the gate is open again"));
				}
				const { tasks } = await guarded.inspect(context);
				const counted = tasks.filter((task) => !closeable.has(task.record.kind));
				const running = counted.filter((task) => task.state.kind === "running");
				const loose = running.filter((task) => !held.has(String(task.record.id)));
				// A task that is ready has not reached a hook yet: it is about to run.
				const ready = counted.some((task) => task.state.kind === "ready");
				if (!ready && loose.length === 0) {
					stable += 1;
					if (stable >= STABLE_READS) {
						const stopped = tasks.filter(
							(task) => closeable.has(task.record.kind) && task.state.kind === "running",
						);
						return ok({
							held: held.size,
							closeable: stopped.length,
							ms: Math.round(performance.now() - started),
						});
					}
				} else {
					stable = 0;
					const byKind = new Map<string, number>();
					for (const task of loose) byKind.set(task.record.kind, (byKind.get(task.record.kind) ?? 0) + 1);
					holdouts = [...byKind].map(([kind, count]) => ({ kind, count }));
				}
				if (performance.now() - started >= timeoutMs) {
					open();
					const named = holdouts.map(({ kind, count }) => `${count} ${kind}`).join(", ");
					return err(
						new DrainError(
							"timeout",
							`the session did not come to rest in ${timeoutMs} ms${named === "" ? "" : `: still running, ${named}`}; the gate is open again and nothing was cut`,
							holdouts,
						),
					);
				}
				await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
			}
		},
		open,
		get held() {
			return held.size;
		},
	};
}
