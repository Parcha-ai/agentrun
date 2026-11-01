import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type DatabaseSyncOptions } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LogEntry, replayCommits } from "../src/home/commit-log.ts";
import {
	checkpointStore,
	DEFAULT_MAX_STORE_BYTES,
	openUntrustedConnection,
	type Seal,
	sealStore,
	verifyStore,
} from "../src/home/store.ts";
import { tapStorage } from "./commit-tap.ts";

// A box is not trusted, and the store a host verifies and replays before a restore is a file a box made. Each case
// builds a hostile SQLite file in the test and shows it refused cleanly (a result, never a throw or a crash), with
// nothing in it run and no file of the host touched; and each setting of the connection is shown in force on its own.

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-untrusted-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
let counter = 0;
/** A directory of its own for each file: what appears beside a file is part of what a case checks. */
const place = (name: string) => {
	const directory = join(root, `${name}-${counter++}`);
	mkdirSync(directory);
	return directory;
};

/** Node 24's binding has defensive mode, limits and an authorizer; Node 22's has none of the three. */
const node24 = typeof (DatabaseSync.prototype as { enableDefensive?: unknown }).enableDefensive === "function";

/** The connection with its authorizer taken off (Node 24), so that a case sees the setting beneath it. */
function bare(path: string): DatabaseSync {
	const database = openUntrustedConnection(path) as DatabaseSync & { setAuthorizer?: (callback: null) => void };
	database.setAuthorizer?.(null);
	return database;
}

/** The file's bytes and every name beside it: what a refusal must leave as it found. */
function snapshot(file: string) {
	return {
		sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
		names: readdirSync(dirname(file)).sort(),
	};
}

function sealOf(file: string, head: number): Seal {
	const bytes = readFileSync(file);
	return { head, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Every row of every table of a store, read on a plain connection of the test's own. */
function dump(path: string): Record<string, string[]> {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const tables = (
			database
				.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all() as { name: string }[]
		).map((row) => row.name);
		const out: Record<string, string[]> = {};
		for (const table of tables) {
			out[table] = (database.prepare(`SELECT rowid AS r, * FROM "${table}" ORDER BY rowid`).all() as object[]).map(
				(row) => JSON.stringify(row),
			);
		}
		return out;
	} finally {
		database.close();
	}
}

/** A session that commits `before` entries, is checkpointed (a box's store), and commits `after` more, then closes. */
async function session(name: string, before: number, after: number) {
	const directory = place(name);
	const live = join(directory, "live.db");
	const checkpoint = join(place(`${name}-checkpoint`), "store.db");
	const shipped: LogEntry[] = [];
	const opened = createSession(tapStorage(await openNodeSqliteStorage(live), (entry) => shipped.push(entry)));
	const conversation = await opened.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		context,
	);
	const note = (n: number) =>
		opened.commit(
			(tx) => tx.appendEntry(conversation.id, { kind: "note", data: { n, text: `entry ${n}` } }),
			context,
		);
	for (let n = 0; n < before; n++) await note(n);
	const seal = getOrThrow(await checkpointStore(live, checkpoint, context));
	for (let n = before; n < before + after; n++) await note(n);
	await opened.close(context);
	return { live, checkpoint, seal, since: shipped.filter((entry) => entry.commit >= seal.head) };
}

/** A copy of `from` in a directory of its own, changed by `sql` the way a box may change its own file. */
function hostile(from: string, name: string, sql: string): string {
	const file = join(place(name), "store.db");
	copyFileSync(from, file);
	// Node 24 opens a connection defensive unless told otherwise, and a box makes its file as it likes.
	const database = new DatabaseSync(file, { defensive: false } as DatabaseSyncOptions);
	try {
		database.exec(sql);
	} finally {
		database.close();
	}
	return file;
}

let base: Awaited<ReturnType<typeof session>>;
beforeAll(async () => {
	base = await session("base", 6, 3);
});

