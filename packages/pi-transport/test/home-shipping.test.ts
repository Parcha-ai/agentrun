import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type Storage,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { openOutbox } from "../src/home/outbox.ts";
import { type Shipped, shippingStorage } from "../src/home/shipping.ts";
import { storeHead } from "../src/home/store.ts";
import { textResult } from "../src/testing/tool-result.ts";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A faux model that calls the tool once a turn, then answers; and the tool. */
function world() {
	const faux = fauxProvider({ api: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 20 }, (_, n) => (transcript: { messages: readonly { role: string }[] }) => {
			const last = transcript.messages.at(-1)?.role;
			return last === "toolResult"
				? fauxAssistantMessage(`answer ${n}`)
				: fauxAssistantMessage(fauxToolCall("note", { text: `turn ${n}` }, { id: `call-${n}` }), {
						stopReason: "toolUse",
					});
		}),
	);
	const note = defineTool({
		name: "note",
		description: "Note a thing.",
		parameters: Type.Object({ text: Type.String() }),
		async execute(args) {
			return textResult(`noted ${args.text}`);
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "note", tools: [note] }));
	return { models, registry };
}

/** One turn of a session over `storage`, closed after. */
async function turn(storage: Storage, question: string): Promise<void> {
	const { models, registry } = world();
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	await root.submit({ type: "input", content: question }, context);
	await root.waitForIdle(context);
	await harness.close(context);
}

/** Every table of a store, every row, in rowid order. */
function dump(path: string): Record<string, unknown[]> {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const tables = database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all()
			.map((row) => String((row as { name: string }).name));
		return Object.fromEntries(
			tables.map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]),
		);
	} finally {
		database.close();
	}
}

describe("a shipping store", () => {
	it("puts each commit in the outbox before the store has it, and ships it after, in order, once", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-shipping-"));
		directories.push(directory);
		const store = join(directory, "run.sqlite");
		const inner = await openNodeSqliteStorage(store);
		const head = getOrThrow(await storeHead(store));
		const outbox = openOutbox(`${store}.outbox.jsonl`, { head });
		const before: number[] = [];
		const shipped: Shipped[] = [];
		const watched = new Proxy(inner, {
			get(target, key) {
				if (key !== "commit") {
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return async (writes: readonly StorageWrite[], at: typeof context) => {
					// The entry is synced before the store sees the writes.
					const entry = outbox.pending().at(-1);
					expect(entry?.writes).toEqual(writes);
					before.push(entry?.commit ?? -1);
					// Nothing of this commit has been shipped: the host never gets a batch the store does not have.
					expect(shipped.map((one) => one.commit)).not.toContain(entry?.commit);
					return target.commit(writes, at);
				};
			},
		});
		await turn(shippingStorage(watched, { outbox, head, ship: (one) => shipped.push(one) }), "first");
		const after = getOrThrow(await storeHead(store));
		expect(shipped.map((one) => one.commit)).toEqual(Array.from({ length: after - head }, (_, n) => head + n));
		expect(before).toEqual(shipped.map((one) => one.commit));
		expect(outbox.pending().map((entry) => entry.commit)).toEqual(shipped.map((one) => one.commit));
		outbox.close();
	}, 30_000);

	it("rebuilds the store row for row from a checkpoint and the shipped writes, through JSON", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-shipping-"));
		directories.push(directory);
		const store = join(directory, "run.sqlite");
		const checkpoint = join(directory, "checkpoint.sqlite");
		await turn(await openNodeSqliteStorage(store), "before the checkpoint");
		copyFileSync(store, checkpoint);
		const head = getOrThrow(await storeHead(store));
		const outbox = openOutbox(`${store}.outbox.jsonl`, { head });
		const log: string[] = [];
		const shipping = shippingStorage(await openNodeSqliteStorage(store), {
			outbox,
			head,
			ship: (one) => log.push(JSON.stringify(one)),
		});
		await turn(shipping, "after the checkpoint");
		outbox.close();
		expect(log.length).toBeGreaterThan(5);

		// The host's replay: the checkpoint, then each shipped batch in order through the store's own commit.
		const replay = await openNodeSqliteStorage(checkpoint);
		for (const text of log) {
			const one = JSON.parse(text) as Shipped;
			expect(Number(await replay.commit(one.writes, context))).toBe(one.commit);
		}
		await replay.close(context);
		expect(dump(checkpoint)).toEqual(dump(store));
	}, 30_000);
});
