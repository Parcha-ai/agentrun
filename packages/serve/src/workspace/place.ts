// Where a run's tools run: an agent's v2 `place`, resolved to a computer or to none. Pure: the computer providers and
// what the server has are passed in, from module D's registry (its provider ids, and each provider's mount kinds), so a
// new provider changes nothing here. A provider whose mounts include "bind" is a LOCAL computer (it can bind a folder
// of this machine); any other is remote. place { mode: "runner" } is no computer (the Workspace itself); place
// { mode: "sandbox", box } is the provider of that id. An absent place is the server's default: in Mode 1 (one machine,
// no disk account) the first local provider that answers here, else the runner; in Mode 2 (the workspaces on the
// owner's disk) the runner. A workflow always gets the runner. Mode 1 allows only a local provider: a remote computer
// cannot reach a folder on this machine. Mode 2 refuses a local provider: the run's folder is on the disk, which the
// server never mounts. Every mode refuses a remote provider with no key, and a local one that does not answer.
// The registry is passed in: the cutover passes D's providerIds and each provider module's MOUNT.
import type { MountKind } from "@parcha/agentrun-computer";

/** The v2 place, as an agent's definition holds it. */
export type Place = { readonly mode: "runner" } | { readonly mode: "sandbox"; readonly box: string };

/** Module D's registry, as place needs it: the provider ids, in its order, and each one's mount kinds. */
export type Registry = { readonly ids: readonly string[]; mounts(id: string): Promise<readonly MountKind[]> };

/** What the server has: the local providers that answer on this machine, and the remote ones it holds a key for. */
export type Available = { readonly answering: ReadonlySet<string>; readonly keyed: ReadonlySet<string> };

/** A computer of that provider, none (the Workspace itself), or a refusal in words. */
export type Resolved = { readonly computer: string | null } | { readonly refused: string };

/** The lead's words for a local computer asked for in Mode 2. */
const MODE_2_LOCAL = "Mode 2 keeps workspaces on Archil; a local Docker computer can't mount them. Use a remote box or place runner.";

const isLocal = async (registry: Registry, id: string): Promise<boolean> => (await registry.mounts(id)).includes("bind");

export async function resolvePlace(mode: 1 | 2, place: Place | undefined, kind: "agentic" | "workflow", registry: Registry, available: Available): Promise<Resolved> {
  if (kind === "workflow") return { computer: null };
  if (place === undefined) {
    if (mode === 2) return { computer: null };
    for (const id of registry.ids) if (available.answering.has(id) && (await isLocal(registry, id))) return { computer: id };
    return { computer: null };
  }
  if (place.mode === "runner") return { computer: null };
  const { box } = place;
  if (!registry.ids.includes(box)) return { refused: `place sandbox names "${box}", which is not a computer this server knows (${registry.ids.join(", ")}).` };
  if (await isLocal(registry, box)) {
    if (mode === 2) return { refused: MODE_2_LOCAL };
    return available.answering.has(box) ? { computer: box } : { refused: `place sandbox asks for ${box}, and it is not answering on this machine: start it, or run this agent with place runner.` };
  }
  if (mode === 1) return { refused: `place sandbox asks for ${box}, a remote computer, and Mode 1 runs only a local computer: a remote computer cannot reach a folder on this machine. Use a local box, or place runner.` };
  if (!available.keyed.has(box)) return { refused: `place sandbox asks for ${box}, and this server holds no key for it: add its key, or pick another place.` };
  return { computer: box };
}
