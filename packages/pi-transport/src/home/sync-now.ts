// The home store's barrier: every commit the store made is durable when it resolves, before a tool call that is not
// replay-safe runs. The store runs at synchronous = NORMAL (pi-durable's own opener), where a commit is in the WAL file
// but not yet synced; this syncs that file directly (fdatasync on a descriptor of its own, on the thread pool). A
// checkpoint would not do: one that cannot copy (a reader holds the log) returns without syncing it. And a marker
// commit, agentrun's own barrier for a run's store (pi-durable-disk barriers.ts, where this one is listed as
// `homeToolIntent`), would need a table pi-durable does not make, which a home store may not hold. Here, and not
// imported, because this package depends on no agentrun package.
import { open, realpath } from "node:fs/promises";

/** The store, as its barrier takes it: the path of its WAL file (`walFileOf`). */
export interface SyncTarget {
	readonly walFile: string;
}

/** The WAL file SQLite keeps for the store at `store`: beside the file the path resolves to, a symbolic link followed. */
export async function walFileOf(store: string): Promise<string> {
	return `${await realpath(store)}-wal`;
}

/** The barriers this package calls, as pi-durable-disk's barriers.ts names them. */
export type HomeBarrier = "homeToolIntent";

/**
 * Every commit in the store's WAL is on disk when this resolves. A store open in WAL mode that has committed (the call's
 * intent, at least) has its WAL file, so a missing one means the path is not the store's: that rejects, and the call it
 * guards is not run.
 */
export async function syncNow(store: SyncTarget, _barrier: HomeBarrier): Promise<void> {
	const handle = await open(store.walFile, "r");
	try {
		await handle.datasync();
	} finally {
		await handle.close();
	}
}
