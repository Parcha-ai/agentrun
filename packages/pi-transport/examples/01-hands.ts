// Hands: one session whose tools run where a config says, while the session, its store and its model stay in this
// process. Change one line of the config and the same message's tools run somewhere else.
//
// By default the model is scripted, so the example costs nothing: it answers the user's message by running it as a
// shell command with pi's bash tool. Run from packages/pi-transport:
//   node --experimental-strip-types examples/01-hands.ts examples/hands.local.json 'hostname; pwd'
//   node --experimental-strip-types examples/01-hands.ts examples/hands.docker.json 'hostname; pwd'
//   node --experimental-strip-types examples/01-hands.ts examples/hands.host.json 'hostname; pwd'
//
// A real model, from any endpoint that speaks OpenAI's API, when these are set (the message is then a request in
// words): PI_HANDS_BASE_URL, PI_HANDS_MODEL, PI_HANDS_API_KEY, and PI_HANDS_API=openai-completions for an endpoint
// without the Responses API. The model is called from this process: no key and no model traffic enters a box.
//
// Options: --store <file> keeps the session in a SQLite file, so a later run continues the same conversation, for
// example with another `hands` in the config. --log <file> writes what the run measured as JSON.
// PI_HANDS_LABELS=name=value,... labels every box; PI_HANDS_NAME_PREFIX starts the names a provider gives.
//
// Boxes on Daytona and Modal when this process holds their credentials: DAYTONA_API_KEY (and DAYTONA_API_URL,
// DAYTONA_TARGET), or MODAL_TOKEN_ID and MODAL_TOKEN_SECRET with `npm install --no-save modal@0.11.0`. They cost
// money. See examples/hands.daytona.json, examples/hands.modal.json and examples/hands.modal-gpu.json.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { type Conversation, createRegistry, Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { daytonaBoxes } from "../src/box/daytona.ts";
import { dockerBoxes } from "../src/box/docker.ts";
import { localBoxes } from "../src/box/local.ts";
import { type ModalSdk, modalBoxes } from "../src/box/modal.ts";
import { transport } from "../src/hands/index.ts";
import {
	type Box,
	BoxError,
	type BoxProvider,
	finish,
	parseTransportConfig,
	SessionBoxesDoc,
	type Transport,
	TransportError,
} from "../src/index.ts";

/** A real model stops after this many requests in one turn, and the turn after this long. */
const MAX_REQUESTS = 10;
const MAX_TURN_MS = 180_000;
const LEFT_WAIT_MS = 15_000;
const NAME_PREFIX = process.env.PI_HANDS_NAME_PREFIX ?? "pi-hands-";
const INSTRUCTIONS = "You work through your tools: bash runs a shell command, write writes a file. Be brief.";
/** Lists the names, never the values, of variables in a box that look like credentials. */
const SECRET_NAMES_SCRIPT = "printenv | cut -d= -f1 | grep -i -E 'KEY|TOKEN|SECRET|PASSWORD' || true";

const context: Context = BACKGROUND_CONTEXT;

/** What one box did in this run. */
type BoxRecord = {
	readonly provider: string;
	id: string;
	createMs: number;
	readonly execMs: number[];
	destroyMs?: number;
	secretNames?: string[];
};

/** Everything the run measured. Written as it is by `--log`. */
type RunLog = {
	readonly example: "01-hands";
	readonly startedAt: string;
	readonly config: string;
	readonly hands: string | null;
	readonly model: { readonly id: string; readonly api: string; readonly scripted: boolean };
	readonly message: string;
	readonly requests: { readonly headersMs: number; readonly status: number; totalMs?: number }[];
	readonly boxes: BoxRecord[];
	firstToolStartMs?: number;
	turnMs?: number;
	stopped?: string;
	toolCalls?: {
		readonly name: string;
		readonly args: unknown;
		readonly durationMs: number | null;
		readonly isError: boolean;
		readonly output: string;
	}[];
	usage?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cost: number };
	answer?: string;
	left?: Record<string, number>;
};

function option(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at === -1 ? undefined : process.argv[at + 1];
}

const positional = process.argv
	.slice(2)
	.filter((arg, index, all) => !arg.startsWith("--") && !all[index - 1]?.startsWith("--"));
