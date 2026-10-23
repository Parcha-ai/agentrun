import type { Storage } from "@earendil-works/pi-durable";
import type { LogEntry } from "../src/home/commit-log.ts";

/**
 * A store whose commits are reported, each once it landed and in the order it landed: the runner's stream as a test
 * reads it, without the link. The package's own shipper does this over a link, with an outbox.
 */
export function tapStorage(inner: Storage, ship: (entry: LogEntry) => void): Storage {
	let line: Promise<unknown> = Promise.resolve();
	const commit: Storage["commit"] = (writes, context) => {
		const made = line.then(async () => {
			const seq = await inner.commit(writes, context);
			ship({ commit: Number(seq), writes });
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
