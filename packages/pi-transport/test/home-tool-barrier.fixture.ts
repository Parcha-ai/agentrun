// A home-shaped writer for home-tool-barrier.test.ts: pi-durable's Harness on pi-durable's own store opener (WAL,
// synchronous = NORMAL), one side-effecting tool `pay` and a faux model that calls it once.
//   fixture.ts <store> <effects file> <wrap|beforeTool> <first|resume>
// `wrap` syncs where the home does (tool-barrier.ts, after the call's intent is committed); `beforeTool` syncs in a
// beforeTool hook, before the intent. `first`: start the run; `pay` appends to the effects file and then waits forever,
// so the test can lose the box while it is in flight. `resume`: reopen, resume, wait until idle, exit.
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
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
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { syncNow } from "../src/home/sync-now.ts";
import { toolBarrier } from "../src/home/tool-barrier.ts";
import { textResult } from "../src/testing/tool-result.ts";

const [store, effects, variant, phase] = process.argv.slice(2) as [
	string,
	string,
	"wrap" | "beforeTool",
	"first" | "resume",
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
const target = { database, synchronous: "NORMAL" as const };
const registry = createRegistry();
registry.install(defineExtension({ name: "pay", tools: [pay] }));
if (variant === "wrap") registry.install(toolBarrier(registry, target));
else
	registry.install(
		defineExtension({
			name: "sync-before-tool",
			hooks: [hook(ToolTask, { beforeTool: async () => void (await syncNow(target, "homeToolIntent")) })],
		}),
	);
const harness = await Harness.open(await SqliteStorage.open(database), { registry, models }, context);
if (phase === "first") {
	setInterval(() => {}, 1_000);
	const root = await harness.root(context, { agent: { model } });
	await root.submit({ type: "input", content: "pay once" }, context);
} else {
	harness.resume();
	await harness.waitForIdle(context);
	const root = await harness.conversation(ROOT_CONVERSATION_ID, context);
	process.stdout.write(`resumed ${root ? "with" : "without"} the conversation\n`);
	process.exit(0);
}
