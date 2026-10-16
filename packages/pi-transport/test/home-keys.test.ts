import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createKeys, type KeyedRequest, requestKey } from "../src/home/keys.ts";

const model = { provider: "faux", id: "faux-1" } as Model<Api>;
const system = {
	role: "system",
	content: "",
	sections: { instructions: "<instructions>\nBe brief.\n</instructions>" },
	toolsAdded: [
		{
			name: "lookup",
			description: "Look a thing up.",
			parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
		},
	],
	timestamp: 1,
};
const user = { role: "user", content: "What does it cost?", timestamp: 2 };
const request: KeyedRequest = { model, messages: [system, user], options: { sessionId: "s", temperature: 0.2 } };

describe("a model request's key", () => {
	it("is the same for the same request of the same generation, whatever order its fields are in", () => {
		const key = requestKey("session-1", "task-7", request);
		expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
		const reordered: KeyedRequest = {
			model,
			messages: [
				{ timestamp: 1, toolsAdded: system.toolsAdded, sections: system.sections, content: "", role: "system" },
				user,
			],
			options: { temperature: 0.2, sessionId: "s" },
		};
		expect(requestKey("session-1", "task-7", reordered)).toBe(key);
	});

	it("changes with the instructions, a tool, the question, the options, the model, the generation or the session", () => {
		const key = requestKey("session-1", "task-7", request);
		const tool = system.toolsAdded[0];
		const changed: [string, string][] = [
			[
				"instructions",
				requestKey("session-1", "task-7", {
					...request,
					messages: [{ ...system, sections: { instructions: "<instructions>\nBe long.\n</instructions>" } }, user],
				}),
			],
			[
				"a tool's description",
				requestKey("session-1", "task-7", {
					...request,
					messages: [{ ...system, toolsAdded: [{ ...tool, description: "Find a thing." }] }, user],
				}),
			],
			[
				"a tool's parameters",
				requestKey("session-1", "task-7", {
					...request,
					messages: [
						{
							...system,
							toolsAdded: [{ ...tool, parameters: { type: "object", properties: {}, required: [] } }],
						},
						user,
					],
				}),
			],
			[
				"the question",
				requestKey("session-1", "task-7", { ...request, messages: [system, { ...user, content: "And now?" }] }),
			],
			[
				"the options",
				requestKey("session-1", "task-7", { ...request, options: { sessionId: "s", temperature: 0.9 } }),
			],
			["the model", requestKey("session-1", "task-7", { ...request, model: { ...model, id: "faux-2" } })],
			["the generation", requestKey("session-1", "task-8", request)],
			["the session", requestKey("session-2", "task-7", request)],
		];
		for (const [what, other] of changed) expect(other, what).not.toBe(key);
	});

	it("names the generation that asked, when two ask at once, and nothing for a request no hook marked", async () => {
		const keys = createKeys("session-1", () => 42);
		const registration = keys.extension.hooks?.[0] as unknown as {
			readonly handlers: {
				beforeRequest(
					request: { readonly messages: readonly unknown[] },
					api: { readonly taskId: string },
					context: unknown,
				): { readonly messages: readonly unknown[] } | undefined;
			};
		};
		const mark = (task: string, content: string) =>
			registration.handlers.beforeRequest(
				{ messages: [system, { ...user, content }] },
				{ taskId: task },
				BACKGROUND_CONTEXT,
			)?.messages ?? [];
		const first = mark("task-a", "first");
		const second = mark("task-b", "second");
		// What the provider sees is what it would have seen: the mark is a copy.
		expect(JSON.stringify(first)).toBe(JSON.stringify([system, { ...user, content: "first" }]));
		// pi and pi-ai pass the messages on in new arrays: the mark is the message, not the array.
		const asked = (messages: readonly unknown[]): KeyedRequest => ({ model, messages: [...messages], options: {} });
		expect(keys.keyOf(asked(second))).toEqual({
			key: requestKey("session-1", "task-b", asked(second)),
			position: 42,
		});
		expect(keys.keyOf(asked(first))).toEqual({ key: requestKey("session-1", "task-a", asked(first)), position: 42 });
		expect(keys.keyOf(asked([system, user]))).toBeUndefined();
		// No store open: no position, so no key.
		expect(createKeys("session-1", () => undefined).keyOf(asked(first))).toBeUndefined();
	});
});
