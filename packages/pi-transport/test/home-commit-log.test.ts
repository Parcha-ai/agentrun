import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, describe, expect, it } from "vitest";
import { type LogEntry, replayCommits } from "../src/home/commit-log.ts";
import { checkpointStore, sealStore } from "../src/home/store.ts";
import { tapStorage } from "./commit-tap.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-log-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
let counter = 0;
const fresh = (name: string) => {
	const directory = join(root, `${name}-${counter++}`);
	mkdirSync(directory, { recursive: true });
	return join(directory, "run.sqlite");
};

/** Every row of every table, in a fixed order: what two stores must agree on to be the same store. */
function dump(path: string): Record<string, unknown[]> {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const tables = (
			database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all() as {
				name: string;
			}[]
		).map((row) => row.name);
		const out: Record<string, unknown[]> = {};
		for (const table of tables) {
			const rows = database.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
			out[table] = rows
				.map((row) => JSON.stringify(row, (_, value) => (typeof value === "bigint" ? String(value) : value)))
				.sort();
		}
		return out;
	} finally {
		database.close();
	}
}

/** A session that commits as `steps` says, and what it shipped; the store is closed when this returns. */
async function live(path: string, steps: (commit: (n: number) => Promise<void>) => Promise<void>) {
	const shipped: LogEntry[] = [];
	const session = createSession(tapStorage(await openNodeSqliteStorage(path), (entry) => shipped.push(entry)));
	const conversation = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		context,
	);
	const commit = async (n: number) => {
		await session.commit(
			(tx) => tx.appendEntry(conversation.id, { kind: "note", data: { n, text: `entry ${n}` } }),
			context,
		);
	};
	await steps(commit);
	await session.close(context);
	return shipped;
}

describe("shipped commits replayed into a checkpoint", () => {
	it("give the store the session had: every row of every table the same, ids and sequences included", async () => {
		const original = fresh("live");
		const checkpointed = fresh("ckpt");
		let head = 0;
		const shipped = await live(original, async (commit) => {
			await commit(1);
			await commit(2);
			const copied = getOrThrow(await checkpointStore(original, checkpointed, context));
			head = copied.head;
			await commit(3);
			await commit(4);
			await commit(5);
		});
		const after = shipped.filter((entry) => entry.commit >= head);
		expect(after.length).toBe(3);
		expect(after[0]?.commit).toBe(head);
		const replayed = getOrThrow(await replayCommits(checkpointed, head, after, context));
		expect(replayed).toEqual({ from: head, to: head + 2, count: 3 });
		expect(dump(checkpointed)).toEqual(dump(original));
		expect(getOrThrow(await sealStore(checkpointed, context)).head).toBe(
			getOrThrow(await sealStore(original, context)).head,
		);
	});

	it("replay nothing for an empty log, and refuse a gap and keep what came before it", async () => {
		const original = fresh("live");
		const checkpointed = fresh("ckpt");
		let head = 0;
		const shipped = await live(original, async (commit) => {
			await commit(1);
			head = getOrThrow(await checkpointStore(original, checkpointed, context)).head;
			await commit(2);
			await commit(3);
			await commit(4);
		});
		const after = shipped.filter((entry) => entry.commit >= head);
		expect(getOrThrow(await replayCommits(checkpointed, head, [], context)).count).toBe(0);
		const gapped = await replayCommits(checkpointed, head, [after[0] as LogEntry, after[2] as LogEntry], context);
		expect(gapped.ok ? "" : gapped.error.code).toBe("gap");
		expect(gapped.ok ? -1 : gapped.error.applied).toBe(head);
		expect(getOrThrow(await sealStore(checkpointed, context)).head).toBe(head + 1);
		// The first entry is not the one the checkpoint wants next.
		const early = await replayCommits(checkpointed, head + 1, [after[0] as LogEntry], context);
		expect(early.ok ? "" : early.error.code).toBe("gap");
	});

	it("refuse an entry the store takes as another commit, and a commit it already holds", async () => {
		const original = fresh("live");
		const checkpointed = fresh("ckpt");
		let head = 0;
		const shipped = await live(original, async (commit) => {
			await commit(1);
			head = getOrThrow(await checkpointStore(original, checkpointed, context)).head;
			await commit(2);
		});
		const next = shipped.find((entry) => entry.commit === head) as LogEntry;
		// A caller that believes the store is one commit ahead of where it is: the store takes the batch as `head`.
		const shifted = await replayCommits(checkpointed, head + 1, [{ commit: head + 1, writes: next.writes }], context);
		expect(shifted.ok ? "" : shifted.error.code).toBe("mismatch");
		expect(shifted.ok ? -1 : shifted.error.applied).toBe(head);
		// The commit that was applied by that attempt is now in the store: replaying it again is refused by the store.
		const again = await replayCommits(checkpointed, head, [next], context);
		expect(again.ok ? "" : again.error.code).toBe("failed");
		expect(again.ok ? -1 : again.error.applied).toBe(head - 1);
	});
});
