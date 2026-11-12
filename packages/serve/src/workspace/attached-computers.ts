// A paired computer (a person's own, attached over the attach binding: computer-attach.ts) as the claim and Settings see
// it: one provider of the kind registry, whose id is the computer's own (cmp-...), whose label is its name, and whose one
// configuration is the kind and groups it paired as. An agent's computer setting names it as its provider, {kind:
// "desktop", provider: "cmp-..."}, so a run resolves, checks and claims it on the one path every computer takes
// (resolve-computer.ts, computer-for-claim.ts), and the computer package's attachedProvider stands in for a vendor's.
//
// Its socket is held by the AttachHub of the server's process: a runner in that process (the CLI's start, its runner
// beside the server) takes it; a runner of its own process cannot reach it and refuses it in ONE_PROCESS_WORDS.
import { type AttachHub, attachedProvider, type ComputerProvider, type HelloResult, type PairedComputer, SETTING_KIND_NAMES, SETTING_KINDS } from "@parcha/agentrun-computer";
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

/** What a driver's hello lacks to serve `kind`, by the kind registry's rule (the computer package's SETTING_KINDS, which
 *  servingRefusals reads): "it says desktop but declares no input.pointer, input.keys", "it says android, which no
 *  desktop computer is"; undefined when the hello serves the kind. The one source of a paired computer's words for a
 *  kind it cannot serve: at pairing (servesNoKind) and at a run's start (withPaired's unservedWhy). */
export function helloLacks(hello: Partial<HelloResult>, kind: ComputerSettingKind): string | undefined {
  const spec = SETTING_KINDS[kind];
  const said = String(hello.kind ?? "nothing");
  if (!spec.machineKinds.some((one) => one === hello.kind)) return `it says ${said}, which no ${kind} computer is`;
  const groups: readonly string[] = Array.isArray(hello.groups) ? hello.groups : [];
  const missing = spec.required.filter((group) => !groups.includes(group));
  return missing.length === 0 ? undefined : `it says ${said} but declares no ${missing.join(", ")}`;
}

/** Why `name`'s driver may not pair: its hello serves no kind an agent's computer can be, so no agent could pick it; in
 *  words that say what it lacks and to update the driver. Undefined when it serves one. */
export function servesNoKind(name: string, hello: Partial<HelloResult>): string | undefined {
  const kinds = SETTING_KIND_NAMES.filter((kind) => kind !== "none");
  if (kinds.some((kind) => helloLacks(hello, kind) === undefined)) return undefined;
  // The kind its machine kind is (a desktop's, a phone's) says what is missing; a machine kind no kind takes says that.
  const near = kinds.find((kind) => SETTING_KINDS[kind].machineKinds.some((one) => one === hello.kind));
  const lack = near === undefined ? `it says ${String(hello.kind ?? "nothing")}, which no kind of computer is` : helloLacks(hello, near);
  return `${name}'s driver serves no kind: ${lack}: update the driver on ${name}`;
}

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

/** `registry` with each paired computer of `rows` as one more provider (pairedEntry), and the words for one that cannot
 *  serve a kind an agent asks of it: it is a computer of the person's own, and its driver lacks what the kind needs
 *  (helloLacks), so the driver is what to update. */
export function withPaired<R extends KindRegistry>(registry: R, rows: readonly PairedComputerRow[]): R {
  if (rows.length === 0) return registry;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const unservedWhy = (entry: ProviderEntry, kind: ComputerSettingKind): string | undefined => {
    const row = byId.get(entry.id);
    const lack = row === undefined ? undefined : helloLacks(row.hello as Partial<HelloResult>, kind);
    if (row === undefined || lack === undefined) return registry.unservedWhy?.(entry, kind);
    return `${row.name} is a computer of your own, and its driver gives no ${kind} computer: ${lack}. Update the driver on ${row.name}`;
  };
  return { ...registry, PROVIDERS: [...registry.PROVIDERS, ...rows.map((row) => pairedEntry(row, registry))], unservedWhy };
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