const [configPath, message] = positional;
if (configPath === undefined || message === undefined) {
	console.error(
		"usage: 01-hands.ts <transport config, a JSON file> <the user's message> [--store <file>] [--log <file>]",
	);
	process.exit(2);
}
const parsed = parseTransportConfig(JSON.parse(await readFile(configPath, "utf8")));
if (!parsed.ok) {
	for (const issue of parsed.error.issues) console.error(`${issue.path || "/"}: ${issue.message}`);
	process.exit(2);
}

const baseUrl = process.env.PI_HANDS_BASE_URL;
const modelId = process.env.PI_HANDS_MODEL;
const scripted = baseUrl === undefined || modelId === undefined;
const api = process.env.PI_HANDS_API === "openai-completions" ? "openai-completions" : "openai-responses";
const log: RunLog = {
	example: "01-hands",
	startedAt: new Date().toISOString(),
	config: configPath,
	hands: parsed.value.hands?.default ?? null,
	model: { id: scripted ? "scripted" : modelId, api: scripted ? "none" : api, scripted },
	message,
	requests: [],
	boxes: [],
};

/** The scripted model: one bash call with the user's message, then a last word. */
function scriptedModel(models: MutableModels): { provider: string; modelId: string } {
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: message as string }), { stopReason: "toolUse" }),
		(_transcript: TranscriptContext) => fauxAssistantMessage("Done."),
	]);
	return { provider: "faux", modelId: faux.getModel().id };
}

/**
 * A model behind an endpoint that speaks OpenAI's API. Its limits and prices are pi-ai's own entry for the model
 * when it has one, so the usage this run reports is priced by that table.
 */
function endpointModel(models: MutableModels, url: string, id: string): { provider: string; modelId: string } {
	const known = openaiProvider()
		.getModels()
		.find((model) => model.id === id);
	const common = {
		id,
		name: known?.name ?? id,
		provider: "endpoint",
		baseUrl: url,
		reasoning: known?.reasoning ?? false,
		input: known?.input ?? (["text"] as ("text" | "image")[]),
		cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: known?.contextWindow ?? 128_000,
		maxTokens: known?.maxTokens ?? 16_384,
	};
	const responses: Model<"openai-responses"> = { ...known, ...common, api: "openai-responses" };
	const completions: Model<"openai-completions"> = { ...common, api: "openai-completions" };
	const apiKey = process.env.PI_HANDS_API_KEY ?? "";
	models.setProvider(
		createProvider<"openai-responses" | "openai-completions">({
			id: "endpoint",
			baseUrl: url,
			auth: {
				apiKey: {
					name: "PI_HANDS_API_KEY",
					resolve: async () => ({ auth: { apiKey }, source: "PI_HANDS_API_KEY" }),
				},
			},
			models: [api === "openai-responses" ? responses : completions],
			api: { "openai-responses": openAIResponsesApi(), "openai-completions": openAICompletionsApi() },
		}),
	);
	return { provider: "endpoint", modelId: id };
}

/** Called when the turn must end early. Set once the conversation exists. */
let stopTurn: (why: string) => void = () => {};

/** Time every request to the model's endpoint, and stop a turn that asks too often. */
function watchRequests(url: string): void {
	const inner = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!target.startsWith(url)) return inner(input, init);
		if (log.requests.length >= MAX_REQUESTS) stopTurn(`more than ${MAX_REQUESTS} model requests`);
		const startedAt = performance.now();
		const response = await inner(input, init);
		const record: RunLog["requests"][number] = {
			headersMs: Math.round(performance.now() - startedAt),
			status: response.status,
		};
		log.requests.push(record);
		if (response.body === null) return response;
		// The answer streams: the request is over when its body has been read to the end.
		const read = response.body.pipeThrough(
			new TransformStream({
				flush: () => {
					record.totalMs = Math.round(performance.now() - startedAt);
				},
			}),
		);
		return new Response(read, response);
	};
}

