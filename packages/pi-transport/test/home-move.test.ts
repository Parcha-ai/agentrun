import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import type { App } from "../src/home/app.ts";
import { type HomeOptions, MOVE_ENTRY, openHome } from "../src/home/run.ts";
import { moveFile, moveWorkspace } from "../src/home/workspace.ts";
import { textResult } from "../src/testing/tool-result.ts";

const context = BACKGROUND_CONTEXT;
const ROUNDS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lines of the session's own file in a box's workspace: one for each time the tool ran. */
function lines(box: Box): string[] {
	const file = join(box.facts().workspace, "effects.log");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}

describe("a home moves between two boxes with no shared disk", () => {
	it("carries the store and the workspace over, and the session goes on in its own files with nothing cut", async () => {
		for (const afterMs of [20, 110, 200]) {
			const directory = mkdtempSync(join(tmpdir(), "pi-transport-move-"));
			const provider = localBoxes({ root: join(directory, "boxes") });
			const first = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000 }, context));
			const second = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000 }, context));
			try {
				const faux = fauxProvider();
				const models = createModels();
				models.setProvider(faux.provider);
				let requests = 0;
				// A stateless model: one call of `work` for each round, then a last word.
				faux.setResponses(
					Array.from({ length: 100 }, () => async (transcript: { messages: readonly { role: string }[] }) => {
						requests += 1;
						await sleep(15);
						const done = transcript.messages.filter((message) => message.role === "toolResult").length;
						if (done >= ROUNDS) return fauxAssistantMessage("done");
						return fauxAssistantMessage(fauxToolCall("work", { n: done }, { id: `call-${done}-${requests}` }), {
							stopReason: "toolUse",
						});
					}),
				);
				const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
				// The tool's effect is a line in a file of the workspace, written through the conversation's environment.
				const work = defineTool({
					name: "work",
					description: "Do one unit of work with an effect.",
					parameters: Type.Object({ n: Type.Number() }),
					async execute(args, api) {
						await sleep(30);
						if (api.env === undefined) throw new Error("the tool has no environment");
						getOrThrow(await api.env.appendFile("effects.log", `${args.n}\n`, context));
						await sleep(10);
						return textResult(`did ${args.n}`);
					},
				});
				const app: App = (ctx) => {
					const registry = createRegistry();
					registry.install(defineExtension({ name: "work", tools: [work] }));
					return { registry, root: { agent: { model, cwd: ctx.workspace } } };
				};
				const homeIn = (box: Box, environment: string): HomeOptions => ({
					app,
					session: "session-1",
					store: join(dirname(box.facts().workspace), "session", "run.sqlite"),
					workspace: box.facts().workspace,
					where: { environment, provider: "local" },
					models,
				});

				const from = homeIn(first, "a");
				const source = getOrThrow(await openHome(from));
				getOrThrow(await source.resume({ epoch: 1 }, context));
				const started = getOrThrow(await source.root(context));
				await started.submit({ type: "input", content: "go" }, context);
				await sleep(afterMs);
				getOrThrow(await source.drain({ timeoutMs: 5_000 }, context));
				const seal = getOrThrow(await source.seal(context));
				const before = lines(first);

				// The host's part: both moves go through the boxes, checked on the target.
				const to = homeIn(second, "b");
				getOrThrow(await moveWorkspace(first, second, { fromRoot: from.workspace, toRoot: to.workspace }, context));
				getOrThrow(await moveFile(first, from.store, second, to.store, seal, undefined, context));

				const target = getOrThrow(await openHome(to));
				const move = {
					id: `move-${afterMs}`,
					notice: "System notice: you now run in another box. Your files came with you.",
					roots: { from: from.workspace, to: to.workspace },
				};
				getOrThrow(await target.resume({ epoch: 2, seal, move }, context));
				const root = getOrThrow(await target.root(context));
				await root.waitForIdle(context);

				const page = await root.entries({}, 500, undefined, context);
				const texts = page.items.map((entry) => JSON.stringify(entry));
				expect(texts.filter((text) => text.includes('"interrupted"') || text.includes('"blocked"'))).toEqual([]);
				expect(texts.some((text) => text.includes('"done"'))).toBe(true);
				expect(page.items.filter((entry) => entry.kind === MOVE_ENTRY).length).toBe(1);
				expect(requests).toBe(ROUNDS + 1);
				// Every round once, in the target's copy of the file. The source's copy stopped where the move began.
				expect(lines(second)).toEqual(Array.from({ length: ROUNDS }, (_, n) => String(n)));
				expect(lines(first)).toEqual(before);
				expect(before.length).toBeLessThan(ROUNDS);
				expect((await target.harness?.snapshot(AgentDoc, root.id, context))?.cwd).toBe(to.workspace);

				getOrThrow(await source.retire({ epoch: 2 }, context));
				expect(existsSync(from.store)).toBe(false);
				await target.close(context);
			} finally {
				await first.destroy(context);
				await second.destroy(context);
				rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
			}
		}
	}, 60_000);
});
