import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, open, rename, rm, stat } from "node:fs/promises";
import { DatabaseSync, type DatabaseSyncOptions, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const SQLITE_HEADER = "SQLite format 3\0";
const BUSY_TIMEOUT_MS = 5_000;
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * The most bytes a store that came from elsewhere may have for this package to open it: 1 GiB. A box makes the stores a
 * host verifies and replays, and one larger than this is refused before SQLite reads a byte of it.
 */
export const DEFAULT_MAX_STORE_BYTES = 2 ** 30;

/** How a store that came from elsewhere is opened (`verifyStore`, `replayCommits`). */
export type UntrustedStoreOptions = {
	/** The most bytes the file may have. Default `DEFAULT_MAX_STORE_BYTES`. */
	readonly maxBytes?: number;
};

/**
 * Why a store call failed. `not_sealed` means the store was not closed cleanly, `mismatch` that a copy is not the
 * sealed store, `corrupt` that SQLite does not accept the file, `exists` that a checkpoint would overwrite a file,
 * `refused` that a store from elsewhere is not one this package opens: not a regular file, over the size limit, or with a
 * schema other than the one pi-durable makes.
 */
export type StoreErrorCode =
	| "aborted"
	| "not_found"
	| "not_sealed"
	| "mismatch"
	| "corrupt"
	| "exists"
	| "invalid"
	| "refused"
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
		| { next_seq: unknown }
		| undefined;
	if (row === undefined) throw new Error("durable_metadata has no row");
	const head = typeof row.next_seq === "bigint" ? Number(row.next_seq) : row.next_seq;
	if (typeof head !== "number" || !Number.isSafeInteger(head) || head < 1) {
		throw new Error("durable_metadata.next_seq is not a sequence number");
	}
	return head;
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

// A store that came from elsewhere. A box makes the stores a host checks before a restore (`verifyStore`) and replays
// commits into (`replayCommits`), and a box is not trusted: its file is input to this process's SQLite. Such a file is
// opened here and nowhere else, read-only and defensive, and only once its schema is the one pi-durable makes.

/** node:sqlite's options and methods past Node 22's typings. Node 24 has them; Node 22's binding has none of them. */
type HardenedOptions = DatabaseSyncOptions & {
	readonly defensive?: boolean;
	readonly limits?: { readonly attach?: number };
};
type HardenedDatabase = DatabaseSync & {
	readonly enableDefensive?: (active: boolean) => void;
	readonly setAuthorizer?: (callback: ((action: number, ...names: (string | null)[]) => number) | null) => void;
};

// SQLite's authorizer codes (sqlite3.h).
const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const SQLITE_PRAGMA = 19;
const SQLITE_READ = 20;
const SQLITE_SELECT = 21;

/**
 * What a statement of this package on such a store may do: select, read a column of the main database, and run the quick
 * check. Nothing inside a trigger or a view, no write, no attach, no function, no other pragma.
 */
function authorize(
	action: number,
	first: string | null = null,
	_second: string | null = null,
	database: string | null = null,
	inside: string | null = null,
): number {
	if (inside !== null) return SQLITE_DENY;
	if (action === SQLITE_SELECT) return SQLITE_OK;
	if (action === SQLITE_READ && database === "main") return SQLITE_OK;
	if (action === SQLITE_PRAGMA && first === "quick_check") return SQLITE_OK;
	return SQLITE_DENY;
}

/** The pragmas set on such a connection before anything reads its schema, and the value each must read back. */
const UNTRUSTED_PRAGMAS = [
	// Functions and virtual tables not marked innocuous are refused in a trigger or a view.
	["trusted_schema", 0],
	// No statement on the connection writes, the temporary database included.
	["query_only", 1],
	// A b-tree cell whose size does not fit its page is corruption, found when the page is read.
	["cell_size_check", 1],
] as const;

/**
 * A connection to a store that came from elsewhere, with every setting this package opens one with and nothing checked
 * yet: `withUntrustedStore` checks the file first and the schema after. Exported for the tests that show each setting.
 *
 * - `immutable=1` in the file's URI: no lock is taken, and no journal or write-ahead log is read or made beside the file.
 * - `readOnly`: the file is never opened to write, nor is a database an `ATTACH` would name.
 * - `allowExtension: false`: no extension loads.
 * - `PRAGMA trusted_schema = OFF`, `query_only = ON`, `cell_size_check = ON`, each read back.
 * - Node 24 and later, where the binding has them: `defensive` (SQLITE_DBCONFIG_DEFENSIVE), `limits.attach = 0` (no
 *   `ATTACH`), and an authorizer that allows only `authorize`'s actions. Node 22's binding has none of the three.
 */
export function openUntrustedConnection(path: string): DatabaseSync {
	const location = pathToFileURL(path);
	location.searchParams.set("immutable", "1");
	const options: HardenedOptions = {
		readOnly: true,
		allowExtension: false,
		timeout: 0,
		defensive: true,
		limits: { attach: 0 },
	};
	const database = new DatabaseSync(location, options) as HardenedDatabase;
	try {
		for (const [pragma, value] of UNTRUSTED_PRAGMAS) database.exec(`PRAGMA ${pragma} = ${value}`);
		for (const [pragma, value] of UNTRUSTED_PRAGMAS) {
			const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
			if (Number(row?.[pragma]) !== value) throw new Error(`PRAGMA ${pragma} did not take`);
		}
		database.enableDefensive?.(true);
		database.setAuthorizer?.(authorize);
	} catch (cause) {
		database.close();
		throw cause;
	}
	return database;
}

type SchemaRow = { readonly type: unknown; readonly name: unknown; readonly tbl_name: unknown; readonly sql: unknown };
const SCHEMA_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name";

let storeSchemaOnce: Promise<readonly SchemaRow[]> | undefined;

/**
 * The schema pi-durable makes, read once from an empty store it makes in memory: whatever pi-durable this process loads,
 * not a copy of it in this package.
 */
function storeSchema(): Promise<readonly SchemaRow[]> {
	if (storeSchemaOnce === undefined) {
		const made = (async () => {
			const database = await openNodeSqliteDatabase(":memory:");
			const storage = await SqliteStorage.open(database);
			try {
				return await database.all<SchemaRow>(SCHEMA_SQL);
			} finally {
				await storage.close(BACKGROUND_CONTEXT);
			}
		})();
		storeSchemaOnce = made;
		made.catch(() => {
			if (storeSchemaOnce === made) storeSchemaOnce = undefined;
		});
	}
	return storeSchemaOnce;
}

/** A name from a file, quoted and cut short, for a message. */
const named = (value: unknown) => JSON.stringify(String(value).slice(0, 80));

/** Why the schema `found` is not the store's, or `undefined` when it is the same, object for object and text for text. */
function schemaProblem(found: readonly SchemaRow[], wanted: readonly SchemaRow[]): string | undefined {
	const key = (row: SchemaRow) => `${String(row.type)} ${named(row.name)}`;
	const left = new Map(wanted.map((row) => [key(row), row]));
	for (const row of found) {
		const match = left.get(key(row));
		if (match === undefined) return `it has the ${key(row).slice(0, 120)}, which a store does not`;
		if (match.tbl_name !== row.tbl_name || match.sql !== row.sql) return `its ${key(row)} is not a store's`;
		left.delete(key(row));
	}
	const missing = left.keys().next();
	return missing.done ? undefined : `it has no ${missing.value}`;
}

function quickCheck(database: DatabaseSync): void {
	const rows = database.prepare("PRAGMA quick_check").all() as { quick_check: unknown }[];
	if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
		throw new Error(
			`quick_check says ${rows
				.slice(0, 5)
				.map((row) => String(row.quick_check).slice(0, 200))
				.join("; ")}`,
		);
	}
}