/**
 * Verify the file and replay the base session's shipped commits into it, as a restore does: both must be refused, the
 * file and its directory left as they were, and nothing of the commits applied.
 */
async function refused(file: string, seal: Seal = sealOf(file, base.seal.head)) {
	const before = snapshot(file);
	const verified = await verifyStore(file, seal, context);
	const replayed = await replayCommits(file, base.seal.head, base.since, context);
	expect(snapshot(file)).toEqual(before);
	expect(replayed.ok).toBe(false);
	if (replayed.ok) throw new Error("replayed");
	expect(replayed.error.code).toBe("failed");
	expect(replayed.error.applied).toBe(base.seal.head - 1);
	if (verified.ok) throw new Error("verified");
	return { verify: verified.error, replay: replayed.error };
}

describe("an ordinary store a box made", () => {
	it("verifies, and replays into a store this host makes that holds every row the session had", async () => {
		getOrThrow(await verifyStore(base.checkpoint, base.seal, context));
		const copy = join(place("ordinary"), "store.db");
		copyFileSync(base.checkpoint, copy);
		const inode = statSync(copy).ino;
		const replayed = getOrThrow(await replayCommits(copy, base.seal.head, base.since, context));
		expect(replayed.count).toBe(base.since.length);
		// The box's file was never opened to write: another file, made here, took its place, and nothing is left beside it.
		expect(statSync(copy).ino).not.toBe(inode);
		expect(readdirSync(dirname(copy))).toEqual(["store.db"]);
		expect(dump(copy)).toEqual(dump(base.live));
		const live = getOrThrow(await sealStore(base.live, context));
		expect(getOrThrow(await sealStore(copy, context)).head).toBe(live.head);
	});

	it("is read through no setting it carries: a store in WAL mode opens read through a lock, and nothing appears beside it", async () => {
		// pi-durable leaves its store in WAL mode; a reader that is not immutable makes -wal and -shm beside it.
		const directory = place("wal");
		const file = join(directory, "store.db");
		copyFileSync(base.live, file);
		expect(readFileSync(file).subarray(18, 20)).toEqual(Buffer.from([2, 2]));
		const head = getOrThrow(await sealStore(base.live, context)).head;
		const database = openUntrustedConnection(file);
		try {
			const row = database.prepare("SELECT next_seq FROM durable_metadata").get() as { next_seq: number };
			expect(Number(row.next_seq)).toBe(head);
			expect(readdirSync(directory)).toEqual(["store.db"]);
		} finally {
			database.close();
		}
		// A rollback-journal copy (as a checkpoint is) held under another connection's exclusive lock still reads.
		const locked = join(place("locked"), "store.db");
		copyFileSync(base.checkpoint, locked);
		const holder = new DatabaseSync(locked);
		try {
			holder.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
			const reader = openUntrustedConnection(locked);
			try {
				expect(reader.prepare("SELECT next_seq FROM durable_metadata").get()).toBeDefined();
			} finally {
				reader.close();
			}
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}
	});
});

