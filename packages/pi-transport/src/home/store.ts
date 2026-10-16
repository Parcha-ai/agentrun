import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, open, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";

const SQLITE_HEADER = "SQLite format 3\0";
const BUSY_TIMEOUT_MS = 5_000;
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Why a store call failed. `not_sealed` means the store was not closed cleanly, `mismatch` that a copy is not the
 * sealed store, `corrupt` that SQLite does not accept the file, `exists` that a checkpoint would overwrite a file.
 */
export type StoreErrorCode =
	| "aborted"
	| "not_found"
	| "not_sealed"
	| "mismatch"
	| "corrupt"
	| "exists"
	| "invalid"
	| "unknown";

/** An expected failure of a store call. Returned, never thrown. */
export class StoreError extends Error {
	public code: StoreErrorCode;

	constructor(code: StoreErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "StoreError";
		this.code = code;
	}
}

/** What a sealed store is: enough to know that a copy is the same store at the same point. */
export type Seal = {
	/** The sequence number the next commit of the store would take. */
	readonly head: number;
	readonly sha256: string;
	readonly bytes: number;
};

function aborted(context: Context): StoreError | undefined {
	return context.abortSignal?.aborted ? new StoreError("aborted", "the call was aborted") : undefined;
}

async function hashFile(
	path: string,
	context: Context,
): Promise<Result<{ sha256: string; bytes: number }, StoreError>> {
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		for await (const chunk of createReadStream(path, { highWaterMark: HASH_CHUNK_BYTES })) {
			const stopped = aborted(context);
			if (stopped) return err(stopped);
			hash.update(chunk as Buffer);
			bytes += (chunk as Buffer).length;
		}
	} catch (cause) {
		return err(fileError(path, cause));
	}
	return ok({ sha256: hash.digest("hex"), bytes });
}

function fileError(path: string, cause: unknown): StoreError {
	const code = (cause as { code?: string } | null)?.code;
	if (code === "ENOENT") return new StoreError("not_found", `${path} does not exist`, cause);
	return new StoreError("unknown", `could not read ${path}: ${(cause as Error)?.message ?? String(cause)}`, cause);
}

/** Whether the file starts like a SQLite database. A file that does not is `corrupt`, not an error of the call. */
async function hasSqliteHeader(path: string): Promise<Result<boolean, StoreError>> {
	try {
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(SQLITE_HEADER.length);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return ok(bytesRead === buffer.length && buffer.toString("latin1") === SQLITE_HEADER);
		} finally {
			await handle.close();
		}
	} catch (cause) {
		return err(fileError(path, cause));
	}
}

/**
 * The sequence number the next commit would take. It is one read of one table, `durable_metadata`, because pi-durable
 * offers no public way to read a closed store's head and this package must not open the store as a session. This is
 * the only knowledge of pi's schema in this package.
 */
function readHead(database: DatabaseSync): number {
	const row = database.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as
		| { next_seq: number | bigint }
		| undefined;
	if (row === undefined) throw new Error("durable_metadata has no row");
	return Number(row.next_seq);
}

