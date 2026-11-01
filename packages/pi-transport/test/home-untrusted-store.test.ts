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

/**
 * A rollback journal that SQLite takes as hot: its header (SQLite's file format, "the rollback journal") and a record for
 * each of `records`, a page number and the page as it was before a transaction that left the database at `pages` pages.
 */
function hotJournal(records: readonly (readonly [number, Buffer])[], pages: number, pageSize: number): Buffer {
	const sector = 4096;
	const nonce = 0x5eed1e55;
	const header = Buffer.alloc(sector);
	Buffer.from("d9d505f920a163d7", "hex").copy(header, 0);
	header.writeUInt32BE(records.length, 8);
	header.writeUInt32BE(nonce, 12);
	header.writeUInt32BE(pages, 16);
	header.writeUInt32BE(sector, 20);
	header.writeUInt32BE(pageSize, 24);
	const body = records.map(([number, page]) => {
		let checksum = nonce;
		for (let at = pageSize - 200; at > 0; at -= 200) checksum = (checksum + (page[at] as number)) >>> 0;
		const record = Buffer.alloc(4 + pageSize + 4);
		record.writeUInt32BE(number, 0);
		page.copy(record, 4);
		record.writeUInt32BE(checksum, 4 + pageSize);
		return record;
	});
	return Buffer.concat([header, ...body]);
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
	it("opens nothing to write: an ATTACH opens no file and makes none (readOnly)", () => {
		const directory = place("writes");
		const file = join(directory, "store.db");
		copyFileSync(base.checkpoint, file);
		const database = openUntrustedConnection(file);
		try {
			const made = join(directory, "made.db");
			expect(() => database.exec(`ATTACH '${made}' AS made`)).toThrow();
			expect(existsSync(made)).toBe(false);
			expect(readdirSync(directory)).toEqual(["store.db"]);
		} finally {
			database.close();
		}
	});

	it("reads back trusted_schema off, cell_size_check on and mmap_size 0, and a view over a pragma's virtual table does not run", () => {
		const file = hostile(base.checkpoint, "trusted", "CREATE VIEW pwn AS SELECT name FROM pragma_table_list;");
		const database = openUntrustedConnection(file);
		try {
			const read = (pragma: string) =>
				Number((database.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[pragma]);
			expect([read("trusted_schema"), read("cell_size_check"), read("mmap_size")]).toEqual([0, 1, 0]);
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

	it("stops at a page whose cells run off its end (cell_size_check), where the same connection without it walks them", () => {
		const bytes = readFileSync(base.checkpoint);
		const pageSize = bytes.readUInt16BE(16) === 1 ? 65536 : bytes.readUInt16BE(16);
		const check = (file: string, cellSizeCheck: boolean) => {
			const database = openUntrustedConnection(file);
			try {
				if (!cellSizeCheck) database.exec("PRAGMA cell_size_check = OFF");
				return (database.prepare("PRAGMA quick_check").all() as { quick_check: string }[])
					.map((row) => row.quick_check)
					.join("\n");
			} catch (cause) {
				return `threw: ${String(cause)}`;
			} finally {
				database.close();
			}
		};
		let stopped = 0;
		for (let page = 1; (page + 1) * pageSize <= bytes.length; page++) {
			const damaged = Buffer.from(bytes);
			damaged.fill(0xa5, page * pageSize + 100, (page + 1) * pageSize);
			const file = join(place(`cells-${page}`), "store.db");
			writeFileSync(file, damaged);
			const walked = check(file, false);
			if (walked.startsWith("threw") || !/Extends off end of page/.test(walked)) continue;
			if (/^threw: .*malformed/.test(check(file, true))) stopped += 1;
		}
		expect(stopped, "a page the connection stops at, and walks with cell_size_check off").toBeGreaterThan(0);
	});

	it("loads no extension (allowExtension: false)", () => {
		const directory = place("extension");
		const file = join(directory, "store.db");
		copyFileSync(base.checkpoint, file);
		const database = openUntrustedConnection(file);
		try {
			expect(() => database.loadExtension(join(directory, "library"))).toThrow(/not allowed/);
			expect(() => database.prepare(`SELECT load_extension('${join(directory, "library")}')`).get()).toThrow();
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

	it("a hot journal beside the file, which would roll a trigger into it", async () => {
		// A hot journal that holds the pages of the same store with a trigger as the pages "before" is what a crash
		// between the two would leave, and SQLite rolls it in.
		const clean = readFileSync(base.checkpoint);
		const pageSize = clean.readUInt16BE(16) === 1 ? 65536 : clean.readUInt16BE(16);
		const triggered = readFileSync(
			hostile(
				base.checkpoint,
				"journal-source",
				"CREATE TRIGGER pwn AFTER INSERT ON entries BEGIN DELETE FROM entries; END;",
			),
		);
		expect(triggered.length).toBe(clean.length);
		const records: [number, Buffer][] = [];
		for (let at = 0; at < clean.length; at += pageSize) {
			const page = triggered.subarray(at, at + pageSize);
			if (!page.equals(clean.subarray(at, at + pageSize))) records.push([at / pageSize + 1, page]);
		}
		expect(records.length).toBeGreaterThan(0);
		const journal = hotJournal(records, clean.length / pageSize, pageSize);
		const placed = (name: string) => {
			const file = join(place(name), "store.db");
			writeFileSync(file, clean);
			writeFileSync(`${file}-journal`, journal);
			return file;
		};
		// Live: a connection that may write rolls it back into the file, and the trigger is there.
		const control = placed("journal-control");
		const writer = new DatabaseSync(control);
		try {
			expect(writer.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all()).toEqual([
				{ name: "pwn" },
			]);
		} finally {
			writer.close();
		}
		const file = placed("journal");
		const before = snapshot(file);
		getOrThrow(await verifyStore(file, sealOf(file, base.seal.head), context));
		expect(snapshot(file)).toEqual(before);
		expect(readFileSync(`${file}-journal`).equals(journal)).toBe(true);
		// The replay reads the main file alone too, and removes the journal, which is not the new store's.
		getOrThrow(await replayCommits(file, base.seal.head, base.since, context));
		expect(readdirSync(dirname(file))).toEqual(["store.db"]);
		expect(dump(file)).toEqual(dump(base.live));
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
			const database = openUntrustedConnection(file);
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
