import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { canonicalJson } from "../canonical.ts";

/** The name of the extension that tells the model proxy which generation asks. */
export const KEYS_EXTENSION = "pi-transport.keys";

/** A request as the model proxy keys it. */
export type KeyedRequest = {
	readonly model: Model<Api>;
	readonly messages: readonly unknown[];
	readonly options: Readonly<Record<string, unknown>>;
};

/**
 * The key a paid answer is kept under: `sha256` of the session, the `pi.generation` task that asks, the model and the
 * request (its messages, the system message with the instructions and the tools among them, and its options). The
 * same generation asking again, after a dropped link or a restore that replayed its intent, has the same key and is
 * answered from the kept answer; a deliberate re-ask is a new generation, a new key, and is paid.
 */
export function requestKey(session: string, task: string, request: KeyedRequest): string {
	const body = canonicalJson({
		v: 1,
		session,
		task,
		model: { provider: request.model.provider, id: request.model.id },
		messages: request.messages,
		options: request.options,
	});
	return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/** The model proxy's keys for one session: the extension that marks each request with its task, and `keyOf`. */
export interface Keys {
	/** Install in the session's registry: before each request it marks the request's last message with its task. */
	readonly extension: Extension;
	/** The key and the store position of a request the extension marked; `undefined` for any other. */
	keyOf(request: KeyedRequest): { readonly key: string; readonly position: number } | undefined;
}

/**
 * Keys for `session`'s requests. pi gives a request hook the generation's task but not the request itself, so the hook
 * hands pi the request's messages with the last one a copy of its own, which pi passes on to the models as it is: the
 * copy names the task. `position` is the store's next sequence, which travels beside the key, outside it.
 */
export function createKeys(session: string, position: () => number | undefined): Keys {
	const tasks = new WeakMap<object, string>();
	return {
		extension: defineExtension({
			name: KEYS_EXTENSION,
			hooks: [
				hook(GenerationTask, {
					beforeRequest: (request, api) => {
						const last = request.messages.at(-1);
						if (last === undefined) return undefined;
						const marked = { ...last };
						tasks.set(marked, String(api.taskId));
						return { messages: [...request.messages.slice(0, -1), marked] };
					},
				}),
			],
		}),
		keyOf(request) {
			const last = request.messages.at(-1);
			const task = typeof last === "object" && last !== null ? tasks.get(last) : undefined;
			const at = position();
			if (task === undefined || at === undefined) return undefined;
			return { key: requestKey(session, task, request), position: at };
		},
	};
}
