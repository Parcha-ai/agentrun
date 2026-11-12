// A paired computer (a person's own, attached over the attach binding: computer-attach.ts) as the claim and Settings see
// it: one provider of the kind registry, whose id is the computer's own (cmp-...), whose label is its name, and whose one
// configuration is the kind and groups it paired as. An agent's computer setting names it as its provider, {kind:
// "desktop", provider: "cmp-..."}, so a run resolves, checks and claims it on the one path every computer takes
// (resolve-computer.ts, computer-for-claim.ts), and the computer package's attachedProvider stands in for a vendor's.
//
// Its socket is held by the AttachHub of the server's process: a runner in that process (the CLI's start, its runner
// beside the server) takes it; a runner of its own process cannot reach it and refuses it in ONE_PROCESS_WORDS.
import { type AttachHub, attachedProvider, type ComputerProvider, type HelloResult, type PairedComputer } from "@parcha/agentrun-computer";
import type { PairedComputerRow } from "../store/index.js";
import type { ComputerSettingKind, KindCapabilities, KindRegistry, ProviderEntry } from "./resolve-computer.js";

/** A paired computer's id starts with this; the rest is lowercase letters and digits, so the whole is an id an agent's
 *  computer setting takes as its provider (lowercase letters, digits and dashes). */
export const PAIRED_ID_PREFIX = "cmp-";

/** The image a paired computer's spec names: none is made, so this only says what it is. */
export const ATTACHED_IMAGE = "attached";

/** The words a run gets when its agent's computer is a paired computer and its runner is not in the server's process. */
export const ONE_PROCESS_WORDS = "a paired computer's socket is held by the serve process it dialed, and this runner runs in a process of its own: start AgentRun as one process (agentrun serve, with its runner beside it, not --no-runner) to use a paired computer";

/** What the claim reads of the paired computers: the store's rows (removed ones left out), and the server's hub where
 *  the runner shares its process (absent: a runner of its own process). */
export interface AttachedComputers {
  rows(): Promise<readonly PairedComputerRow[]>;
  readonly hub?: AttachHub;
}

/** The store's row as the hub and attachedProvider take it. */
export const pairedOf = (row: PairedComputerRow): PairedComputer => ({
  id: row.id,
  name: row.name,
  hello: row.hello as unknown as HelloResult,
  labels: { ...row.labels },
});

/** A paired computer as a provider of `registry`: named by its name and its os, as an agent's computer picker lists it;
 *  the setting kinds its paired hello serves, no keys, no mount, the machine's own network ("open": a run never narrows
 *  a person's own machine), never metered. */
export function pairedEntry(row: PairedComputerRow, registry: Pick<KindRegistry, "SETTING_KINDS" | "servingRefusals">): ProviderEntry {
  const hello = row.hello as Partial<HelloResult>;
  const configuration = { kind: String(hello.kind ?? ""), groups: Array.isArray(hello.groups) ? [...hello.groups] : [] } as unknown as KindCapabilities;
  const kinds = (Object.keys(registry.SETTING_KINDS) as ComputerSettingKind[]).filter((kind) => kind !== "none" && registry.servingRefusals(configuration, kind).length === 0);
  return {
    id: row.id,
    label: typeof hello.os === "string" ? `${row.name} (${hello.os})` : row.name,
    kinds,
    keys: [],
    mounts: [],
    network: ["open"],
    metered: false,
    capabilities: [configuration],
    defaultImage: Object.fromEntries(kinds.map((kind) => [kind, ATTACHED_IMAGE])),
  };
}

/** `registry` with each paired computer of `rows` as one more provider (pairedEntry). */
export function withPaired<R extends KindRegistry>(registry: R, rows: readonly PairedComputerRow[]): R {
  if (rows.length === 0) return registry;
  return { ...registry, PROVIDERS: [...registry.PROVIDERS, ...rows.map((row) => pairedEntry(row, registry))] };
}

/** The provider of the paired computer `row`: attachedProvider over the hub, or a refusal in ONE_PROCESS_WORDS where this
 *  process holds no hub. */
export function pairedProvider(row: PairedComputerRow, hub: AttachHub | undefined): ComputerProvider {
  if (hub === undefined) throw Object.assign(new Error(ONE_PROCESS_WORDS), { code: "computer_unavailable" });
  return attachedProvider(pairedOf(row), hub);
}

/** Why the paired computer `row` cannot be had now, in words that say what to do, or undefined: it must be attached (its
 *  driver dialed this server). Asked at a run's start, as a vendor's readiness is; another run's hold is the claim's. */
export function pairedRefusal(row: PairedComputerRow, hub: Pick<AttachHub, "online"> | undefined): string | undefined {
  if (hub === undefined) return ONE_PROCESS_WORDS;
  if (!hub.online(row.id)) return `This agent's computer is ${row.name}, which is not attached now: open its driver on that computer, which dials this server, then start the run again.`;
  return undefined;
}
