// Hands: one session whose tools run where a config says. The model is scripted, so the example costs nothing: it
// answers the user's message by running it as a shell command with pi's bash tool. Change the config and the same
// command runs somewhere else, while the session, its store and its model stay in this process.
// Run from packages/pi-transport:
//   node --experimental-strip-types examples/01-hands.ts examples/hands.local.json 'hostname; pwd'
//   node --experimental-strip-types examples/01-hands.ts examples/hands.docker.json 'hostname; pwd'
//   node --experimental-strip-types examples/01-hands.ts examples/hands.host.json 'hostname; pwd'
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { dockerBoxes } from "../src/box/docker.ts";
import { localBoxes } from "../src/box/local.ts";
import { transport } from "../src/hands/index.ts";
import { parseTransportConfig, SessionBoxesDoc, type Transport, TransportError } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

const [configPath, message] = process.argv.slice(2);
if (configPath === undefined || message === undefined) {
	console.error("usage: 01-hands.ts <transport config, a JSON file> <a shell command, as the user's message>");
	process.exit(2);
}
const parsed = parseTransportConfig(JSON.parse(await readFile(configPath, "utf8")));
if (!parsed.ok) {
	for (const issue of parsed.error.issues) console.error(`${issue.path || "/"}: ${issue.message}`);
	process.exit(2);
}

// The scripted model: one bash call with the user's message, then a last word once it has seen the result.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("bash", { command: message }), { stopReason: "toolUse" }),
	(transcript: TranscriptContext) => {
		const result = transcript.messages.at(-1);
		if (result?.role === "toolResult") {
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			console.log(result.isError ? `the tool failed:\n${text}` : text.trimEnd());
		}
		return fauxAssistantMessage("Done.");
	},
]);
const registry = createRegistry();
registry.install(CodingTools);

const scratch = await mkdtemp(join(tmpdir(), "pi-transport-hands-"));
// The transport is the Harness's `env`, so it is built first and reaches the Harness through this binding.
let harness: Harness | undefined;
let hands: Transport;
try {
	hands = transport(parsed.value, {
		providers: { local: localBoxes({ root: join(scratch, "boxes") }), docker: dockerBoxes() },
		commit: (change, commitContext) => (harness as Harness).commit(change, commitContext),
		labels: { example: "01-hands" },
	});
} catch (error) {
	if (!(error instanceof TransportError)) throw error;
	console.error(error.message);
	process.exit(2);
}
harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		// A config with no `hands` leaves the tools here, in this process's own environment.
		env: async (target, envContext) =>
			(await hands.env(target, envContext)) ?? new NodeExecutionEnv({ cwd: process.cwd() }),
	},
	context,
);
try {
	const model = { provider: "faux", modelId: faux.getModel().id };
	const conversation = await harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model } },
		context,
	);
	await (await conversation.submit({ type: "input", content: message }, context)).wait(context);
	const boxes = Object.entries((await harness.snapshot(SessionBoxesDoc, context))?.boxes ?? {});
	console.log(boxes.length === 0 ? "the tools ran on this machine, in no box" : "the tools ran in:");
	for (const [environment, id] of boxes) console.log(`  ${environment}: box ${id.length > 24 ? id.slice(0, 12) : id}`);
} finally {
	// The session is over: end its boxes. A host that will open the session again calls `release` instead.
	const ended = await hands.destroy(context);
	if (!ended.ok) console.error(ended.error.message);
	await harness.close(context);
	await rm(scratch, { recursive: true, force: true });
}
