// A paired computer (a person's own, attached over the attach binding: computer-attach.ts) as the claim and Settings see
// it: one provider of the kind registry, whose id is the computer's own (cmp-...), whose label is its name, and whose one
// configuration is the kind and groups it paired as. An agent's computer setting names it as its provider, {kind:
// "desktop", provider: "cmp-..."}, so a run resolves, checks and claims it on the one path every computer takes
// (resolve-computer.ts, computer-for-claim.ts), and the computer package's attachedProvider stands in for a vendor's.
// A Linux box with no display (computerd's hello says linux, with files and exec) is a sandbox: in Mode 2 it holds the
// run's folder as a synced folder in its own /workspace, as a hosted computer that dials does.
//
// Its socket is held by the AttachHub of the server's process while no run holds it: a runner in that process (the CLI's
// start, its runner beside the server) takes it there, its route taken all the same (dial-relay.ts pairedRelayOn over
// the server's hub, runner/beside.ts), so a runner apart takes it for no other run meanwhile. A runner of its own
// process with a relay (dial-relay.ts) has the server move the box's socket onto its own hub for the run (PairedRelay,
// workspace/paired-route.ts); one with no relay cannot reach it and refuses it in ONE_PROCESS_WORDS.
import { type AttachHub, attachedProvider, type ComputerProvider, fail, type HelloResult, type PairedComputer, RUN_LABEL, runLifetimeMs, SETTING_KIND_NAMES, SETTING_KINDS } from "@parcha/agentrun-computer";
import type { Claim, PairedComputerRow } from "../store/index.js";
import type { ComputerSettingKind, KindCapabilities, KindRegistry, ProviderEntry } from "./resolve-computer.js";

/** A paired computer's id starts with this; the rest is lowercase letters and digits, so the whole is an id an agent's
 *  computer setting takes as its provider (lowercase letters, digits and dashes). */
export const PAIRED_ID_PREFIX = "cmp-";

/** The image a paired computer's spec names: none is made, so this only says what it is. */
export const ATTACHED_IMAGE = "attached";

/** How to start a server so its runs can use a paired computer, in one line: the same words wherever it is said. */
export const ONE_PROCESS_FIX = "start the image with the server options alone, without server-and-runner (outside the image: agentrun-serve without --no-runner)";

/** The fix for a runner in a process of its own that relays no computer's socket: it relays once it has the server's
 *  public address (dial-relay.ts). */
export const RELAY_FIX = "give the runner AGENTRUN_PUBLIC_URL (this server's public address)";

/** The words a run gets when its agent's computer is a paired computer and its runner, in a process of its own, keeps
 *  no relay. */
export const ONE_PROCESS_WORDS = `a paired computer's socket is held by the server process it dialed, and this runner runs in a process of its own and relays no computer's socket: ${RELAY_FIX}, or ${ONE_PROCESS_FIX}`;

/** What a pairing code, the pair answer and each paired computer say on a server whose runner runs in a process of its
 *  own (--no-runner; the image's server-and-runner) while no runner relays: the computer pairs, and no run here can use
 *  it. */
export const RUNNER_APART_WORDS = `no run on this server can use a paired computer: its runner runs in a process of its own and relays no computer's socket: ${RELAY_FIX}, or ${ONE_PROCESS_FIX}`;

/** What a provider whose machines dial this server (the computer package's connectOf "dial": Fly Machines, Cloudflare,
 *  and E2B, Daytona or Modal set to dial) says on such a server: its row in GET /v2/computers and its test. Its
 *  machines' sockets are taken by the server's attach hub, and a runner of its own process takes them only through its
 *  relay (dial-relay.ts), which it keeps once it has the server's public address; with none, its create refuses (the
 *  computer package's hosted/provider.ts, naming the same fixes, the relay's first). */
export const dialApartWords = (label: string): string => `no run on this server can use ${label}: its machines dial this server, and its runner runs in a process of its own and relays no machine's socket: ${RELAY_FIX}, or ${ONE_PROCESS_FIX}`;

/** A runner's relay of the paired computers (dial-relay.ts pairedRelayOn): its hub, where the server moves a box's
 *  socket for a run of this runner (a runner apart's own; the server's, for the runner beside it). `bring` routes the
 *  box here for `run` (its hold's end `until`, ms; under `claim`, the run's claim, so a superseded claim's take throws
 *  Fenced) and resolves once the box is on the hub; it rejects with code computer_unavailable in words (another run
 *  holds it, it is not attached, it did not come in time, its claim was cancelled: `signal`, the create's, which drops
 *  the route it took at once), never hanging past PAIRED_BRING_MS. `letGo` ends `hold` (once every remove or KILL it
 *  sent has answered), then drops the route where no hold is left. */
export interface PairedRelay {
  readonly hub: AttachHub;
  bring(row: Pick<PairedComputerRow, "id" | "name">, hold: { readonly run: string; readonly until: number; readonly claim?: Claim; readonly signal?: AbortSignal }): Promise<void>;
  letGo(computer: string, hold?: string, run?: string): Promise<void>;
}

