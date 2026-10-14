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
};

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