/** The same provider, with every create, exec and destroy of its boxes timed into the log. */
function timed(provider: BoxProvider, live: Map<string, Box>): BoxProvider {
	const watch = (box: Box, record: BoxRecord): Box => {
		live.set(box.id, box);
		return {
			id: box.id,
			facts: () => box.facts(),
			async exec(command, options, execContext) {
				log.firstToolStartMs ??= Math.round(performance.now() - submittedAt);
				const startedAt = performance.now();
				const started = await box.exec(command, options, execContext);
				if (!started.ok) return started;
				const wait = async () => {
					const exit = await started.value.wait();
					record.execMs.push(Math.round(performance.now() - startedAt));
					return exit;
				};
				return { ok: true, value: { ...started.value, wait } };
			},
			upload: (files, uploadContext) => box.upload(files, uploadContext),
			download: (paths, downloadContext) => box.download(paths, downloadContext),
			status: (statusContext) => box.status(statusContext),
			async destroy(destroyContext) {
				const startedAt = performance.now();
				const destroyed = await box.destroy(destroyContext);
				record.destroyMs = Math.round(performance.now() - startedAt);
				live.delete(box.id);
				return destroyed;
			},
		};
	};
	const opened = async (
		found: Promise<Result<Box | undefined, BoxError>>,
		startedAt: number,
	): Promise<Result<Box | undefined, BoxError>> => {
		const result = await found;
		if (!result.ok || result.value === undefined) return result;
		const record: BoxRecord = {
			provider: provider.name,
			id: result.value.id,
			createMs: Math.round(performance.now() - startedAt),
			execMs: [],
		};
		log.boxes.push(record);
		return { ok: true, value: watch(result.value, record) };
	};
	return {
		name: provider.name,
		async create(spec, createContext) {
			log.firstToolStartMs ??= Math.round(performance.now() - submittedAt);
			const created = await opened(provider.create(spec, createContext), performance.now());
			if (!created.ok) return created;
			return { ok: true, value: created.value as Box };
		},
		attach: (id, attachContext) => opened(provider.attach(id, attachContext), performance.now()),
		list: (labels, listContext) => provider.list(labels, listContext),
	};
}

/** A provider this process has no credential for. A config may still declare its environments; using one fails. */
function unavailable(name: string, needs: string): BoxProvider {
	const refusal = new BoxError("unauthorized", `this process has no ${needs}, so it cannot ask ${name} for a box`);
	return {
		name,
		create: async () => ({ ok: false, error: refusal }),
		attach: async () => ({ ok: true, value: undefined }),
		list: async () => ({ ok: true, value: [] }),
	};
}

// The remote providers join when this process holds their credentials. They are read here, on the host, and handed
// to the provider: no config, no log and no box holds them.
async function daytona(): Promise<BoxProvider> {
	const { DAYTONA_API_KEY: apiKey, DAYTONA_API_URL: apiUrl, DAYTONA_TARGET: target } = process.env;
	if (apiKey === undefined) return unavailable("daytona", "DAYTONA_API_KEY");
	return daytonaBoxes({
		apiKey,
		namePrefix: NAME_PREFIX,
		...(apiUrl === undefined ? {} : { apiUrl }),
		...(target === undefined ? {} : { target }),
	});
}

async function modal(): Promise<BoxProvider> {
	if (process.env.MODAL_TOKEN_ID === undefined) return unavailable("modal", "MODAL_TOKEN_ID");
	// The Modal SDK is not a dependency of this package: `npm install --no-save modal@0.11.0` before a run on Modal.
	const specifier = "modal";
	const sdk = (await import(specifier)) as { ModalClient: new () => ModalSdk };
	return modalBoxes(new sdk.ModalClient(), { appName: `${NAME_PREFIX}hands` });
}

