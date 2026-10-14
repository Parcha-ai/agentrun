import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { textResult } from "../src/testing/tool-result.ts";

const context = BACKGROUND_CONTEXT;

type Said = { readonly role: string; readonly content?: unknown };
const textOf = (message: Said) =>
	Array.isArray(message.content)
		? message.content.map((part) => (part as { text?: unknown }).text ?? "").join("")
		: String(message.content ?? "");

describe("a tool result this package writes", () => {
	// pi-durable up to 1.1 reads a result's `content`, 1.2 its `output`: the other key alone reaches the model empty.
	it("reaches the model as its text on the pi this run loaded", async () => {
		const seen: string[] = [];
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			() => fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
			(transcript: { messages: readonly Said[] }) => {
				for (const message of transcript.messages) if (message.role === "toolResult") seen.push(textOf(message));
				return fauxAssistantMessage("done");
			},
		]);
		const echo = defineTool({
			name: "echo",
			description: "Answer with a fixed text.",
			parameters: Type.Object({}),
			async execute() {
				return textResult("the result's text");
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "echo", tools: [echo] }));
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
			const root = await harness.root(context, { agent: { model } });
			harness.resume();
			await root.submit({ type: "input", content: "go" }, context);
			await root.waitForIdle(context);
			expect(seen).toEqual(["the result's text"]);
		} finally {
			await harness.close(context);
		}
	}, 30_000);
});