/** The size of the file at `path` when it is a regular file no larger than the limit: refused otherwise. */
async function untrustedSize(
	path: string,
	options: UntrustedStoreOptions | undefined,
): Promise<Result<number, StoreError>> {
	const limit = options?.maxBytes ?? DEFAULT_MAX_STORE_BYTES;
	let facts: Awaited<ReturnType<typeof lstat>>;
	try {
		facts = await lstat(path);
	} catch (cause) {
		return err(fileError(path, cause));
	}
	if (!facts.isFile()) return err(new StoreError("refused", `${path} is not a regular file`));
	if (facts.size > limit) {
		return err(new StoreError("refused", `${path} has ${facts.size} bytes, more than the ${limit} a store may have`));
	}
	return ok(facts.size);
}

/**
 * Open a store that came from elsewhere, check it, and give `use` the connection; the connection is closed after. In
 * order, before `use` runs: a regular file no larger than `maxBytes` (`refused`), the SQLite header (`corrupt`), the
 * connection of `openUntrustedConnection`, a schema the same as the one pi-durable makes (`refused`: no trigger, view,
 * virtual table or other object of the file's own is ever compiled), and SQLite's quick check (`corrupt`), which runs
 * after the schema check so that it evaluates only pi-durable's own constraints. The only place this package opens such
 * a file.
 */
