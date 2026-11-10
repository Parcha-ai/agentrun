// The claim's resolver: an agent's computer setting {kind, provider}, in the server's mode, read against the computer
// module's kind registry (its setting kinds and provider entries), gives how to start the computer for the run, whether
// it mounts the run's folder, and which of the kernel's ports it fills; or a refusal in words that name the setting
// (Settings → Computers). The runner's harness start calls it at the claim, starts the computer, and hands it to
// runTools (run-tools.ts), which follows the mount decided here. Pure until start: the registry, the saved keys and the
// launch of a vendor's computer are passed in, so a new provider is one entry in the registry and changes nothing here.
//
// The run's folder is mounted only when the kind has files and exec AND the provider mounts the mode's folder: Mode 1's
// is a folder of this machine (a bind), Mode 2's is on Archil (an archil mount). A sandbox must mount it: Mode 1 refuses
// a sandbox that is not Docker's (only a bind reaches this machine), Mode 2 refuses Docker's (it cannot mount Archil). A
// desktop, a phone and a browser are allowed in both modes: a desktop mounts only where its provider mounts the mode's
// folder and it offers files and exec; a phone and a browser never do. A provider whose required keys are not all saved
// is refused here, before anything starts; start hands the provider its declared keys alone.
//
// Where the run's shell is follows the mount (shellPlaceOf): in the computer that mounts the folder; with none, Archil's
// serverless exec in Mode 2 (bash only); in Mode 1 none at all, since the folder is one of this server's own and a
// command there would run on the server itself. runShellOf reads it off a setting before anything starts (the tool
// plane shows bash unavailable by it), and the claim's runTools takes the same rule over the computer it started.
import type { CdpSession, ShellPlace } from "@parcha/agentrun-kernel/kernel";
import type { ComputerClient, ComputerSettingKind, Group, KindCapabilities, MountKind, MountReadBack, MountSpec, ProviderEntry, Result } from "@parcha/agentrun-computer";
import { BROWSER_COMPUTER_REFUSED, isRefusedBrowserComputer } from "../computer-setting.js";
import type { MountCheck } from "./attach.js";
import type { RunComputer } from "./run-tools.js";
import type { Workspace } from "./workspace.js";

/** The setting kind (what an agent is given, not a computer's capabilities().kind), a machine's kind and groups, and one
 *  provider of the kind registry: the computer module's own types. Where a run's shell is: the kernel registry's. */
export type { ComputerSettingKind, KindCapabilities, ProviderEntry, ShellPlace };

/** An agent's computer setting. */
export type ComputerSetting = { readonly kind: string; readonly provider?: string | null };

/** The computer module's kind registry (src/kinds.ts), by its own names: the setting kinds, why a machine does not serve
 *  one (servingRefusals, whose words a refusal here carries), and the providers. */
export type KindRegistry = {
  readonly SETTING_KINDS: Readonly<Record<ComputerSettingKind, unknown>>;
  servingRefusals(capabilities: KindCapabilities, kind: ComputerSettingKind): string[];
  readonly PROVIDERS: readonly ProviderEntry[];
};

/** A computer a provider started for the run: its ref, its computerd client and what it offers (sandbox, desktop,
 *  phone), the read-back of its mount (when mounted), its CDP connect (browser), and its release. */
export type LaunchedComputer = {
  readonly id: string;
  readonly groups: readonly (Group | string)[];
  readonly client?: ComputerClient;
  readBack?(): Promise<Result<MountReadBack>>;
  connect?(): Promise<CdpSession>;
  release(): Promise<void>;
};

/** The claim's side: the keys saved for a provider (Settings → Computers; values, never shown), and the launch of one
 *  computer of the kind, with the run's folder as its mount when it mounts it. A launch that fails throws its words. */
export type ClaimSide = {
  keysOf(provider: string): Promise<Readonly<Record<string, string>>>;
  /** Whether a provider that binds a folder of this machine (Docker) answers here now: the Mode 1 default asks it. */
  answers(provider: string): Promise<boolean>;
  launch(entry: ProviderEntry, spec: { readonly kind: ComputerSettingKind; readonly keys: Readonly<Record<string, string>>; readonly mount?: MountSpec; readonly signal?: AbortSignal }): Promise<LaunchedComputer>;
};

/** A narrow port of the kernel's hands a computer fills: files, exec and processes where the folder is mounted; a
 *  desktop's screen and input; a phone; a browser. */
export type Port = "files" | "exec" | "processes" | "screen" | "input" | "phone" | "browser";