describe("each setting of the connection, on its own", () => {
	it("writes nothing: no temporary table, and an ATTACH opens no file and makes none (query_only, readOnly)", () => {
		const directory = place("writes");
		const file = join(directory, "store.db");
		copyFileSync(base.checkpoint, file);
		const database = bare(file);
		try {
			expect(() => database.exec("CREATE TEMP TABLE t (x)")).toThrow(/readonly/);
			const made = join(directory, "made.db");
			expect(() => database.exec(`ATTACH '${made}' AS made`)).toThrow();
			expect(existsSync(made)).toBe(false);
			expect(readdirSync(directory)).toEqual(["store.db"]);
		} finally {
			database.close();
		}
	});

	it("reads back trusted_schema off, query_only on and cell_size_check on, and a view over a pragma's virtual table does not run", () => {
		const file = hostile(base.checkpoint, "trusted", "CREATE VIEW pwn AS SELECT name FROM pragma_table_list;");
		const database = bare(file);
		try {
			const read = (pragma: string) =>
				Number((database.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[pragma]);
			expect([read("trusted_schema"), read("query_only"), read("cell_size_check")]).toEqual([0, 1, 1]);
			expect(() => database.prepare("SELECT * FROM pwn").all()).toThrow(/unsafe use of virtual table/);
		} finally {
			database.close();
		}
		// The same view on a connection that trusts the schema runs: the file is a live case, not a broken one.
		const trusting = new DatabaseSync(file, { readOnly: true });
		try {
			expect(trusting.prepare("SELECT * FROM pwn").all().length).toBeGreaterThan(0);
		} finally {
			trusting.close();
		}
	});

	it("stops at a page whose cells run off its end (cell_size_check), where a plain reader walks them", () => {
		const bytes = readFileSync(base.checkpoint);
		const pageSize = bytes.readUInt16BE(16) === 1 ? 65536 : bytes.readUInt16BE(16);
		let stopped = 0;
		for (let page = 1; (page + 1) * pageSize <= bytes.length; page++) {
			const damaged = Buffer.from(bytes);
			damaged.fill(0xa5, page * pageSize + 100, (page + 1) * pageSize);
			const file = join(place(`cells-${page}`), "store.db");
			writeFileSync(file, damaged);
			const plain = new DatabaseSync(file, { readOnly: true });
			let walked = "";
			try {
				walked = (plain.prepare("PRAGMA quick_check").all() as { quick_check: string }[])
					.map((row) => row.quick_check)
					.join("\n");
			} catch {
				// A page no reader gets past: not the one this case wants.
			} finally {
				plain.close();
			}
			if (!/Extends off end of page/.test(walked)) continue;
			const database = bare(file);
			try {
				database.prepare("PRAGMA quick_check").all();
			} catch (cause) {
				expect(String(cause)).toMatch(/malformed/);
				stopped += 1;
			} finally {
				database.close();
			}
		}
		expect(stopped, "a page a plain reader walks and this connection stops at").toBeGreaterThan(0);
	});

	it("loads no extension (allowExtension: false)", () => {
		const directory = place("extension");
		const file = join(directory, "store.db");
		copyFileSync(base.checkpoint, file);
		const database = bare(file);
		try {
			expect(() => database.loadExtension(join(directory, "library"))).toThrow(/not allowed/);
			expect(() => database.prepare(`SELECT load_extension('${join(directory, "library")}')`).get()).toThrow();
		} finally {
			database.close();
		}
	});

	it.runIf(node24)("is defensive (Node 24 and later): writable_schema cannot be turned on", () => {
		const file = join(place("defensive"), "store.db");
		copyFileSync(base.checkpoint, file);
		const database = bare(file);
		try {
			database.exec("PRAGMA writable_schema = ON");
			expect((database.prepare("PRAGMA writable_schema").get() as { writable_schema: number }).writable_schema).toBe(
				0,
			);
		} finally {
			database.close();
		}
	});

	it.runIf(node24)("attaches nothing (Node 24 and later): not even a file that exists", () => {
		const file = join(place("attach"), "store.db");
		copyFileSync(base.checkpoint, file);
		const database = bare(file);
		try {
			expect(() => database.exec(`ATTACH '${base.live}' AS other`)).toThrow(/too many attached databases/);
		} finally {
			database.close();
		}
	});

	it.runIf(node24)("lets only a select, a read and the quick check through its authorizer (Node 24 and later)", () => {
		const file = hostile(base.checkpoint, "authorizer", "CREATE VIEW plain AS SELECT id FROM entries;");
		const database = openUntrustedConnection(file);
		try {
			expect(database.prepare("SELECT next_seq FROM durable_metadata").get()).toBeDefined();
			expect(database.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
			expect(() => database.exec("PRAGMA query_only = OFF")).toThrow(/not authorized/);
			expect(() => database.prepare("SELECT count(*) FROM entries").get()).toThrow(/not authorized/);
			// A read inside a view is refused by name.
			expect(() => database.prepare("SELECT * FROM plain").all()).toThrow(/access to entries.id is prohibited/);
			expect(() => database.exec(`ATTACH '${base.live}' AS other`)).toThrow(/not authorized/);
		} finally {
			database.close();
		}
	});
});

describe("a hostile store is refused cleanly, with nothing in it run and no file of the host touched", () => {
	it("a trigger", async () => {
		const file = hostile(
			base.checkpoint,
			"trigger",
			`CREATE TRIGGER pwn AFTER INSERT ON entries BEGIN UPDATE conversations SET record = '{"pwned":true}'; END;`,
		);
		// Live: a store pi opens to write fires it on the first commit that appends an entry.
		const control = join(place("trigger-control"), "store.db");
		copyFileSync(file, control);
		const opened = await openNodeSqliteStorage(control);
		await opened.commit(base.since[0]?.writes ?? [], context);
		await opened.close(context);
		expect(dump(control).conversations?.[0]).toContain("pwned");
		const { verify, replay } = await refused(file);
		expect(verify.code).toBe("refused");
		expect(verify.message).toMatch(/trigger "pwn"/);
		expect(replay.message).toMatch(/trigger "pwn"/);
	});

	it("a view calling a function, in the place of the table the head is read from", async () => {
		const file = hostile(
			base.checkpoint,
			"view",
			`DROP TABLE durable_metadata;
			CREATE VIEW durable_metadata AS SELECT 1 AS singleton, '2' AS next_id, abs(-${base.seal.head}) AS next_seq;`,
		);
		// Live: a plain reader gets the head the seal names from it, the function run.
		const plain = new DatabaseSync(file, { readOnly: true });
		try {
			expect(
				Number((plain.prepare("SELECT next_seq FROM durable_metadata").get() as { next_seq: number }).next_seq),
			).toBe(base.seal.head);
		} finally {
			plain.close();
		}
		const { verify } = await refused(file);
		expect(verify.code).toBe("refused");
		expect(verify.message).toMatch(/view "durable_metadata"/);
	});

	it("a schema that relies on trusted_schema: a view over a pragma's virtual table", async () => {
		const file = hostile(base.checkpoint, "pragma-view", "CREATE VIEW pwn AS SELECT name FROM pragma_table_list;");
		const { verify } = await refused(file);
		expect(verify.code).toBe("refused");
		expect(verify.message).toMatch(/view "pwn"/);
	});

	it("an ATTACH in the schema, and a view that names another database", async () => {
		const target = join(place("attach-target"), "attached.db");
		const attaching = hostile(
			base.checkpoint,
			"attach-entry",
			`PRAGMA writable_schema = ON;
			INSERT INTO sqlite_schema VALUES ('table', 'pwn', 'pwn', 0, 'ATTACH DATABASE ''${target}'' AS pwn');`,
		);
		const first = await refused(attaching);
		expect(first.verify.code).toBe("corrupt");
		expect(first.verify.message).toMatch(/malformed database schema/);
		expect(existsSync(target)).toBe(false);
		const naming = hostile(
			base.checkpoint,
			"attach-view",
			`PRAGMA writable_schema = ON;
			INSERT INTO sqlite_schema VALUES ('view', 'pwn', 'pwn', 0, 'CREATE VIEW pwn AS SELECT * FROM other.secret');`,
		);
		const second = await refused(naming);
		// SQLite itself refuses a view of the main database that names another one, as it parses the schema.
		expect(second.verify.code).toBe("corrupt");
		expect(second.verify.message).toMatch(/view pwn cannot reference objects in database other/);
		expect(readdirSync(dirname(target))).toEqual([]);
	});

	it("a table of the file's own, beside the store's", async () => {
		const file = hostile(
			base.checkpoint,
			"extra",
			"CREATE TABLE extra (x); INSERT INTO extra VALUES ('of the box');",
		);
		const { verify } = await refused(file);
		expect(verify.code).toBe("refused");
		expect(verify.message).toMatch(/table "extra"/);
	});

	it("a damaged page, a truncated file, and pages of noise after a header", async () => {
		const bytes = readFileSync(base.checkpoint);
		const pageSize = bytes.readUInt16BE(16) === 1 ? 65536 : bytes.readUInt16BE(16);
		const cases: string[] = [];
		// A damaged page that this package's own connection reads the schema and the head through, so that only the quick
		// check can tell.
		for (let page = 1; (page + 1) * pageSize <= bytes.length && cases.length === 0; page++) {
			const damaged = Buffer.from(bytes);
			damaged.fill(0xa5, page * pageSize + 100, (page + 1) * pageSize);
			const file = join(place(`damaged-${page}`), "store.db");
			writeFileSync(file, damaged);
			const database = bare(file);
			try {
				database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema").all();
				database.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get();
			} catch {
				database.close();
				continue;
			}
			try {
				const check = database.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
				if (!(check.length === 1 && check[0]?.quick_check === "ok")) cases.push(file);
			} catch {
				cases.push(file);
			} finally {
				database.close();
			}
		}
		expect(cases.length, "a page only the quick check flags").toBe(1);
		const truncated = join(place("truncated"), "store.db");
		writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
		const noise = join(place("noise"), "store.db");
		const noisy = Buffer.alloc(4 * pageSize, 0x5a);
		bytes.copy(noisy, 0, 0, 100);
		writeFileSync(noise, noisy);
		for (const file of [cases[0] as string, truncated, noise]) {
			const { verify } = await refused(file);
			expect(verify.code, file).toBe("corrupt");
		}
		const damaged = await verifyStore(cases[0] as string, sealOf(cases[0] as string, base.seal.head), context);
		expect(damaged.ok ? "" : damaged.error.message).toMatch(/quick_check says|malformed/);
	});

	it("a file past the size limit, and one that is not a regular file", async () => {
		// Sparse: past the default limit without writing a gigabyte. SQLite never sees it.
		const huge = join(place("huge"), "store.db");
		const descriptor = openSync(huge, "w");
		try {
			writeSync(descriptor, readFileSync(base.checkpoint).subarray(0, 100));
			ftruncateSync(descriptor, DEFAULT_MAX_STORE_BYTES + 1);
		} finally {
			closeSync(descriptor);
		}
		const seal = { head: base.seal.head, bytes: DEFAULT_MAX_STORE_BYTES + 1, sha256: "0".repeat(64) };
		const started = performance.now();
		const verified = await verifyStore(huge, seal, context);
		expect(verified.ok ? "" : verified.error.code).toBe("refused");
		expect(verified.ok ? "" : verified.error.message).toMatch(/more than the 1073741824 a store may have/);
		const replayed = await replayCommits(huge, base.seal.head, base.since, context);
		expect(replayed.ok ? "" : replayed.error.message).toMatch(/more than the 1073741824/);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(readdirSync(dirname(huge))).toEqual(["store.db"]);
		// An ordinary store over a limit the caller sets is refused too, before a byte is hashed.
		const small = { maxBytes: base.seal.bytes - 1 };
		const limited = await verifyStore(base.checkpoint, base.seal, context, small);
		expect(limited.ok ? "" : limited.error.code).toBe("refused");
		const copy = join(place("limited"), "store.db");
		copyFileSync(base.checkpoint, copy);
		const replayedSmall = await replayCommits(copy, base.seal.head, base.since, context, small);
		expect(replayedSmall.ok ? "" : replayedSmall.error.message).toMatch(/a store may have/);
		const link = join(place("symlink"), "store.db");
		symlinkSync(base.checkpoint, link);
		const linked = await verifyStore(link, base.seal, context);
		expect(linked.ok ? "" : linked.error.message).toMatch(/not a regular file/);
	});
});
