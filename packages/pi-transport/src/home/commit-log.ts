import type { Context } from "@earendil-works/chord";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * One commit of a session's store as a runner shipped it (`record { commit, writes }`): the sequence it took and its exact
 * `StorageWrite` batch.
 * Applying the batches after a checkpoint, in order, through `Storage.commit` gives the store the runner had.
 */
export type LogEntry = { readonly commit: number; readonly writes: readonly StorageWrite[] };

export type ReplayErrorCode = "gap" | "mismatch" | "failed";

export class ReplayError extends Error {
	public code: ReplayErrorCode;
	/** The last commit that was applied before the error, or `from - 1` when none was. */
	public applied: number;

	constructor(code: ReplayErrorCode, message: string, applied: number, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ReplayError";
		this.code = code;
		this.applied = applied;
	}
}

/**
 * Apply `entries` to the store at `path`, a copy of a checkpoint whose next commit is `from`, in order and through the
 * store's own `Storage`, before any Harness opens it. The first entry must be `from` and each next one the one after;
 * the commit a store answers with must be the one the entry names. On an error the entries applied before it stay
 * applied (`error.applied` says which), so a caller may use the store as far as it got.
 */
export async function replayCommits(
	path: string,
	from: number,
	entries: readonly LogEntry[],
	context: Context,
): Promise<Result<{ readonly from: number; readonly to: number; readonly count: number }, ReplayError>> {
	let applied = from - 1;
	let storage: Storage;
	try {
		storage = await openNodeSqliteStorage(path);
	} catch (cause) {
		return err(
			new ReplayError("failed", `could not open the store to replay into: ${String(cause)}`, applied, cause),
		);
	}
	let failure: ReplayError | undefined;
	try {
		for (const entry of entries) {
			if (entry.commit !== applied + 1) {
				failure = new ReplayError("gap", `commit ${entry.commit} came where ${applied + 1} was next`, applied);
				break;
			}
			const seq = Number(await storage.commit(entry.writes, context));
			if (seq !== entry.commit) {
				failure = new ReplayError("mismatch", `the store took commit ${entry.commit} as ${seq}`, seq);
				break;
			}
			applied = seq;
		}
	} catch (cause) {
		failure = new ReplayError(
			"failed",
			`could not apply commit ${applied + 1}: ${cause instanceof Error ? cause.message : String(cause)}`,
			applied,
			cause,
		);
	} finally {
		await storage.close(context);
	}
	if (failure !== undefined) return err(failure);
	return ok({ from, to: applied, count: applied - from + 1 });
}