/** A provider's keys as the claim reads them: each key its registry entry declares, by `keyOf` (the server's reader:
 *  key-meta.ts keyReader, the environment's value, else the saved one); a key with no value is left out. */
export const providerKeys = (registry: Pick<KindRegistry, "PROVIDERS">, keyOf: (name: string) => Promise<string | undefined>): ClaimSide["keysOf"] =>
  async (provider) => {
    const keys: Record<string, string> = {};
    for (const key of registry.PROVIDERS.find((one) => one.id === provider)?.keys ?? []) {
      const value = await keyOf(key.name);
      if (value !== undefined) keys[key.name] = value;
    }
    return keys;
  };

/** Whether an agent's computer `setting` can be had in `mode` now, by the answers the claim gives (resolveComputer: the
 *  kind, the provider and what it serves, the mode's mount, the provider's keys by `keyOf`): ok, or its refusal in words
 *  that name the fix. Nothing starts. A run's start asks it before the run is made (runnable.ts).
 *
 *  `answers`: whether a provider that binds a folder of this machine (Docker) answers here now, or why not, in words
 *  that say how to fix it (the server's start-time probe of it). A Mode 1 sandbox on such a provider is refused in those
 *  words here, at the start, where the claim would only fail to launch it. Asked here, not in resolveComputer: the claim
 *  has no such answer and launches it. Absent: not asked. */
export async function computerReadiness(setting: ComputerSetting, mode: 1 | 2, registry: KindRegistry, keyOf: (name: string) => Promise<string | undefined>, answers?: (provider: string) => true | string): Promise<{ readonly ok: true } | { readonly refused: string; readonly box?: string }> {
  // A browser computer saved before its save was refused: refused here, at the start, never a failure once the run works.
  if (isRefusedBrowserComputer(setting.kind)) return { refused: BROWSER_COMPUTER_REFUSED };
  const resolved = await resolveComputer(setting, mode, registry, {
    keysOf: providerKeys(registry, keyOf),
    // A setting is given, so the Mode 1 default (the only asker) is never read; and nothing is launched.
    answers: async () => false,
    launch: async () => { throw new Error("a readiness check starts no computer"); },
  });
  if ("refused" in resolved) return { refused: resolved.refused };
  const entry = registry.PROVIDERS.find((one) => one.id === resolved.provider);
  const why = mode === 1 && resolved.mounts && entry?.mounts.includes("bind") && answers ? answers(entry.id) : true;
  // It names the box whose probe said no (a refusal's details.box), as the box check did.
  if (why !== true) return { refused: `This agent's computer is a ${entry!.label} ${resolved.kind}, and this server cannot run it: ${why.replace(/[.!?]+$/, "")}.`, box: entry!.id };
  return { ok: true };
}

/** The run's computer started: what runTools takes (none for kind none), and its release, after the run's end. */
export type StartedComputer = { readonly computer: RunComputer | undefined; release(): Promise<void> };

/** A setting resolved: its kind and provider, whether the run's folder is mounted, the ports, and how to start it. */
export type ResolvedComputer = {
  readonly kind: ComputerSettingKind;
  readonly provider: string | null;
  readonly mounts: boolean;
  readonly ports: readonly Port[];
  /** Starts the computer, mounting `workspace`'s folder when it mounts; `check` is the mount check attach runs (the
   *  claim's epoch bound in). A computer that cannot be had throws with code computer_unavailable and the words. */
  start(run: { readonly workspace: Workspace; readonly check: MountCheck; readonly signal?: AbortSignal }): Promise<StartedComputer>;
};

const SETTINGS = "Settings → Computers";
const FOLDER_PORTS: readonly Port[] = ["files", "exec", "processes"];

const unavailable = (words: string): Error => Object.assign(new Error(words), { code: "computer_unavailable" });
const nothing = async (): Promise<void> => {};

/**
 * Where a run's shell is, from whether a computer mounts its folder and the server's mode:
 * - "computer": a computer mounts the folder (a sandbox, or a desktop with files and exec whose provider mounts it);
 *   bash and the background tools run there;
 * - "local": none does, in Mode 2: the folder is on Archil, and a command runs on Archil's serverless exec, a fresh
 *   container holding the run's folder alone, never a process of this server; bash only;
 * - "none": none does, in Mode 1: the folder is one of this server's own, and a command there would run on the server
 *   itself, able to read its data and its keys; no bash family at all, the file tools alone (confined to the folder).
 */
