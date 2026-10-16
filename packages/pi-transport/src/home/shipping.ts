import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { Outbox } from "./outbox.ts";

/** A commit a shipping storage made: its sequence and its writes. */
export type Shipped = { readonly commit: number; readonly writes: readonly StorageWrite[] };

export type ShippingOptions = {
	readonly outbox: Outbox;
	/** The sequence the store's next commit takes (`storeHead`). */
	readonly head: number;
	/** Each commit once it landed, in order. It must not throw: what it fails to send is still in the outbox. */
	readonly ship: (shipped: Shipped) => void;
	/**
	 * Whether a batch admits an effect that runs in this process. Its commit returns only once `acknowledged` says the
	 * host holds it, so no effect starts that the host's log lacks; when `acknowledged` says false the commit fails, pi
	 * stops the session, and the effect never runs.
	 */
	readonly admits?: (writes: readonly StorageWrite[]) => boolean;
	readonly acknowledged?: (commit: number) => Promise<boolean>;
};

/**
 * pi's own admission: a tool task that goes to `running` with its intent, the commit pi makes just before it runs the
 * tool (the same in pi-durable 1.0.4 to 1.2).
 */
export function admitsTool(writes: readonly StorageWrite[]): boolean {
	return writes.some((write) => {
		if (write.type !== "task" || write.value.kind !== "pi.tool") return false;
		const state = write.value.state as { readonly status: string; readonly checkpoint?: unknown };
		return state.status === "running" && (state.checkpoint as { phase?: unknown } | undefined)?.phase === "execute";
	});
}

/**
 * A store whose commits are shipped. Each commit's writes go to the outbox, synced, before the store commits them, and
 * to `ship` once it has: what the host is sent is always in the store, and a commit that landed is in the outbox even
 * when the process dies before it was sent. Commits are made one at a time. A store that commits at a sequence other
 * than the one expected has been written by someone else: the commit fails, and so does every later one.
 */
export function shippingStorage(inner: Storage, options: ShippingOptions): Storage {
	let next = options.head;
	let broken: Error | undefined;
	let line: Promise<unknown> = Promise.resolve();
	const commit: Storage["commit"] = (writes, context) => {
		const made = line.then(async () => {
			if (broken !== undefined) throw broken;
			const expected = next;
			options.outbox.entry(expected, writes);
			const seq = await inner.commit(writes, context);
			if (Number(seq) !== expected) {
				broken = new Error(`the store committed at ${String(seq)} where ${expected} was next: another writer`);
				throw broken;
			}
			next = expected + 1;
			options.ship({ commit: expected, writes });
			if (options.admits?.(writes) === true && options.acknowledged !== undefined) {
				if (!(await options.acknowledged(expected))) {
					throw new Error(
						`the host did not acknowledge commit ${expected} in time, and it admits an effect: the effect does not run`,
					);
				}
			}
			return seq;
		});
		line = made.catch(() => {});
		return made;
	};
	return new Proxy(inner, {
		get(target, key) {
			if (key === "commit") return commit;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
