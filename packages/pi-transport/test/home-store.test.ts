import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, describe, expect, it } from "vitest";
import { checkpointStore, sealStore, verifyStore } from "../src/home/index.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-transport-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }));

/** A store with `commits` appended entries, closed cleanly. */
async function closedStore(name: string, commits: number): Promise<string> {
	const path = join(dir, name);
	const storage = await openNodeSqliteStorage(path);
	const session = createSession(storage);
	const conversation = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		context,
	);
	for (let index = 0; index < commits; index++) {
		await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "note", data: { index } }), context);
	}
	await session.close(context);
	return path;
}

function headOf(path: string): number {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return Number((database.prepare("SELECT next_seq FROM durable_metadata").get() as { next_seq: number }).next_seq);
	} finally {
		database.close();
	}
}

describe("a sealed store", () => {
	it("is sealed with the head, hash and size of a store its owner closed", async () => {
		const path = await closedStore("sealed.db", 5);
		expect(existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0).toBe(false);
		const seal = getOrThrow(await sealStore(path, context));
		expect(seal.head).toBe(headOf(path));
		expect(seal.head).toBe(7);
		expect(seal.bytes).toBe(statSync(path).size);
		getOrThrow(await verifyStore(path, seal, context));
	});

	it("opens with pi once copied, and the next commit takes the sealed head as its sequence", async () => {
		const path = await closedStore("copied.db", 4);
		const seal = getOrThrow(await sealStore(path, context));
		const copy = join(dir, "copied-elsewhere.db");
		copyFileSync(path, copy);
		getOrThrow(await verifyStore(copy, seal, context));
		const storage = await openNodeSqliteStorage(copy);
		try {
			const seq = await storage.commit([], context);
			expect(Number(seq)).toBe(seal.head);
		} finally {
			await storage.close(context);
		}
	});

	it("is refused as `not_sealed` while its owner has it open with a log that holds content", async () => {
		const path = join(dir, "open.db");
		const storage = await openNodeSqliteStorage(path);
		const session = createSession(storage);
		try {
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "note", data: { x: 1 } }), context);
			expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
			const sealed = await sealStore(path, context);
			expect(sealed.ok ? "" : sealed.error.code).toBe("not_sealed");
		} finally {
			await session.close(context);
		}
	});

	it("is refused for a file that is not there, one that is not SQLite, and an aborted call", async () => {
		const missing = await sealStore(join(dir, "nowhere.db"), context);
		expect(missing.ok ? "" : missing.error.code).toBe("not_found");
		const text = join(dir, "text.db");
		writeFileSync(text, "this is not a database, and it is long enough to have a header's worth of bytes");
		const wrong = await sealStore(text, context);
		expect(wrong.ok ? "" : wrong.error.code).toBe("corrupt");
		const path = await closedStore("aborted.db", 1);
		const controller = new AbortController();
		controller.abort();
		const stopped = await sealStore(path, withAbortSignal(controller.signal, context));
		expect(stopped.ok ? "" : stopped.error.code).toBe("aborted");
	});

	it("is not accepted when a byte differs, the size differs, the head differs or SQLite finds damage", async () => {
		const path = await closedStore("verify.db", 30);
		const seal = getOrThrow(await sealStore(path, context));
		const code = async (file: string, against = seal) => {
			const result = await verifyStore(file, against, context);
			return result.ok ? "ok" : result.error.code;
		};
		const flipped = join(dir, "flipped.db");
		const bytes = readFileSync(path);
		bytes[bytes.length - 100] = (bytes[bytes.length - 100] as number) ^ 1;
		writeFileSync(flipped, bytes);
		expect(await code(flipped)).toBe("mismatch");
		const shorter = join(dir, "shorter.db");
		writeFileSync(shorter, bytes.subarray(0, bytes.length - 4096));
		expect(await code(shorter)).toBe("mismatch");
		const sized = await verifyStore(shorter, seal, context);
		expect(sized.ok ? "" : sized.error.message).toMatch(/bytes, the seal names/);
		expect(await code(path, { ...seal, head: seal.head + 1 })).toBe("mismatch");
		expect(await code(join(dir, "gone.db"))).toBe("not_found");
		// A damaged page whose seal was made over the damaged file: the hash agrees, SQLite does not. The page is one
		// SQLite flags while the head can still be read, so that only the quick check can refuse the file.
		const pageSize = 4096;
		let damaged = "";
		let damage = Buffer.alloc(0);
		for (let page = 1; page * pageSize < bytes.length && damaged === ""; page++) {
			const candidate = Buffer.from(bytes);
			candidate.fill(0xa5, page * pageSize + 100, (page + 1) * pageSize);
			const file = join(dir, `damaged-${page}.db`);
			writeFileSync(file, candidate);
			try {
				const database = new DatabaseSync(file, { readOnly: true });
				try {
					database.prepare("SELECT next_seq FROM durable_metadata").get();
					const check = database.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
					if (!(check.length === 1 && check[0]?.quick_check === "ok")) {
						damaged = file;
						damage = candidate;
					}
				} finally {
					database.close();
				}
			} catch {
				// A page SQLite cannot even read: not the one this case needs.
			}
		}
		expect(damaged, "a page that only the quick check flags").not.toBe("");
		const resealed = {
			...seal,
			bytes: damage.length,
			sha256: (await import("node:crypto")).createHash("sha256").update(damage).digest("hex"),
		};
		expect(await code(damaged, resealed)).toBe("corrupt");
	});
});

