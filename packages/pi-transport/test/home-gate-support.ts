import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxModelDefinition,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	AssistantEntry,
	CompactionEntry,
	CompactionTask,
	type Conversation,
	configure,
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	Harness,
	type HarnessSettings,
	hook,
	type JsonObject,
	ROOT_CONVERSATION_ID,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { createGate, type Drained, type DrainOptions, GATE_EXTENSION, type Gate } from "../src/home/gate.ts";
import { random } from "./home-support.ts";

const context: Context = BACKGROUND_CONTEXT;

/** The task kind of the background loop in `besideTicker`. */
export const TICKER = "test.ticker";
/** The root's answer once its work is done. */
const LAST_WORD = "done";
/** What a delegate submits to its child, followed by the child's number. */
const CHILD = "child:";
/** pi's summarizer names itself in its system prompt. Nothing else tells its request from a generation's. */
const SUMMARIZER = "context summarization assistant";
/** Diagnostic codes pi puts on a tool result when the call did not run to its end. */
const CUT_CODES = ["interrupted", "blocked", "aborted"];
/** More answers than any run asks for. Each is the same function, which keeps no state. */
const ANSWERS = 600;
/** More records than any run writes, so one page is a whole scan. */
const ALL = 2_000;
const IDLE_TIMEOUT_MS = 20_000;
const TICK_MS = 50;
const ROUNDS = 6;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait until `test` holds, looking every millisecond. False when it did not hold within `ms`. */
export async function until(test: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
	const deadline = performance.now() + ms;
	while (!(await test())) {
		if (performance.now() >= deadline) return false;
		await sleep(1);
	}
	return true;
}

/** What one run writes and counts, shared by its tools, its model and every Harness opened on its store. */
export type Site = {
	/** The file a work call appends its tag to. */
	readonly effects: string;
	/** The file the ticker appends its numbered lines to. */
	readonly ticks: string;
	/** A number from `low` up to `high`, drawn from the move's seed. */
	between(low: number, high: number): number;
	/** Work calls executing now. */
	running: number;
	/** The most work calls that executed at once. */
	peak: number;
};

/** What the model sees of a conversation. It chooses the next step from this alone and remembers nothing. */
export type Seen = {
	/** Tool results so far, those a summary stands for included. */
	readonly done: number;
	/** The child's number when the conversation is a delegate's child. */
	readonly child: number | undefined;
};

/** A run with effects, and what a move must leave true of it. */
export type Scenario = {
	/** The extensions the host installs before the gate's. */
	readonly extensions: readonly Extension[];
	/** The model's next message. */
	next(seen: Seen): AssistantMessage;
	/** Every line the run's work calls append. Each must appear once. */
	readonly effects: readonly string[];
	/** The fewest model requests the run takes, the summarizer's not counted. */
	readonly requests: number;
	readonly settings?: HarnessSettings;
	readonly models?: FauxModelDefinition[];
	/** Runs on the root before its first input. */
	start?(root: Conversation): Promise<void>;
	/** Something the host does once near the move, on whichever Harness is open then. */
	readonly beside?: {
		/** The earliest and latest time for it, in ms from the start of the move. */
		readonly offsetMs: readonly [number, number];
		act(root: Conversation): Promise<unknown>;
	};
	/** Runs once the root is idle, before the store is read. */
	settle?(): Promise<unknown>;
};

/** One Harness on a trial's store, with its gate attached. */
export type Home = { readonly harness: Harness; readonly gate: Gate; readonly root: Conversation };

