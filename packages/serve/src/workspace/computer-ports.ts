// A desktop's or a phone's one port, as the kernel registry's computer tools reach it (run-adapters kernel/registry
// Hands.computer), over the computer's client: @parcha/agentrun-computer's surface, the one core that answers a per-step
// tool, a script (computer-script.ts) and the claim's MCP endpoint (computer-mcp.ts) alike. A phone with no computerd
// (daemon none) answers the same methods in process, so one port fits both. A refusal throws the computer's kind and
// words.
import type { ComputerClient, HelloResult } from "@parcha/agentrun-computer";
import { createSurface, type Surface } from "@parcha/agentrun-computer/surface";
import type { ComputerPort } from "@parcha/agentrun-kernel/kernel";

/** The port of a computer's surface. */
export const portOf = (surface: Surface): ComputerPort => ({
  groups: surface.card.groups,
  call: (op, args, signal) => surface.call(op, args, signal ? { signal } : {}),
});

/** What the computer says it is: its hello, asked again over its client, since the run's computer carries only its
 *  groups (resolve-computer.ts). A client that answers no hello (an in-process fake) is taken as `kind` says, with
 *  those groups. */
export async function helloOf(client: ComputerClient, kind: "desktop" | "phone", groups: readonly string[]): Promise<HelloResult> {
  const said = await client.call("hello", { client: "agentrun-serve" });
  if (said.ok) return said.value;
  return { protocol: "", version: "", os: kind === "phone" ? "android" : "linux", kind: kind === "phone" ? "android" : "desktop", arch: "", groups: [...groups] as HelloResult["groups"] };
}

/** The surface of a run's desktop or phone, over its client, from its hello. */
export async function surfaceOf(client: ComputerClient, kind: "desktop" | "phone", groups: readonly string[]): Promise<Surface> {
  const hello = await helloOf(client, kind, groups);
  // The run's groups are what the claim saw at connect: they hold, whatever a second hello says.
  return createSurface(client, { ...hello, groups: [...groups] as HelloResult["groups"] });
}