describe("a checkpoint of a store that is open", () => {
	it("is a whole copy that opens with pi, from a store its owner is still writing", async () => {
		const path = join(dir, "live.db");
		const storage = await openNodeSqliteStorage(path);
		const session = createSession(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		for (let index = 0; index < 20; index++) {
			await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "note", data: { index } }), context);
		}
		try {
			const to = join(dir, "live-checkpoint.db");
			const seal = getOrThrow(await checkpointStore(path, to, context));
			getOrThrow(await verifyStore(to, seal, context));
			// The owner goes on writing, and the checkpoint stays what it was.
			await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "note", data: { more: true } }), context);
			getOrThrow(await verifyStore(to, seal, context));
			const reopened = await openNodeSqliteStorage(to);
			try {
				expect(Number(await reopened.commit([], context))).toBe(seal.head);
			} finally {
				await reopened.close(context);
			}
			const again = await checkpointStore(path, to, context);
			expect(again.ok ? "" : again.error.code).toBe("exists");
			expect(existsSync(`${to}.partial`)).toBe(false);
		} finally {
			await session.close(context);
		}
	});

	it("opens and passes quick_check 200 times of 200 while another process commits in a loop", async () => {
		const path = join(dir, "busy.db");
		const writer = spawn(process.execPath, [join(import.meta.dirname, "home-writer.mjs"), path], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		const lines: string[] = [];
		writer.stdout.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
		const exited = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
		try {
			for (let tries = 0; !lines.includes("ready"); tries++) {
				if (tries > 200) throw new Error("the writer did not start");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const heads: number[] = [];
			let sound = 0;
			for (let round = 0; round < 200; round++) {
				const to = join(dir, `busy-${round}.db`);
				const sealed = getOrThrow(await checkpointStore(path, to, context));
				getOrThrow(await verifyStore(to, sealed, context));
				const database = new DatabaseSync(to, { readOnly: true });
				try {
					const check = database.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
					if (check.length === 1 && check[0]?.quick_check === "ok") sound += 1;
				} finally {
					database.close();
				}
				heads.push(sealed.head);
				rmSync(to);
			}
			expect(sound).toBe(200);
			for (let index = 1; index < heads.length; index++) {
				expect(heads[index] as number).toBeGreaterThanOrEqual(heads[index - 1] as number);
			}
			// The writer was committing all along: a checkpoint of a store that stood still would prove nothing.
			expect((heads.at(-1) as number) - (heads[0] as number)).toBeGreaterThan(50);
		} finally {
			writer.kill("SIGTERM");
			await exited;
		}
	}, 300_000);
});
