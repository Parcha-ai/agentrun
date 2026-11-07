// A home-shaped writer for home-tool-barrier.test.ts: pi-durable's Harness on pi-durable's own store opener (WAL,
// synchronous = NORMAL), one side-effecting tool `pay` and a faux model that calls it once.
//   fixture.ts <store> <effects file> <variant> <first|resume> [reader]
// variant `wrap`: the home's own barrier (tool-barrier.ts: the WAL file synced after the call's intent is committed);
// `beforeTool`: the same sync in a beforeTool hook, which runs before the intent is committed; `checkpoint`: the wrap,
// but with a passive checkpoint as the barrier. `reader`: a second connection holds a read snapshot from the start, as
// a reader of the store would. `first`: start the run; `pay` appends to the effects file and then waits forever, so the
// test can lose the box while it is in flight. `resume`: reopen, resume, wait until idle, exit.
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	hook,
	ROOT_CONVERSATION_ID,
	ToolTask,
	wrapTool,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { syncNow } from "../src/home/sync-now.ts";
import { toolBarrier } from "../src/home/tool-barrier.ts";
import { textResult } from "../src/testing/tool-result.ts";

const [store, effects, variant, phase, withReader] = process.argv.slice(2) as [
	string,
	string,
	"wrap" | "beforeTool" | "checkpoint",
	"first" | "resume",
	string | undefined,
];
const context = BACKGROUND_CONTEXT;
const faux = fauxProvider();
faux.setResponses(
	Array.from(
		{ length: 20 },
		() => (transcript: { messages: readonly { role: string }[] }) =>
			transcript.messages.some((m) => m.role === "toolResult")
				? fauxAssistantMessage("done")
				: fauxAssistantMessage(fauxToolCall("pay", {}, { id: "pay-1" }), { stopReason: "toolUse" }),
	),
);
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
const pay = defineTool({
	name: "pay",
	description: "Pay once: an effect outside the store.",
	parameters: Type.Object({}),
	replay: "unsafe",
	async execute() {
		const fd = openSync(effects, "a");
		appendFileSync(fd, `${phase}\n`);
		fsyncSync(fd);
		closeSync(fd);
		process.stdout.write("paid\n");
		if (phase === "first") await new Promise(() => {});
		return textResult("paid");
	},
});
const database = await openNodeSqliteDatabase(store);
const storage = await SqliteStorage.open(database);
const walFile = `${store}-wal`;
const registry = createRegistry();
registry.install(defineExtension({ name: "pay", tools: [pay] }));
if (variant === "wrap") registry.install(toolBarrier(registry, { walFile }));
else if (variant === "beforeTool")
	registry.install(
		defineExtension({
			name: "sync-before-tool",
			hooks: [hook(ToolTask, { beforeTool: async () => void (await syncNow({ walFile }, "homeToolIntent")) })],
		}),
	);
else
	registry.install(
		defineExtension({
			name: "checkpoint-barrier",
			wraps: [
				wrapTool(pay, (inner) => ({
					...inner,
					async execute(args, api, ctx) {
						await database.exec("PRAGMA wal_checkpoint(PASSIVE)");
						return inner.execute(args, api, ctx);
					},
				})),
			],
		}),
	);
let reader: DatabaseSync | undefined;
if (phase === "first" && withReader === "reader") {
	// Everything so far in the database file, then a reader that holds its snapshot from here on.
	await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	reader = new DatabaseSync(store);
	reader.exec("BEGIN");
	reader.prepare("SELECT count(*) FROM sqlite_schema").get();
}
const harness = await Harness.open(storage, { registry, models }, context);
if (phase === "first") {
	setInterval(() => void reader, 1_000);
	const root = await harness.root(context, { agent: { model } });
	await root.submit({ type: "input", content: "pay once" }, context);
} else {
	harness.resume();
	await harness.waitForIdle(context);
	const root = await harness.conversation(ROOT_CONVERSATION_ID, context);
	process.stdout.write(`resumed ${root ? "with" : "without"} the conversation\n`);
	process.exit(0);
}
