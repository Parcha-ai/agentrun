// The conformance suite's tools as a session's host tools (the kernel's HostTool), for a subject that builds its own
// session spec (an adapter loop's, createAdapterLoop): each runs the suite's tool, replay-safe or at most once as the
// suite says. What a harness author's conformance file hands its adapter (`@parcha/agentrun-serve/conformance`).
import type { HostTool, JsonValue, ToolImage } from "@parcha/agentrun-kernel";
import type { SuiteTool } from "./subject.js";

/** A suite tool with what some cases add to its answer: images, and a structured result. */
type Answering = SuiteTool & { readonly images?: readonly ToolImage[]; readonly structured?: JsonValue };

/** The suite's `tools` (setup.tools) as host tools, in their order. */
export function suiteHostTools(tools: Readonly<Record<string, SuiteTool>>): HostTool[] {
  return Object.values(tools as Readonly<Record<string, Answering>>).map((tool): HostTool => ({
    name: tool.name,
    description: `The suite's ${tool.name} tool.`,
    inputSchema: { type: "object", properties: {} },
    replay: tool.replaySafe ? "safe" : "never",
    call: async (args, context) => ({
      text: String(await tool.run((args ?? {}) as Record<string, unknown>, context.signal)),
      ...(tool.images ? { images: tool.images } : {}),
      ...(tool.structured !== undefined ? { structured: tool.structured } : {}),
    }),
  }));
}