/** What the claim reads of the paired computers: the store's rows (removed ones left out), and the server's hub where
 *  the runner shares its process, or the runner's relay where it runs in a process of its own and relays (neither: a
 *  runner of its own process with no relay). */
export interface AttachedComputers {
  rows(): Promise<readonly PairedComputerRow[]>;
  readonly hub?: AttachHub;
  readonly relay?: PairedRelay;
}

/** The store's row as the hub and attachedProvider take it. */
export const pairedOf = (row: PairedComputerRow): PairedComputer => ({
  id: row.id,
  name: row.name,
  hello: row.hello as unknown as HelloResult,
  labels: { ...row.labels },
});

/** The setting kinds the attach path cannot serve, with why and what to pair instead: a browser session needs a CDP
 *  connection, which the attach socket does not carry. Kind-based, never by OS: a driver whose hello serves one of
 *  these and no other kind is refused at pairing, and a paired row of one serves nothing. */
const ATTACH_CANNOT: Readonly<Partial<Record<ComputerSettingKind, string>>> = {
  browser: "a paired computer can't serve browser sessions yet, so pair a desktop or phone driver",
};

/** Which paired computer is a sandbox: a Linux box's computerd, its hello kind linux (no display), with files and exec. */
const PAIRED_SANDBOX = "only a Linux box paired with computerd and no display can be a sandbox computer";

/** What a driver's hello lacks to serve `kind`, by the kind registry's rule (the computer package's SETTING_KINDS, which
 *  servingRefusals reads): "it says desktop but declares no input.pointer, input.keys", "it says android, which no
 *  desktop computer is"; undefined when the hello serves the kind. The one source of a paired computer's words for a
 *  kind it cannot serve: at pairing (servesNoKind) and at a run's start (pairedEntry's unserved). */
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
  const kinds = SETTING_KIND_NAMES.filter((kind) => kind !== "none" && !(kind in ATTACH_CANNOT));
  if (kinds.some((kind) => helloLacks(hello, kind) === undefined)) return undefined;
  // A hello that is whole for a kind the attach path cannot carry says so, in that kind's words.
  const carried = Object.entries(ATTACH_CANNOT).find(([kind]) => helloLacks(hello, kind as ComputerSettingKind) === undefined);
  if (carried !== undefined) return `${name}'s driver is a ${carried[0]}: ${carried[1]}`;
  // The kind its machine kind is (a desktop's, a phone's) says what is missing; a machine kind no kind takes says that.
  const near = kinds.find((kind) => SETTING_KINDS[kind].machineKinds.some((one) => one === hello.kind));
  const lack = near === undefined ? `it says ${String(hello.kind ?? "nothing")}, which no kind of computer is` : helloLacks(hello, near);
  return `${name}'s driver serves no kind: ${lack}: update the driver on ${name}`;
}

/** Why the paired computer `row`, which serves `kinds`, gives no computer of `kind`: it is a computer of the person's
 *  own, and either the attach path carries no such kind (ATTACH_CANNOT: a browser), or it is a desktop or a phone asked
 *  to be a sandbox (PAIRED_SANDBOX), so the agent takes it as the kind it serves, or its driver lacks what the kind needs
 *  (helloLacks), so the driver is what to update. Undefined where none of these says why. */
function pairedUnserved(row: PairedComputerRow, kinds: readonly ComputerSettingKind[], kind: ComputerSettingKind): string | undefined {
  const as = `give this agent ${row.name} as a ${kinds.join(" or ")} computer`;
  if (kind in ATTACH_CANNOT && kinds.length > 0) return `it is a computer of your own, and a paired computer can't be a ${kind} computer yet; ${as}`;
  if (kind === "sandbox" && kinds.length > 0) return `it is a computer of your own, and ${PAIRED_SANDBOX}; ${as}`;
  const lack = helloLacks(row.hello as Partial<HelloResult>, kind);
  return lack === undefined ? undefined : `it is a computer of your own, and ${lack}; update the driver on ${row.name}`;
}

/** A paired computer as a provider of `registry`: named by its name and its os, as an agent's computer picker lists it;
 *  the setting kinds its paired hello serves, why it serves each other one (unserved, pairedUnserved's words), no keys,
 *  the machine's own network ("open": a run never narrows a person's own machine), never metered. A sandbox (a Linux box
 *  with files and exec) takes the run's folder as a synced folder (the computer package's attachedProvider checks its
 *  /workspace); a desktop or a phone takes no mount. */
