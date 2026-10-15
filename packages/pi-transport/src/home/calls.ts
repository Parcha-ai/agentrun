import { defineExtension, hook, type Registry, ToolTask } from "@earendil-works/pi-durable";

/** The name of the extension that reports tool calls. */
export const CALLS_EXTENSION = "transport-calls";

/**
 * A tool call as the host is told of it: the call's id, the tool's name and whether the tool may run again after a
 * crash. Never the arguments: they may hold secrets, and the name says enough in a notice.
 */
export type CallEvent = {
	readonly phase: "start" | "end";
	readonly id: string;
	readonly tool: string;
	/** `safe` when the tool is registered `replay: "safe"`; anything else is `unsafe`. */
	readonly replay: "safe" | "unsafe";
};

/**
 * The extension that tells `report` when a tool call begins and ends. It changes nothing about the call. Install it
 * after the gate's extension, so that a call is reported only once the gate let it through.
 */
export function callsExtension(registry: Registry, report: (event: CallEvent) => void | Promise<void>) {
	const replayOf = (name: string): "safe" | "unsafe" =>
		registry
			.snapshot()
			.tools()
			.find((entry) => entry.tool.name === name)?.tool.replay === "safe"
			? "safe"
			: "unsafe";
	return defineExtension({
		name: CALLS_EXTENSION,
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call) => {
					await report({ phase: "start", id: String(call.id), tool: call.name, replay: replayOf(call.name) });
					return undefined;
				},
				afterTool: (call) => {
					report({ phase: "end", id: String(call.id), tool: call.name, replay: replayOf(call.name) });
					return undefined;
				},
			}),
		],
	});
}
