// A runner for the box place's paid-answer case: one pi agent turn on the host's faux model, and the answer it got. A
// runner that comes back after its box was lost resumes the same turn: its generation asks again with the same key.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { App } from "../src/home/app.ts";
import { runMain } from "../src/home/main.ts";

const app: App = (ctx) => {
	const root = { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: ctx.workspace } };
	return {
		registry: createRegistry(),
		root,
		async onResumed(harness, context) {
			const conversation = await harness.root(context, root);
			// Admitted once for the conversation: a runner that comes back adds no second question.
			await conversation.submit({ type: "input", content: "the question", requestId: "the-question" }, context);
			await conversation.waitForIdle(context);
			const { messages } = await conversation.context(context);
			const last = messages.filter((message) => message.role === "assistant").at(-1) as AssistantMessage | undefined;
			const answer = last?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? null;
			// A restore's notice is the session's too: count the question only.
			const questions = messages.filter(
				(message) => message.role === "user" && message.content === "the question",
			).length;
			console.log(
				JSON.stringify({ outcome: { status: "complete", generation: ctx.epoch, record: { answer, questions } } }),
			);
		},
	};
};

await runMain(app);