/** What a run left behind, read from its store and its files. */
export type Outcome = {
	/** The root went idle and gave its last answer. */
	readonly finished: boolean;
	/** The diagnostic codes of tool results that say a call was cut, in any conversation. */
	readonly cut: readonly string[];
	/** Every line the work calls appended, sorted. */
	readonly effects: readonly string[];
	/** Model requests, the summarizer's not counted. */
	readonly requests: number;
	/** Summarizer prompts that were sent more than once. */
	readonly repeatedSummaries: number;
	/** Summaries placed in a conversation. */
	readonly summaries: number;
	/** How each compaction task ended, or its status when it has not. */
	readonly compactions: readonly string[];
	/** Conversations other than the root. */
	readonly children: number;
	/** Tasks of those conversations that ended `aborted`. */
	readonly abortedChildTasks: number;
	/** The most work calls that executed at once. */
	readonly peak: number;
	/** The ticker's lines, in file order. */
	readonly ticks: readonly number[];
	/** Failures pi reported without failing a call. */
	readonly reports: readonly string[];
};

/** A scenario on a store of its own. */
export type Trial = {
	readonly scenario: Scenario;
	readonly site: Site;
	/** When the move starts, in ms after the run's input. Below 500, drawn from the move's index. */
	readonly moveAtMs: number;
	/** Open a Harness on the store with a fresh gate attached, as the next home of the session would. */
	open(): Promise<Home>;
	/** Start the run: the scenario's `start`, then the input. */
	begin(home: Home): Promise<void>;
	/** Wait for the run to end, read what it left behind and close the Harness. */
	finish(home: Home): Promise<Outcome>;
};

/** A move that closed one Harness and finished the run in the next. */
export type Moved = {
	readonly drained: Drained;
	/** The ticker's lines once the first Harness had closed. */
	readonly ticksAtClose: number;
	readonly outcome: Outcome;
};

function lines(file: string): string[] {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

function textOf(message: Message | undefined): string {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	const texts: string[] = [];
	for (const part of message.content) if (part.type === "text") texts.push(part.text);
	return texts.join("\n");
}

/** The count of tool results a summary stands for, or 0 when `text` holds no summary. */
function carried(text: string): number {
	return Number(/done=(\d+)/.exec(text)?.[1] ?? 0);
}

/** One tool call the scripted model makes. */
type ToolUse = { readonly name: string; readonly args: ToolCall["arguments"] };

const work = (tag: string): ToolUse => ({ name: "work", args: { tag } });
const say = (text: string) => fauxAssistantMessage(text);
/** An assistant message that makes these calls in one round. */
const call = (...uses: ToolUse[]) =>
	fauxAssistantMessage(
		uses.map((use) => fauxToolCall(use.name, use.args)),
		{ stopReason: "toolUse" },
	);

/** A tool that is not safe to run twice: it takes 25 to 110 ms and appends its tag. `pad` lengthens its result. */
function workTool(site: Site, pad: number) {
	return defineTool({
		name: "work",
		description: "Do one unit of work with an effect.",
		parameters: Type.Object({ tag: Type.String() }),
		async execute(args) {
			site.running += 1;
			site.peak = Math.max(site.peak, site.running);
			try {
				await sleep(site.between(20, 80));
				appendFileSync(site.effects, `${args.tag}\n`);
				await sleep(site.between(5, 30));
			} finally {
				site.running -= 1;
			}
			return { content: [{ type: "text", text: `did ${args.tag}${pad > 0 ? ` ${"x".repeat(pad)}` : ""}` }] };
		},
	});
}

/** A tool that runs a conversation owned by its own task and returns the child's answer. */
function delegateTool(gated: boolean) {
	return defineTool({
		name: "delegate",
		description: "Run a child conversation and return its answer.",
		parameters: Type.Object({ k: Type.Number() }),
		async execute(args, api, toolContext) {
			const id = await api.commit(async (tx) => {
				const record = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				if (!gated) await configure(tx, record.id, { extensions: { remove: [{ name: GATE_EXTENSION }] } });
				return record.id;
			}, toolContext);
			const child = await api.conversation(id, toolContext);
			if (child === undefined) throw new Error(`child conversation ${id} is missing`);
			const submission = await child.submit({ type: "input", content: `${CHILD}${args.k}` }, toolContext);
			await child.waitForIdle(toolContext);
			const settled = await submission.status(toolContext);
			if (settled.status !== "done" || settled.answer === undefined) {
				return { content: [{ type: "text", text: `child ${args.k} ended ${settled.status}` }], isError: true };
			}
			const { answer } = settled;
			const entry = await api.commit((tx) => tx.entry(answer), toolContext);
			return { content: [{ type: "text", text: textOf(entry?.model?.[0]) }] };
		},
	});
}

/** A background loop that never ends: sleep, append the next number, checkpoint the count. */
function tickerTask(site: Site) {
	return defineTask<JsonObject, { phase: "tick"; n: number }, never>({
		name: TICKER,
		version: 1,
		initial: () => ({ phase: "tick", n: 0 }),
		phases: {
			tick: async (task, runtime, taskContext) => {
				const { n } = task.state.checkpoint;
				await runtime.sleep(runtime.now() + TICK_MS, taskContext);
				appendFileSync(site.ticks, `${n}\n`);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "tick", n: n + 1 } }), taskContext);
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
		},
	});
}