export function shellPlaceOf(mounts: boolean, mode: 1 | 2): ShellPlace {
  if (mounts) return "computer";
  return mode === 2 ? "local" : "none";
}

/** Whether a computer of `kind` on `entry` mounts the run's folder in `mode`: the kind has files and exec (a
 *  configuration of the provider that serves the kind offers both) and the provider mounts the mode's folder (Mode 1's
 *  a bind of this machine, Mode 2's an Archil mount). A phone and a browser never do. */
function mountsFolder(kind: ComputerSettingKind, entry: ProviderEntry, serving: readonly KindCapabilities[], mode: 1 | 2): boolean {
  const folder: MountKind = mode === 1 ? "bind" : "archil";
  const shell = serving.some((one) => one.groups.includes("files") && one.groups.includes("exec"));
  return (kind === "sandbox" || kind === "desktop") && shell && entry.mounts.includes(folder);
}

/** The configurations of `entry` that serve `kind`. */
const servingOf = (registry: Pick<KindRegistry, "servingRefusals">, entry: ProviderEntry, kind: ComputerSettingKind): KindCapabilities[] => entry.capabilities.filter((one) => registry.servingRefusals(one, kind).length === 0);

/**
 * Where a run of an agent with computer `setting` has its shell in `mode` (shellPlaceOf), read off the setting and the
 * kind registry before anything starts: what the claim's runTools gives the run once its computer is started. "computer"
 * for a sandbox, or a desktop whose provider mounts the folder and offers files and exec; for kind none, a phone, a
 * browser or a desktop that does not mount, Archil's exec in Mode 2 ("local", bash only) and no shell at all in Mode 1
 * ("none"). A setting this server refuses (an unknown kind or provider, a sandbox that cannot mount the mode's folder)
 * runs nothing: "none". The setting is the agent's as saved; where it has none, the caller gives the server's default.
 */
export function runShellOf(setting: ComputerSetting, mode: 1 | 2, registry: Pick<KindRegistry, "SETTING_KINDS" | "servingRefusals" | "PROVIDERS">): ShellPlace {
  const kind = setting.kind as ComputerSettingKind;
  if (!Object.hasOwn(registry.SETTING_KINDS, kind)) return "none";
  if (kind === "none") return shellPlaceOf(false, mode);
  if (!registry.PROVIDERS.some((one) => one.kinds.includes(kind))) return "none";
  const entry = registry.PROVIDERS.find((one) => one.id === setting.provider);
  if (!entry) return "none";
  const serving = servingOf(registry, entry, kind);
  if (serving.length === 0) return "none";
  const mounts = mountsFolder(kind, entry, serving, mode);
  if (kind === "sandbox" && !mounts) return "none";
  return shellPlaceOf(mounts, mode);
}

/** The server's default where an agent has no computer setting: in Mode 1 a sandbox on the first provider that binds a
 *  folder of this machine and answers here (Docker), else none; in Mode 2 none. */
async function defaultSetting(mode: 1 | 2, registry: KindRegistry, side: ClaimSide): Promise<ComputerSetting> {
  if (mode === 1) {
    for (const entry of registry.PROVIDERS) {
      if (entry.kinds.includes("sandbox") && entry.mounts.includes("bind") && (await side.answers(entry.id))) return { kind: "sandbox", provider: entry.id };
    }
  }
  return { kind: "none" };
}

/** The setting resolved for `mode` (none given: the server's default), or a refusal in words that name the setting. A
 *  workflow runs with no computer: its caller gives kind none. */