export function pairedEntry(row: PairedComputerRow, registry: Pick<KindRegistry, "SETTING_KINDS" | "servingRefusals">): ProviderEntry {
  const hello = row.hello as Partial<HelloResult>;
  const configuration = { kind: String(hello.kind ?? ""), groups: Array.isArray(hello.groups) ? [...hello.groups] : [] } as unknown as KindCapabilities;
  const named = (Object.keys(registry.SETTING_KINDS) as ComputerSettingKind[]).filter((kind) => kind !== "none");
  const kinds = named.filter((kind) => !(kind in ATTACH_CANNOT) && registry.servingRefusals(configuration, kind).length === 0);
  const unserved = Object.fromEntries(named.filter((kind) => !kinds.includes(kind)).flatMap((kind) => {
    const why = pairedUnserved(row, kinds, kind);
    return why === undefined ? [] : [[kind, why]];
  }));
  return {
    id: row.id,
    label: typeof hello.os === "string" ? `${row.name} (${hello.os})` : row.name,
    kinds,
    keys: [],
    mounts: kinds.includes("sandbox") ? ["sync"] : [],
    network: ["open"],
    metered: false,
    capabilities: [configuration],
    unserved,
    defaultImage: Object.fromEntries(kinds.map((kind) => [kind, ATTACHED_IMAGE])),
  };
}

/** `registry` with each paired computer of `rows` as one more provider (pairedEntry). */
export function withPaired<R extends KindRegistry>(registry: R, rows: readonly PairedComputerRow[]): R {
  if (rows.length === 0) return registry;
  return { ...registry, PROVIDERS: [...registry.PROVIDERS, ...rows.map((row) => pairedEntry(row, registry))] };
}

/** The provider of the paired computer `row`: over a relay's hub where the runner has one (`relay`: a runner apart's
 *  own, or the server's for the runner beside it), the box brought there before each create and let go after each
 *  release (relayedProvider); else attachedProvider over the server's hub (`hub`) with no route; else a refusal in
 *  ONE_PROCESS_WORDS. `claim`: the run's claim (ClaimLaunch.claim), which the bring's route takes under. */
export function pairedProvider(row: PairedComputerRow, hub: AttachHub | undefined, relay?: PairedRelay, claim?: Claim): ComputerProvider {
  if (relay !== undefined) return relayedProvider(row, relay, claim);
  if (hub !== undefined) return attachedProvider(pairedOf(row), hub);
  throw Object.assign(new Error(ONE_PROCESS_WORDS), { code: "computer_unavailable" });
}

/** attachedProvider over a relay's hub: create brings the box to this runner for the run (its labels' run, its
 *  lifetime's end) and is refused in the bring's words, never hanging; a create that fails after the bring lets the box
 *  go; release ends the hold, then lets the box go (a run's loop releases in its finally, so a cancelled run or a throw
 *  in its pass lets the box go as it unwinds). Every other call is attachedProvider's own. */
function relayedProvider(row: PairedComputerRow, relay: PairedRelay, claim: Claim | undefined): ComputerProvider {
  const inner = attachedProvider(pairedOf(row), relay.hub);
  /** The run of each hold this provider made, by its ref's id (`<computer id>.<hold>`). */
  const runs = new Map<string, string>();
  return {
    id: inner.id,
    get version() {
      return inner.version;
    },
    capabilities: () => inner.capabilities(),
    check: (spec) => inner.check(spec),
    async create(spec, context) {
      const run = spec.labels?.[RUN_LABEL];
      if (run === undefined) return inner.create(spec, context);
      try {
        // The claim's cancel (the create's signal) ends the bring's wait at once, the route it took dropped.
        await relay.bring(row, { run, until: Date.now() + runLifetimeMs(spec), ...(claim ? { claim } : {}), ...(context.signal ? { signal: context.signal } : {}) });
      } catch (error) {
        // A superseded claim (Fenced), and any failure that is not the bring's in words, is the claim's to answer.
        if ((error as { code?: unknown }).code !== "computer_unavailable") throw error;
        return fail(context.signal?.aborted ? "aborted" : "refused", (error as Error).message);
      }
      const made = await inner.create(spec, context);
      if (!made.ok) {
        await relay.letGo(row.id, undefined, run).catch(() => undefined);
        return made;
      }
      runs.set(made.value.id, run);
      return made;
    },
    attach: (asked, context) => inner.attach(asked, context),
    list: (labels, context) => inner.list(labels, context),
    network: (asked, policy, context) => inner.network(asked, policy, context),
    connect: (asked) => inner.connect(asked),
    async release(asked, how, context) {
      const done = await inner.release(asked, how, context);
      if (done.ok && asked.id !== row.id) {
        const run = runs.get(asked.id);
        runs.delete(asked.id);
        await relay.letGo(row.id, undefined, run);
      }
      return done;
    },
  };
}

/** Why the paired computer `row` cannot be had now, in words that say what to do, or undefined: it must be attached (its
 *  driver dialed this server). Asked at a run's start, as a vendor's readiness is; another run's hold is the claim's. */
export function pairedRefusal(row: PairedComputerRow, hub: Pick<AttachHub, "online"> | undefined): string | undefined {
  if (hub === undefined) return ONE_PROCESS_WORDS;
  if (!hub.online(row.id)) return `This agent's computer is ${row.name}, which is not attached now: open its driver on that computer, which dials this server, then start the run again.`;
  return undefined;
}
