// The home store's barrier: every commit the store made is durable when it resolves, before a tool call that is not
// replay-safe runs. The store runs at synchronous = NORMAL (pi-durable's own opener), where a commit is in the WAL file
// but not yet synced; this syncs that file directly (fdatasync on a descriptor of its own, on the thread pool). A
// checkpoint would not do: one that cannot copy (a reader holds the log) returns without syncing it. And a marker
// commit, agentrun's own barrier for a run's store (pi-durable-disk barriers.ts, where this one is listed as
// `homeToolIntent`), would need a table pi-durable does not make, which a home store may not hold. Here, and not
// imported, because this package depends on no agentrun package.
import { open } from "node:fs/promises";

/** The store, as its barrier takes it: the path of its WAL file. */
export interface SyncTarget {
	readonly walFile: string;
}

/** The barriers this package calls, as pi-durable-disk's barriers.ts names them. */
export type HomeBarrier = "homeToolIntent";

/** Every commit in the store's WAL is on disk when this resolves. No WAL file: every commit is in the database file. */
export async function syncNow(store: SyncTarget, _barrier: HomeBarrier): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(store.walFile, "r");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
		throw cause;
	}
	try {
		await handle.datasync();
	} finally {
		await handle.close();
	}
}
