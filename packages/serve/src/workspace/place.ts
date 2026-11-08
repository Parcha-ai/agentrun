// Where a run's tools run: an agent's v2 `place`, resolved to a computer or to none. Pure: what the server has is
// passed in. place { mode: "runner" } is no computer (the Workspace itself); place { mode: "sandbox", box } is the
// computer provider of that id. An absent place is the server's default: in Mode 1 (one machine, no disk account) the
// local Docker computer where Docker answers, else the runner; in Mode 2 (the workspaces on the owner's disk) the
// runner. A workflow always gets the runner. Mode 1 refuses every box but docker: a remote computer cannot reach a
// folder on this machine. Mode 2 refuses docker: the run's folder is on the owner's disk, which the server never
// mounts, so a local bind has nothing to bind. Every mode refuses a provider with no key.

/** The computer providers a place can name (module D's registry). */
export const PROVIDERS = ["docker", "daytona", "modal", "e2b"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** The v2 place, as an agent's definition holds it. */
export type Place = { readonly mode: "runner" } | { readonly mode: "sandbox"; readonly box: string };

/** What the server has: Docker answering on this machine, and the remote providers it holds a key for. */
export type Available = { readonly docker: boolean; readonly keyed: ReadonlySet<string> };

/** A computer of that provider, none (the Workspace itself), or a refusal in words. */
export type Resolved = { readonly computer: ProviderId | null } | { readonly refused: string };

const isProvider = (id: string): id is ProviderId => (PROVIDERS as readonly string[]).includes(id);

export function resolvePlace(mode: 1 | 2, place: Place | undefined, kind: "agentic" | "workflow", available: Available): Resolved {
  if (kind === "workflow") return { computer: null };
  if (place === undefined) return { computer: mode === 1 && available.docker ? "docker" : null };
  if (place.mode === "runner") return { computer: null };
  const { box } = place;
  if (!isProvider(box)) return { refused: `place sandbox names "${box}", which is not a computer this server knows (${PROVIDERS.join(", ")}).` };
  if (box === "docker") {
    if (mode === 2) return { refused: "place sandbox asks for Docker, and in Mode 2 the run's folder is on the owner's disk, which this server never mounts: a local Docker computer has nothing to bind. Use a remote computer, or place runner." };
    return available.docker ? { computer: "docker" } : { refused: "place sandbox asks for Docker, and Docker is not answering on this machine: start Docker, or run this agent with place runner." };
  }
  if (mode === 1) return { refused: `place sandbox asks for ${box}, a remote computer, and Mode 1 runs only the local Docker computer: a remote computer cannot reach a folder on this machine. Use box docker, or place runner.` };
  if (!available.keyed.has(box)) return { refused: `place sandbox asks for ${box}, and this server holds no key for it: add its key, or pick another place.` };
  return { computer: box };
}
