import { DatabaseSync } from "node:sqlite";

/** A store this process holds alone, until it lets go. */
export type StoreHold = { release(): void };

/** Whether `cause` is SQLite's answer that another connection holds the lock. */
function isBusy(cause: unknown): boolean {
	const { errcode, message } = (cause ?? {}) as { errcode?: unknown; message?: unknown };
	return errcode === 5 || (typeof message === "string" && message.includes("database is locked"));
}

/**
 * Hold the store at `store` alone: an exclusive SQLite lock on `<store>.lock`, beside it. The operating system drops
 * the lock with the process, however the process ends, so a runner that died never leaves it behind. `undefined` when
 * another process, or another hold in this one, has it.
 */
export function holdStore(store: string): StoreHold | undefined {
	const lock = new DatabaseSync(`${store}.lock`);
	try {
		lock.exec("PRAGMA locking_mode = EXCLUSIVE");
		lock.exec("BEGIN EXCLUSIVE");
	} catch (cause) {
		lock.close();
		if (isBusy(cause)) return undefined;
		throw cause;
	}
	let held = true;
	return {
		release() {
			if (!held) return;
			held = false;
			lock.close();
		},
	};
}