/** A serial loop: six requests with one work call each, then the last word. */
export function serialLoop(site: Site, pad = 0): Scenario {
	return {
		extensions: [defineExtension({ name: "work", tools: [workTool(site, pad)] })],
		next: ({ done }) => (done >= ROUNDS ? say(LAST_WORD) : call(work(String(done)))),
		effects: Array.from({ length: ROUNDS }, (_, round) => String(round)),
		requests: ROUNDS + 1,
	};
}

/**
 * Four rounds of three work calls in one assistant message. `staggered` installs another extension whose `beforeTool`
 * hook takes up to 60 ms, so the calls of one round reach the gate at different times.
 */
export function parallelRounds(site: Site, staggered: boolean): Scenario {
	const slow = defineExtension({
		name: "slow-hook",
		hooks: [
			hook(ToolTask, {
				beforeTool: async () => {
					await sleep(site.between(0, 60));
					return undefined;
				},
			}),
		],
	});
	const rounds = [0, 1, 2, 3].map((round) => [0, 1, 2].map((slot) => `${round}-${slot}`));
	return {
		extensions: [...(staggered ? [slow] : []), defineExtension({ name: "work", tools: [workTool(site, 0)] })],
		next: ({ done }) => {
			const round = rounds[Math.floor(done / 3)];
			return round === undefined ? say(LAST_WORD) : call(...round.map(work));
		},
		effects: rounds.flat(),
		requests: rounds.length + 1,
	};
}

/**
 * Two delegate calls, one after the other. Each runs a child conversation of two work rounds and waits for it. Not
 * `gated`: the child's agent drops the gate's extension, so no gate hook runs in the child.
 */
export function delegated(site: Site, gated: boolean): Scenario {
	return {
		extensions: [defineExtension({ name: "work", tools: [workTool(site, 0), delegateTool(gated)] })],
		next: ({ done, child }) => {
			if (child !== undefined) return done >= 2 ? say(`child ${child} done`) : call(work(`c${child}-${done}`));
			return done >= 2 ? say(LAST_WORD) : call({ name: "delegate", args: { k: done } });
		},
		effects: ["c0-0", "c0-1", "c1-0", "c1-1"],
		// The root: two delegate rounds and the last word. Each child: two work rounds and its answer.
		requests: 3 + 2 * 3,
	};
}

/** The serial loop, and a `compact()` the host calls between 70 ms before the move starts and 30 ms after. */
export function compactedByHand(site: Site): Scenario {
	return {
		...serialLoop(site),
		settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		beside: { offsetMs: [-70, 30], act: (root) => root.compact(undefined, context) },
	};
}

/**
 * The serial loop in a context window so small that pi compacts as it goes. With `backgroundTokens` 0 every compaction
 * blocks the generation that found the threshold. Above 0, some run in the background as well.
 */
export function compactedAtThreshold(site: Site, backgroundTokens: number): Scenario {
	return {
		...serialLoop(site, 400),
		models: [{ id: "small-window", contextWindow: 1000, maxTokens: 256 }],
		settings: { compaction: { enabled: true, reserveTokens: 600, keepRecentTokens: 150, backgroundTokens } },
	};
}