function text(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const labels = Object.fromEntries(
	(process.env.PI_HANDS_LABELS ?? "example=01-hands")
		.split(",")
		.filter((pair) => pair.includes("="))
		.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
);
const models = createModels();
const model = scripted ? scriptedModel(models) : endpointModel(models, baseUrl, modelId);
if (!scripted) watchRequests(baseUrl);
const registry = createRegistry();
registry.install(CodingTools);

const scratch = await mkdtemp(join(tmpdir(), "pi-transport-hands-"));
const live = new Map<string, Box>();
const providers: Record<string, BoxProvider> = {
	local: timed(localBoxes({ root: join(scratch, "boxes") }), live),
	docker: timed(dockerBoxes(), live),
	daytona: timed(await daytona(), live),
	modal: timed(await modal(), live),
};
let submittedAt = performance.now();
// The transport is the Harness's `env`, so it is built first and reaches the Harness through this binding.
let harness: Harness | undefined;
let hands: Transport;
try {
	hands = transport(parsed.value, {
		providers,
		commit: (change, commitContext) => (harness as Harness).commit(change, commitContext),
		labels,
	});
} catch (error) {
	if (!(error instanceof TransportError)) throw error;
	console.error(error.message);
	process.exit(2);
}
const storePath = option("--store");
const storage: Storage = storePath === undefined ? new MemoryStorage() : await openNodeSqliteStorage(storePath);
harness = await Harness.open(
	storage,
	{
		models,
		registry,
		// A config with no `hands` leaves the tools here, in this process's own environment.
		env: async (target, envContext) =>
			(await hands.env(target, envContext)) ?? new NodeExecutionEnv({ cwd: process.cwd() }),
	},
	context,
);
let failed = false;
try {
	// The root conversation: with `--store`, the one a run before this one left.
	const conversation: Conversation = await harness.root(context, { agent: { model, instructions: INSTRUCTIONS } });
	const before = (await conversation.context(context)).messages.length;
	const timer = setTimeout(() => stopTurn(`no end after ${MAX_TURN_MS / 1000} s`), MAX_TURN_MS);
	stopTurn = (why) => {
		if (log.stopped !== undefined) return;
		log.stopped = why;
		void conversation.abort(context);
	};
	submittedAt = performance.now();
	await (await conversation.submit({ type: "input", content: message }, context)).wait(context);
	clearTimeout(timer);
	log.turnMs = Math.round(performance.now() - submittedAt);

	const turn = (await conversation.context(context)).messages.slice(before);
	// What each call asked for, by the id its result carries.
	const asked = new Map<string, unknown>();
	for (const entry of turn) {
		if (entry.role !== "assistant") continue;
		for (const part of entry.content) if (part.type === "toolCall") asked.set(part.id, part.arguments);
	}
	log.toolCalls = [];
	for (const entry of turn) {
		if (entry.role !== "toolResult") continue;
		const shown = text(entry.content).trimEnd();
		log.toolCalls.push({
			name: entry.toolName,
			args: asked.get(entry.toolCallId) ?? null,
			durationMs: entry.durationMs ?? null,
			isError: entry.isError,
			output: shown,
		});
		console.log(entry.isError ? `the tool failed:\n${shown}` : shown);
	}
	const last = turn.findLast((entry) => entry.role === "assistant");
	log.answer = last === undefined ? "" : text(last.content);
	if (!scripted) console.log(`\n${log.answer}\n`);
	if (log.stopped !== undefined) console.log(`the turn was stopped: ${log.stopped}`);
	// This turn's own requests: with `--store` the conversation holds earlier turns too.
	const used = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const entry of turn) {
		if (entry.role !== "assistant") continue;
		used.input += entry.usage.input;
		used.output += entry.usage.output;
		used.cacheRead += entry.usage.cacheRead;
		used.cost += entry.usage.cost.total;
	}
	log.usage = used;

	// No credential belongs in a box: the names of variables that look like one, never their values.
	for (const record of log.boxes) {
		const box = live.get(record.id);
		if (box === undefined) continue;
		const started = await box.exec(["sh", "-c", SECRET_NAMES_SCRIPT], undefined, context);
		const scanned = started.ok ? await finish(started.value) : started;
		if (scanned.ok) record.secretNames = new TextDecoder().decode(scanned.value.stdout).split("\n").filter(Boolean);
	}
	const boxes = Object.entries((await harness.snapshot(SessionBoxesDoc, context))?.boxes ?? {});
	console.log(boxes.length === 0 ? "the tools ran on this machine, in no box" : "the tools ran in:");
	for (const [environment, id] of boxes) console.log(`  ${environment}: box ${id.length > 24 ? id.slice(0, 12) : id}`);
} catch (error) {
	failed = true;
	console.error(error instanceof Error ? error.message : String(error));
} finally {
	// The session's turn is over: end its boxes. A host that needs a box again calls `release` instead.
	const ended = await hands.destroy(context);
	if (!ended.ok) console.error(ended.error.message);
	log.left = {};
	// What this run's providers still list under its labels: 0 when every box ended, -1 when a provider cannot say.
	// A provider's listing may trail a destroy by a moment, so a count that is not 0 is asked for again for a while.
	for (const name of new Set(log.boxes.map((record) => record.provider))) {
		for (const deadline = Date.now() + LEFT_WAIT_MS; ; ) {
			const listed = await providers[name]?.list(labels, context);
			log.left[name] = listed?.ok ? listed.value.length : -1;
			if (log.left[name] <= 0 || Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}
	await harness.close(context);
	await rm(scratch, { recursive: true, force: true });
	const logPath = option("--log");
	if (logPath !== undefined) await writeFile(logPath, `${JSON.stringify(log, null, "\t")}\n`);
}
if (failed) process.exit(1);