function openReadOnly(path: string): DatabaseSync {
	return new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

async function withDatabase<T>(path: string, use: (database: DatabaseSync) => T): Promise<Result<T, StoreError>> {
	let database: DatabaseSync;
	try {
		database = openReadOnly(path);
	} catch (cause) {
		return err(new StoreError("corrupt", `${path} is not a SQLite database: ${(cause as Error).message}`, cause));
	}
	try {
		return ok(use(database));
	} catch (cause) {
		return err(new StoreError("corrupt", `${path} is not a store: ${(cause as Error).message}`, cause));
	} finally {
		database.close();
	}
}

async function walHasContent(path: string): Promise<boolean> {
	try {
		return (await stat(`${path}-wal`)).size > 0;
	} catch {
		return false;
	}
}

/**
 * The sequence the next commit of the store at `path` takes. One read, on a connection of its own that only reads: the
 * store may be open in this process, and its owner's commits go on.
 */
export async function storeHead(path: string): Promise<Result<number, StoreError>> {
	return withDatabase(path, readHead);
}

/**
 * Seal a store whose owner has closed it: its head, its hash and its size. A store with a write-ahead log that holds
 * content was not closed cleanly and is refused with `not_sealed`: its file alone is not the store.
 */
export async function sealStore(path: string, context: Context): Promise<Result<Seal, StoreError>> {
	const stopped = aborted(context);
	if (stopped) return err(stopped);
	try {
		await stat(path);
	} catch (cause) {
		return err(fileError(path, cause));
	}
	if (await walHasContent(path)) {
		return err(new StoreError("not_sealed", `${path} has a write-ahead log with content: it was not closed cleanly`));
	}
	const header = await hasSqliteHeader(path);
	if (!header.ok) return header;
	if (!header.value) return err(new StoreError("corrupt", `${path} is not a SQLite database`));
	const head = await withDatabase(path, readHead);
	if (!head.ok) return head;
	// Hash after the read: the read must not have changed the file, and a log that appeared meanwhile refuses the seal.
	if (await walHasContent(path)) {
		return err(new StoreError("not_sealed", `${path} grew a write-ahead log while it was sealed`));
	}
	const hashed = await hashFile(path, context);
	if (!hashed.ok) return hashed;
	return ok({ head: head.value, ...hashed.value });
}

/**
 * A consistent copy of a store that its owner still has open, taken with `VACUUM INTO` through a second, read-only
 * connection. The copy appears at `to` whole or not at all. The call blocks this process while SQLite writes the copy.
 */
export async function checkpointStore(path: string, to: string, context: Context): Promise<Result<Seal, StoreError>> {
	const stopped = aborted(context);
	if (stopped) return err(stopped);
	try {
		await stat(to);
		return err(new StoreError("exists", `${to} already exists`));
	} catch {
		// Absent is what is wanted.
	}
	// A name of this call's own: another checkpoint to the same place never writes or removes this one's copy.
	const partial = `${to}.${randomUUID()}.partial`;
	const discard = () => rm(partial, { force: true }).catch(() => {});
	const copied = await withDatabase(path, (database) => {
		database.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
	});
	if (!copied.ok) {
		await discard();
		return copied;
	}
	try {
		// A hard link fails when `to` exists, whoever made it since the check above; a rename would replace it.
		await link(partial, to);
	} catch (cause) {
		await discard();
		if ((cause as { code?: string }).code === "EEXIST") return err(new StoreError("exists", `${to} already exists`));
		return err(
			new StoreError("unknown", `could not put the checkpoint in place: ${(cause as Error).message}`, cause),
		);
	}
	await discard();
	return sealStore(to, context);
}

/**
 * Whether the file at `path` is the store the seal names and a sound SQLite database: size, SHA-256, SQLite's quick
 * check, then the head, in that order. The first difference is the error.
 */
export async function verifyStore(path: string, seal: Seal, context: Context): Promise<Result<void, StoreError>> {
	const stopped = aborted(context);
	if (stopped) return err(stopped);
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch (cause) {
		return err(fileError(path, cause));
	}
	if (size !== seal.bytes) {
		return err(new StoreError("mismatch", `${path} has ${size} bytes, the seal names ${seal.bytes}`));
	}
	const hashed = await hashFile(path, context);
	if (!hashed.ok) return hashed;
	if (hashed.value.sha256 !== seal.sha256) {
		return err(new StoreError("mismatch", `${path} has another SHA-256 than the seal`));
	}
	const checked = await withDatabase(path, (database) => {
		const row = database.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
		if (row.length !== 1 || row[0]?.quick_check !== "ok") {
			throw new Error(`quick_check says ${row.map((line) => line.quick_check).join("; ")}`);
		}
		return readHead(database);
	});
	if (!checked.ok) return checked;
	if (checked.value !== seal.head) {
		return err(new StoreError("mismatch", `${path} has head ${checked.value}, the seal names ${seal.head}`));
	}
	return ok(undefined);
}
