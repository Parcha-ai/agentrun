// Every home tool call that is not replay-safe runs only once its intent is durable. pi-durable commits a call's intent
// (its task's `execute` checkpoint) and then runs the tool's `execute`; this wraps `execute`, so the barrier comes after
// the intent's commit and before the effect. A `beforeTool` hook would be too early: it runs before the intent is
// committed, so after a box loss the call resumes from before its intent and runs again.
import { defineExtension, type Registry, type ToolRegistration, wrapTool } from "@earendil-works/pi-durable";
import { type SyncTarget, syncNow } from "./sync-now.ts";

export const TOOL_BARRIER_EXTENSION = "home-tool-barrier";

/** Wraps, by name, every tool in `registry` that is not replay-safe. Install it after every other extension. */
export function toolBarrier(registry: Registry, store: SyncTarget) {
	const unsafe = new Map<string, ToolRegistration>();
	for (const { tool } of registry.snapshot().tools()) if (tool.replay !== "safe") unsafe.set(tool.name, tool);
	return defineExtension({
		name: TOOL_BARRIER_EXTENSION,
		wraps: [...unsafe.values()].map((tool) =>
			wrapTool(tool, (inner) => ({
				...inner,
				async execute(args, api, context) {
					await syncNow(store, "homeToolIntent");
					return inner.execute(args, api, context);
				},
			})),
		),
	});
}
