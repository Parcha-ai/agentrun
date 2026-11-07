// The home store's barrier: every commit the store made is durable when it resolves. agentrun's own barrier (pi-durable-
// disk barriers.ts, where this one is listed as `homeToolIntent`) is a marker commit at FULL; a home store may hold no
// table pi-durable does not make (store.ts checks a store's schema before a restore), so here the barrier is a passive
// checkpoint instead: at synchronous = NORMAL, SQLite syncs the WAL before it copies it into the database file, and
// syncs the database file after. Here, and not imported, because this package depends on no agentrun package.
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";

export interface SyncTarget {
	readonly database: SqliteDatabase;
	readonly synchronous: "FULL" | "NORMAL";
}

/** The barriers this package calls, as pi-durable-disk's barriers.ts names them. */
export type HomeBarrier = "homeToolIntent";

/** Every commit `store` made is durable when this resolves. A store at FULL synced at every commit already. */
export async function syncNow(store: SyncTarget, _barrier: HomeBarrier): Promise<void> {
	if (store.synchronous === "FULL") return;
	await store.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
}