async function withUntrustedStore<T>(
	path: string,
	options: UntrustedStoreOptions | undefined,
	use: (database: DatabaseSync) => T,
): Promise<Result<T, StoreError>> {
	const size = await untrustedSize(path, options);
	if (!size.ok) return size;
	const header = await hasSqliteHeader(path);
	if (!header.ok) return header;
	if (!header.value) return err(new StoreError("corrupt", `${path} is not a SQLite database`));
	let wanted: readonly SchemaRow[];
	try {
		wanted = await storeSchema();
	} catch (cause) {
		return err(
			new StoreError("unknown", `could not read the schema pi-durable makes: ${(cause as Error).message}`, cause),
		);
	}
	let database: DatabaseSync;
	try {
		database = openUntrustedConnection(path);
	} catch (cause) {
		return err(new StoreError("corrupt", `${path} is not a SQLite database: ${(cause as Error).message}`, cause));
	}
	try {
		let found: readonly SchemaRow[];
		try {
			found = database.prepare(SCHEMA_SQL).all() as SchemaRow[];
		} catch (cause) {
			return err(
				new StoreError("corrupt", `${path} has a schema SQLite cannot read: ${(cause as Error).message}`, cause),
			);
		}
		const problem = schemaProblem(found, wanted);
		if (problem !== undefined) return err(new StoreError("refused", `${path} is not a store: ${problem}`));
		quickCheck(database);
		return ok(use(database));
	} catch (cause) {
		return err(new StoreError("corrupt", `${path} is not a store: ${(cause as Error).message}`, cause));
	} finally {
		database.close();
	}
}

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Copy every row of each table of pi-durable's schema from `source` to `target`, rowid and columns as they are, in one
 * transaction. The tables are the schema's and the columns `target`'s, never the source's own; the source is read only.
 */
