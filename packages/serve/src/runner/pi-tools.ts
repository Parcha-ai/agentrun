// A run's host tools as the pi loop's tools (PiRunSpec.tools). The kernel registry holds the tool definitions, words and
// limits; runTools (serve/src/workspace/run-tools.ts) binds them to the run's Workspace, hands and executors and gives
// them as the kernel's HostTool. This hands each to the pi loop as a PiTool: its definition unchanged, its run the host
// tool's own call. The allow/ask/deny gate is the loop's (PiRunSpec.gate), so these are bound WITHOUT a gate here; a
// call's answer is the registry's, path-relativized as a host renders it (run-tools.ts bindTools), which the pi loop
// gives the model.
import { randomUUID } from "node:crypto";
import type { HostTool } from "@parcha/agentrun-kernel";
import type { RunTools } from "../workspace/run-tools.js";
import type { PiTool } from "./loop.js";

/** A kernel host tool as a pi tool: its name, words, schema and replay, and a run that calls it. The call id is the pi
 *  loop's turn's when the loop drives it; here, where the loop's gate decides allow/ask/deny and the result is read from
 *  the run's journal rather than kept by call id, a fresh id is enough. */
export function piToolOf(host: HostTool): PiTool {
  return {
    name: host.name,
    description: host.description,
    parameters: host.inputSchema,
    replaySafe: host.replay === "safe",
    run: async (args, signal) => (await host.call(args, { callId: randomUUID(), signal, attempt: 0 })).text,
  };
}

/** The run's host tools `names` names, as pi tools, bound by `tools` (runTools) to the run; a name the registry does not
 *  hold is left out, as runTools leaves it out. The loop's gate wraps them, so none is bound with a gate here. */
export function piToolsOf(tools: RunTools, names: readonly string[]): PiTool[] {
  return tools.hostTools(names).map(piToolOf);
}
