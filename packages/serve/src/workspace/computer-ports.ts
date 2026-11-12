// A desktop's or a phone's one port, as the kernel registry's computer tools reach it (run-adapters kernel/registry
// Hands.computer), over the computer's surface (@parcha/agentrun-computer's createSurface, made in run-tools.ts from the
// hello the claim connected it with): the one core that answers a per-step tool, a script (computer-script.ts) and the
// claim's MCP endpoint (computer-mcp.ts) alike. A phone with no computerd (daemon none) answers the same methods in
// process, so one port fits both. A refusal throws the computer's kind and words.
import type { Surface } from "@parcha/agentrun-computer/surface";
import type { ComputerPort } from "@parcha/agentrun-kernel/kernel";

/** The port of a computer's surface. */
export const portOf = (surface: Surface): ComputerPort => ({
  groups: surface.card.groups,
  call: (op, args, signal) => surface.call(op, args, signal ? { signal } : {}),
});