function copyRows(source: DatabaseSync, target: DatabaseSync, tables: readonly string[]): void {
	target.exec("BEGIN IMMEDIATE");
	try {
		for (const table of tables) {
			const name = quoteName(table);
			const columns = (target.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((column) =>
				quoteName(column.name),
			);
			const picked = ["rowid", ...columns];
			const read = source.prepare(
				`SELECT ${picked.map((column, index) => `${column} AS c${index}`).join(", ")} FROM ${name} ORDER BY rowid`,
			);
			read.setReadBigInts(true);
			const write = target.prepare(
				`INSERT INTO ${name} (${picked.join(", ")}) VALUES (${picked.map(() => "?").join(", ")})`,
			);
			target.exec(`DELETE FROM ${name}`);
			for (const row of read.iterate()) {
				write.run(
					...picked.map((_, index) => (row as Record<string, SQLInputValue>)[`c${index}`] as SQLInputValue),
				);
			}
		}
		target.exec("COMMIT");
	} catch (cause) {
		target.exec("ROLLBACK");
		throw cause;
	}
}

/**
 * Put a store this process makes in the place of the store at `path`, which came from elsewhere: pi-durable makes an
 * empty store, the rows of each table its schema names are read from `path` (`withUntrustedStore`, read-only) and written
 * into it, and it takes `path`'s place. Nothing of the old file but those rows is kept: no page, no schema object, no
 * setting, and no journal or write-ahead log beside it. On an error `path` stays as it was. Returns the store's head.
 */
export async function rebuildStore(
	path: string,
	context: Context,
	options?: UntrustedStoreOptions,
): Promise<Result<number, StoreError>> {
	const stopped = aborted(context);
	if (stopped) return err(stopped);
	let wanted: readonly SchemaRow[];
	try {
		wanted = await storeSchema();
	} catch (cause) {
		return err(
			new StoreError("unknown", `could not read the schema pi-durable makes: ${(cause as Error).message}`, cause),
		);
	}
	const tables = wanted
		.filter((row) => row.type === "table" && !String(row.name).startsWith("sqlite_"))
		.map((row) => String(row.name));
	const fresh = `${path}.${randomUUID()}.rebuild`;
	const sidecars = ["-wal", "-shm", "-journal"];
	const discard = async () => {
		for (const suffix of ["", ...sidecars]) await rm(`${fresh}${suffix}`, { force: true }).catch(() => {});
	};
	try {
		await (await openNodeSqliteStorage(fresh)).close(context);
	} catch (cause) {
		await discard();
		return err(new StoreError("unknown", `could not make a store at ${fresh}: ${(cause as Error).message}`, cause));
	}
	let copied: Result<number, StoreError>;
	let target: DatabaseSync;
	try {
		target = new DatabaseSync(fresh, { timeout: BUSY_TIMEOUT_MS });
	} catch (cause) {
		await discard();
		return err(
			new StoreError("unknown", `could not open the store made at ${fresh}: ${(cause as Error).message}`, cause),
		);
	}
	try {
		copied = await withUntrustedStore(path, options, (source) => {
			copyRows(source, target, tables);
			return readHead(source);
		});
	} finally {
		target.close();
	}
	if (!copied.ok) {
		await discard();
		return copied;
	}
	try {
		// The old file's journal and log are not the new file's, and SQLite would read them as its own.
		for (const suffix of sidecars) await rm(`${path}${suffix}`, { force: true });
		await rename(fresh, path);
	} catch (cause) {
		await discard();
		return err(
			new StoreError("unknown", `could not put the rebuilt store in place: ${(cause as Error).message}`, cause),
		);
	}
	await discard();
	return ok(copied.value);
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
 * Whether the file at `path` is the store the seal names and a sound SQLite database: a regular file within
 * `maxBytes`, its size, its SHA-256, a schema the same as the one pi-durable makes, SQLite's quick check, then the head,
 * in that order. The first difference is the error. The file may come from a box, so it is read as `withUntrustedStore`
 * reads one: only read-only and defensive, and its schema checked before anything else of it is read.
 */
export async function verifyStore(
	path: string,
	seal: Seal,
	context: Context,
	options?: UntrustedStoreOptions,
): Promise<Result<void, StoreError>> {
	const stopped = aborted(context);
	if (stopped) return err(stopped);
	const size = await untrustedSize(path, options);
	if (!size.ok) return size;
	if (size.value !== seal.bytes) {
		return err(new StoreError("mismatch", `${path} has ${size.value} bytes, the seal names ${seal.bytes}`));
	}
	const hashed = await hashFile(path, context);
	if (!hashed.ok) return hashed;
	if (hashed.value.sha256 !== seal.sha256) {
		return err(new StoreError("mismatch", `${path} has another SHA-256 than the seal`));
	}
	const checked = await withUntrustedStore(path, options, readHead);
	if (!checked.ok) return checked;
	if (checked.value !== seal.head) {
		return err(new StoreError("mismatch", `${path} has head ${checked.value}, the seal names ${seal.head}`));
	}
	return ok(undefined);
}