export async function resolveComputer(given: ComputerSetting | undefined, mode: 1 | 2, registry: KindRegistry, side: ClaimSide): Promise<ResolvedComputer | { readonly refused: string }> {
  const setting = given ?? (await defaultSetting(mode, registry, side));
  const kind = setting.kind as ComputerSettingKind;
  if (!Object.hasOwn(registry.SETTING_KINDS, kind)) {
    const [why] = registry.servingRefusals({ kind: "linux", groups: [] }, kind);
    return { refused: `This agent's computer: ${why}. Set it in ${SETTINGS}.` };
  }
  if (kind === "none") return { kind, provider: null, mounts: false, ports: [], start: async () => ({ computer: undefined, release: nothing }) };

  const offered = registry.PROVIDERS.filter((entry) => entry.kinds.includes(kind));
  const pick = `one of ${offered.map((entry) => entry.label).join(", ")} for this agent's computer in ${SETTINGS}.`;
  if (offered.length === 0) return { refused: `No provider gives a ${kind} computer on this server: pick another kind for this agent's computer in ${SETTINGS}.` };
  if (!setting.provider) return { refused: `A ${kind} computer needs a provider: pick ${pick}` };
  const entry = registry.PROVIDERS.find((one) => one.id === setting.provider);
  if (!entry) return { refused: `${JSON.stringify(setting.provider)} is no computer provider this server knows: pick ${pick}` };
  // The configurations of the provider that serve the kind; none, and the registry says why, by its closest one.
  const serving = servingOf(registry, entry, kind);
  if (serving.length === 0) {
    const why = entry.capabilities.map((one) => registry.servingRefusals(one, kind)).sort((a, b) => a.length - b.length)[0] ?? [];
    return { refused: `${entry.label} gives no ${kind} computer${why.length > 0 ? `: ${why.join("; ")}` : ""}. Pick ${pick}` };
  }

  // The run's folder: mounted where the kind has files and exec and the provider mounts the mode's folder.
  const mounts = mountsFolder(kind, entry, serving, mode);
  if (kind === "sandbox" && !mounts) {
    if (mode === 1) return { refused: `Mode 1 runs a sandbox only on Docker: a ${entry.label} sandbox can't reach the run's folder on this machine. Pick Docker for this agent's computer in ${SETTINGS}, or another kind of computer.` };
    if (entry.mounts.includes("bind")) return { refused: `Mode 2 keeps workspaces on Archil; a local Docker computer can't mount them. Pick a remote sandbox for this agent's computer in ${SETTINGS}, or no computer.` };
    return { refused: `A ${entry.label} sandbox can't mount the run's folder from Archil: pick another sandbox for this agent's computer in ${SETTINGS}.` };
  }

  // Its keys: every required one saved, before anything starts; only declared names go to the provider.
  const saved = await side.keysOf(entry.id);
  const has = (name: string) => typeof saved[name] === "string" && saved[name] !== "";
  const missing = entry.keys.filter((key) => key.required && !has(key.name)).map((key) => key.name);
  if (missing.length > 0) {
    return { refused: `${entry.label} needs its key${missing.length === 1 ? "" : "s"} ${missing.join(", ")} saved: add ${missing.length === 1 ? "it" : "them"} in ${SETTINGS}.` };
  }
  const keys = Object.fromEntries(entry.keys.filter((key) => has(key.name)).map((key) => [key.name, saved[key.name]!]));

  const ports: readonly Port[] = kind === "sandbox" ? FOLDER_PORTS
    : kind === "desktop" ? [...(mounts ? FOLDER_PORTS : []), "screen", "input"]
    : kind === "phone" ? ["phone"] : ["browser"];

  return {
    kind,
    provider: entry.id,
    mounts,
    ports,
    async start({ workspace, check, signal }) {
      const mount = mounts ? await workspace.mountSpec() : undefined;
      let launched: LaunchedComputer;
      try {
        launched = await side.launch(entry, { kind, keys, ...(mount ? { mount } : {}), ...(signal ? { signal } : {}) });
      } catch (error) {
        throw unavailable(`${entry.label} could not start a ${kind} computer: ${error instanceof Error ? error.message : String(error)}`);
      }
      const computer = runComputerOf(kind, launched, mounts ? check : undefined);
      if (typeof computer === "string") {
        await launched.release();
        throw unavailable(`${entry.label} could not start a ${kind} computer: ${computer}`);
      }
      return { computer, release: () => launched.release() };
    },
  };
}

/** The started computer as runTools takes it, or what it lacks, in words. */
function runComputerOf(kind: Exclude<ComputerSettingKind, "none">, launched: LaunchedComputer, check: MountCheck | undefined): RunComputer | string {
  const groups = launched.groups as readonly Group[];
  if (kind === "browser") return launched.connect ? { kind, connect: () => launched.connect!() } : "it gave no CDP connection";
  const { client } = launched;
  if (!client) return "it gave no computer protocol client";
  if (kind === "phone") return { kind, computer: { client }, groups };
  if (check && !launched.readBack) return "it gave no read-back of its mount";
  const readBack = launched.readBack ? () => launched.readBack!() : async (): Promise<Result<MountReadBack>> => ({ ok: false, error: { code: "unsupported", message: "nothing is mounted in this computer" } });
  const computer = { id: launched.id, client, readBack };
  if (kind === "sandbox") return check ? { kind, computer, check } : "a sandbox mounts the run's folder";
  return { kind, computer, groups, ...(check ? { check } : {}) };
}