/** The serial loop beside a background task of the host's own that never ends. */
export function besideTicker(site: Site): Scenario {
	const ticker = tickerTask(site);
	const base = serialLoop(site);
	return {
		...base,
		extensions: [...base.extensions, defineExtension({ name: "ticker", tasks: [ticker] })],
		async start(root) {
			await root.commit(
				(tx) => tx.createTask(ticker, {}, { ownership: { kind: "conversation" }, background: true }),
				context,
			);
		},
		// One more line after the run ended shows the ticker runs in the Harness that finished the run.
		settle: () => {
			const before = lines(site.ticks).length;
			return until(() => lines(site.ticks).length > before);
		},
	};
}

/** What `Outcome` holds after a run that finished with nothing cut. */
export function uncut(scenario: Scenario): Partial<Outcome> {
	return { finished: true, cut: [], effects: [...scenario.effects].sort(), requests: scenario.requests, reports: [] };
}

/**
 * Run `use` with a trial of the scenario `plan` builds, in a directory of its own that is removed afterwards. Every
 * random time of the trial comes from `index`, so the same index gives the same move again.
 */
export async function withTrial(
	index: number,
	plan: (site: Site) => Scenario,
	use: (trial: Trial) => Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-gate-"));
	const live = new Set<Harness>();
	try {
		const chance = random(index);
		const moveAtMs = Math.floor(chance() * 500);
		const site: Site = {
			effects: join(directory, "effects.log"),
			ticks: join(directory, "ticks.log"),
			between: (low, high) => low + chance() * (high - low),
			running: 0,
			peak: 0,
		};
		const scenario = plan(site);
		const store = join(directory, "session.db");
		const reports: string[] = [];
		const prompts = new Map<string, number>();
		let requests = 0;

		const answer = async (transcript: TranscriptContext): Promise<AssistantMessage> => {
			const { messages } = transcript;
			if (messages.some((message) => message.role === "system" && textOf(message).includes(SUMMARIZER))) {
				const prompt = textOf(messages.find((message) => message.role === "user"));
				prompts.set(prompt, (prompts.get(prompt) ?? 0) + 1);
				await sleep(site.between(15, 60));
				// The summary carries the count of tool results it replaces, which is all the model needs of them.
				const source = prompt.slice(0, prompt.indexOf("</conversation>"));
				return say(`done=${carried(source) + source.split("[Tool result]:").length - 1}`);
			}
			requests += 1;
			await sleep(site.between(15, 60));
			const users = messages.filter((message) => message.role === "user").map(textOf);
			const results = messages.filter((message) => message.role === "toolResult").length;
			const child = users.find((text) => text.startsWith(CHILD))?.slice(CHILD.length);
			const summary = users.find((text) => text.includes("<summary>"));
			return scenario.next({
				done: carried(summary ?? "") + results,
				child: child === undefined ? undefined : Number(child),
			});
		};
		const faux = fauxProvider(scenario.models === undefined ? {} : { models: scenario.models });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(Array.from({ length: ANSWERS }, () => answer));
		const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };

		await use({
			scenario,
			site,
			moveAtMs,
			async open() {
				const gate = createGate();
				const registry = createRegistry();
				for (const extension of scenario.extensions) registry.install(extension);
				registry.install(gate.extension);
				const harness = await Harness.open(
					await openNodeSqliteStorage(store),
					{
						models,
						registry,
						...(scenario.settings === undefined ? {} : { settings: scenario.settings }),
						onReport: (error) => reports.push(error instanceof Error ? error.message : String(error)),
					},
					context,
				);
				live.add(harness);
				harness.subscribeClose(() => live.delete(harness));
				gate.attach(harness);
				harness.resume();
				return { harness, gate, root: await harness.root(context, { agent: { model } }) };
			},
			async begin(home) {
				await scenario.start?.(home.root);
				await home.root.submit({ type: "input", content: "go" }, context);
			},
			async finish({ harness, root }) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const idle = await Promise.race([
					root.waitForIdle(context).then(
						() => true,
						() => false,
					),
					new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), IDLE_TIMEOUT_MS);
					}),
				]);
				clearTimeout(timer);
				// A background compaction is outside the idle wait: let it end before the store is read.
				const compaction = CompactionTask.definition.name;
				await until(
					async () => !(await harness.inspect(context)).tasks.some((task) => task.record.kind === compaction),
				);
				await scenario.settle?.();

				const cut: string[] = [];
				let answered = false;
				let summaries = 0;
				const conversations = (await harness.commit((tx) => tx.scanConversations({}, ALL), context)).items;
				for (const record of conversations) {
					const conversation = await harness.conversation(record.id, context);
					if (conversation === undefined) continue;
					for (const entry of (await conversation.entries({}, ALL, undefined, context)).items) {
						if (ToolResultEntry.is(entry)) {
							for (const { code } of entry.data.diagnostics) {
								if (code !== undefined && CUT_CODES.includes(code)) cut.push(code);
							}
						}
						if (CompactionEntry.is(entry)) summaries += 1;
						if (record.id === ROOT_CONVERSATION_ID && AssistantEntry.is(entry)) {
							answered ||= textOf(entry.model?.[0]) === LAST_WORD;
						}
					}
				}
				const tasks = (await harness.commit((tx) => tx.scanTasks({}, ALL), context)).items;
				await harness.close(context);
				return {
					finished: idle && answered,
					cut,
					effects: lines(site.effects).sort(),
					requests,
					repeatedSummaries: [...prompts.values()].filter((sent) => sent > 1).length,
					summaries,
					compactions: tasks
						.filter((task) => task.kind === compaction)
						.map((task) => task.state.outcome?.status ?? task.state.status),
					children: conversations.length - 1,
					abortedChildTasks: tasks.filter(
						(task) => task.conversationId !== ROOT_CONVERSATION_ID && task.state.outcome?.status === "aborted",
					).length,
					peak: site.peak,
					ticks: lines(site.ticks).map(Number),
					reports,
				};
			},
		});
	} finally {
		// A Harness that a failed check left open is closed here, so its directory can go.
		for (const harness of live) await harness.close(context).catch(() => undefined);
		rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

/**
 * One move: start the run, drain at the trial's move time, close the Harness, open the next on the same store and let
 * the run finish there. Throws the drain's error when the drain did not complete.
 */
export async function move(trial: Trial, options?: DrainOptions): Promise<Moved> {
	const { scenario, site } = trial;
	const first = await trial.open();
	await trial.begin(first);
	const started = performance.now();

	// The Harness the host would act on now. There is none between the close and the next open.
	let current: Home | undefined = first;
	const beside = scenario.beside;
	const besideAtMs = beside === undefined ? 0 : Math.max(0, trial.moveAtMs + site.between(...beside.offsetMs));
	let due = beside !== undefined;
	const act = async (): Promise<void> => {
		if (!due || beside === undefined || current === undefined) return;
		due = false;
		try {
			await beside.act(current.root);
		} catch {
			// The Harness closed under the call, so the next one takes it.
			due = true;
		}
	};
	let acting: Promise<void> = Promise.resolve();
	const timer =
		beside === undefined
			? undefined
			: setTimeout(() => {
					acting = act();
				}, besideAtMs);

	try {
		await sleep(trial.moveAtMs);
		const drained = await first.gate.drain(options, context);
		if (!drained.ok) throw drained.error;
		current = undefined;
		await first.harness.close(context);
		const ticksAtClose = lines(site.ticks).length;
		const second = await trial.open();
		current = second;
		if (beside !== undefined) {
			// An action that was due while no Harness was open, or that the close rejected, is done on the second.
			await sleep(started + besideAtMs - performance.now());
			await acting;
			await act();
		}
		return { drained: drained.value, ticksAtClose, outcome: await trial.finish(second) };
	} finally {
		clearTimeout(timer);
	}
}
