// Computer time, priced the way providers bill it: by the resources a computer holds, for as long as it holds them. A
// computer has no size here. Its CPUs, memory, GPUs and disk are the provider's own figures where its answer gives them
// (CreatedComputer.resources), else what its create asked, else unknown (computer-intervals.ts figuresOf), and the operator
// sets a price per provider and per resource, as browser time is priced (browser-cost.ts):
//
//   AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_<PROVIDER>              USD per vCPU-second
//   AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_<PROVIDER>               USD per GiB-second of memory
//   AGENTRUN_COMPUTE_USD_PER_GPU_SECOND_<PROVIDER>_<GPU_TYPE>    USD per GPU-second, by the provider's own GPU type name
//   AGENTRUN_COMPUTE_USD_PER_DISK_GB_MONTH_<PROVIDER>            USD per GB-month of disk (a month: 730 hours)
//
// <PROVIDER> and <GPU_TYPE> in capitals, every other character an underscore (daytona, H100 → DAYTONA_H100). No price is
// built in: a provider whose descriptor bills nothing (metered false) is $0, as is a resource set at 0 (booked at $0, its
// usage line $0, never `unpriced`), and any other resource with no price set, or
// with a figure its provider never said, is unpriced: its time is never $0 and never refused. An unpriced resource runs
// outside the cap, as a tool call with no price does (TOOL_UNMETERED): nothing of it is held or booked, and its usage line
// says `unpriced`.
//
// The cap (computeMeter): a priced computer's time is held on the run's one ledger, under the run's max_cost_usd, one
// stretch ahead, as browser time is. A claim's first computer is made while the run's spec is built, before its cap can
// judge: its first stretch is held once the cap can (owed: it is made), so the run's first request is judged beside it,
// and a cap with no room parks the run there. A computer made once the cap judges (a lost sandbox's new one) has one
// stretch at what its create asks for held first (a refusal makes nothing, in the cap's words). Each stretch it ran is
// then booked (owed: its provider is owed it, so the cap never refuses it) and the next stretch held, a refusal of which
// pauses the run as a browser call's does. Before the run's end or park is written (the spec's beforeRelease: settle),
// what it ran since is booked and its hold let go, so the end's cost holds it; the moments between that and its delete
// are no claim's. Time no claim holds (a computer kept
// past its claim for a follow-up, one deleted after its run ended, one whose delete failed) is booked by none: it is on the
// usage read (`unheld_quantity`) and in no cap.
import { PROVIDERS } from "@parcha/agentrun-computer";
import type { Refusal } from "@parcha/agentrun-kernel";
import { type PaidBooking, paidStep } from "./paid-calls.js";
import { logLine } from "./print.js";

/** Each computer step that is owed, by name: booked and held past the cap's rule (kernel/cap port.ts), for money its
 *  provider is owed once the computer is made. The one place this file sets owed (owed-pin.test.mjs pins the list and
 *  each name's one use). A computer not yet made is never held owed: the hold before its create is the cap's to refuse. */
const OWED = {
  /** The time it ran, booked each stretch and at its settle. */
  bookedTime: { owed: true },
  /** The first stretch of a computer already made. */
  madeFirstStretch: { owed: true },
} as const;

/** The resources computer time is priced by. */
export type ComputeResource = "vcpu" | "memory" | "gpu" | "disk";
/** The unit each resource's time is counted in. */
export const COMPUTE_UNITS = { vcpu: "vcpu_second", memory: "gib_second", gpu: "gpu_second", disk: "gb_month" } as const;
export type ComputeUnit = (typeof COMPUTE_UNITS)[ComputeResource];
/** A month of disk, as providers bill one: 730 hours. */
export const SECONDS_PER_MONTH = 730 * 3600;

/** The settings' prefixes, by resource (the provider's name, and a GPU's type, follow in capitals). */
export const COMPUTE_PRICE_ENV = {
  vcpu: "AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_",
  memory: "AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_",
  gpu: "AGENTRUN_COMPUTE_USD_PER_GPU_SECOND_",
  disk: "AGENTRUN_COMPUTE_USD_PER_DISK_GB_MONTH_",
} as const satisfies Record<ComputeResource, string>;

const named = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "_");
/** The setting that prices `resource` of `provider` (a GPU's by its type). */
export const computePriceEnvOf = (resource: ComputeResource, provider: string, gpuType?: string | null): string =>
  `${COMPUTE_PRICE_ENV[resource]}${named(provider)}${resource === "gpu" ? `_${named(gpuType ?? "")}` : ""}`;

/** What a computer held, as its interval keeps it (store computer_intervals): each null where nothing says it. */
export type ComputeFigures = { readonly cpus: number | null; readonly memoryMb: number | null; readonly gpuType: string | null; readonly gpuCount: number | null; readonly diskGb: number | null };

/** One resource of a computer: its line's key (a GPU's by its type), and how many of its unit each second of the
 *  computer's life is (null when its figure is unknown). */
export type ResourceOf = { readonly resource: ComputeResource; readonly gpuType: string | null; readonly perSecond: number | null };

/** The resources a computer held: its vCPUs and memory always (a figure no one said is null, never 0); its GPUs when it
 *  has any; its disk when its provider said it. */
export function resourcesOf(figures: ComputeFigures): ResourceOf[] {
  const gpu = figures.gpuType !== null || figures.gpuCount !== null;
  return [
    { resource: "vcpu", gpuType: null, perSecond: figures.cpus },
    { resource: "memory", gpuType: null, perSecond: figures.memoryMb === null ? null : figures.memoryMb / 1024 },
    ...(gpu ? [{ resource: "gpu" as const, gpuType: figures.gpuType, perSecond: figures.gpuType === null ? null : figures.gpuCount }] : []),
    ...(figures.diskGb !== null ? [{ resource: "disk" as const, gpuType: null, perSecond: figures.diskGb / SECONDS_PER_MONTH }] : []),
  ];
}

/** Whether `provider`'s descriptor says it bills nothing (Local's Docker): its time is $0, never by its id alone. */
export const unmetered = (provider: string): boolean => PROVIDERS.some((entry) => entry.id === provider && !entry.metered);

/** The operator's price of `resource` of `provider`, in USD per its unit: a non-negative decimal, $0 for a provider
 *  that bills nothing; null when none is set or the setting can't be read (unpriced, never $0). */
export function computeRate(provider: string, resource: ComputeResource, gpuType: string | null, env: NodeJS.ProcessEnv): number | null {
  if (unmetered(provider)) return 0;
  if (resource === "gpu" && gpuType === null) return null;
  const text = env[computePriceEnvOf(resource, provider, gpuType)]?.trim();
  if (!text || !/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;
  const rate = Number(text);
  return Number.isFinite(rate) ? rate : null;
}

/** One priced resource of a computer: what a second of its life costs (its rate times its figure), with its words. */
type Priced = ResourceOf & { readonly rate: number; readonly usdPerSecond: number };
/** A computer's priced resources: those with a known figure and a price. The rest are unpriced and held by nothing. */
export function pricedOf(provider: string, figures: ComputeFigures, env: NodeJS.ProcessEnv): Priced[] {
  return resourcesOf(figures).flatMap((one) => {
    const rate = computeRate(provider, one.resource, one.gpuType, env);
    return rate === null || one.perSecond === null ? [] : [{ ...one, rate, usdPerSecond: rate * one.perSecond }];
  });
}

/** How long a stretch is: what the claim holds ahead, and how often it books what ran. */
export const COMPUTE_STRETCH_S = 300;
/** The tool a computer's time names on the run's ledger (GET /runs/{run_id}/usage reads its bookings as compute lines). */
export const COMPUTE_TOOL = "compute";
/** The tag of a booking of one resource: its resource, and a GPU's type. */
export const computeTag = (one: Pick<ResourceOf, "resource" | "gpuType">): string => (one.resource === "gpu" ? `gpu:${one.gpuType ?? ""}` : one.resource);

/** Up to the millionth of a dollar, so the cap's words name a figure never below the hold. */
const microUsd = (usd: number) => Math.ceil(Math.round(usd * 1e12) / 1e6) / 1e6;

/** The run's ledger as the meter books on it, the run's pause for a refusal of the next stretch, and whether its cap can
 *  judge a step now (`judges`, RunLedger.judges: false while the run's spec, whose cap it is, is still built). */
export type ComputeLedger = { readonly paid?: PaidBooking; readonly pause?: (refusal: Refusal) => Promise<void>; readonly judges?: () => boolean };

/** A hold-only step on the ledger, given back by `drop` (answered once the ledger has it back). */
type Hold = { drop(): Promise<void> };

/** A computer the claim refused to create: the cap had no room for its first stretch. Its words are the cap's. */
export class ComputeRefused extends Error {
  readonly code = "spend_cap_reached";
}

export interface ComputeMeter {
  /** Before the claim creates a computer of `provider` asking for `figures`: one stretch of its priced resources held on
   *  the run's ledger (none where nothing is priced, or with no ledger). Refused for room or for good: ComputeRefused, in
   *  the cap's words, and nothing should be made. The hold answered is the caller's to hand to `start` (or `drop`). */
  before(provider: string, figures: ComputeFigures): Promise<Hold | undefined>;
  /** The claim holds computer `providerId` of `provider` from now, with `figures` (its provider's where it said them):
   *  its time is booked each stretch, the next one held; `ahead` (before's hold) is let go once the first is. */
  start(provider: string, providerId: string, figures: ComputeFigures, ahead?: Hold): void;
  /** The claim lets the computer go (its delete answered ok, or its run's park kept it): the time since its last
   *  booking booked, its hold let go. Once; one the meter never started is nothing. */
  stop(provider: string, providerId: string): Promise<void>;
  /** Every computer it holds let go as `stop` does (the claim's release). */
  stopAll(): Promise<void>;
}

export type ComputeMeterOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly ledger: ComputeLedger;
  /** Told each booked stretch of a computer's time, in ms (its interval's booked time, computer-intervals.ts). */
  readonly booked?: (provider: string, providerId: string, ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Runs `tick` every `ms` until the answer is called; default setInterval, unref'd. */
  readonly every?: (tick: () => void, ms: number) => () => void;
  readonly log?: (line: string) => void;
};

const everyDefault = (tick: () => void, ms: number) => {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

/** One claim's meter of the computers it holds (ComputeMeter). */
export function computeMeter(options: ComputeMeterOptions): ComputeMeter {
  const { env, ledger } = options;
  const now = options.now ?? Date.now;
  const every = options.every ?? everyDefault;
  const log = options.log ?? ((line: string) => void process.stderr.write(`agentrun-serve runner: ${line}\n`));
  let seq = 0;
  /** A hold of `usd` for `provider`'s next stretch: admitted (refused in the cap's words, with its refusal); `owed`, time
   *  its provider is already owed (a computer already made), never refused. */
  const holdOf = async (provider: string, usd: number, basis: string, given: { readonly owed?: true } = {}): Promise<{ hold: Hold } | { refused: string; refusal?: Refusal }> => {
    const paid = ledger.paid;
    // Nothing to hold: no ledger, or a stretch of resources whose operator set them at $0.
    if (!paid || usd === 0) return { hold: { drop: async () => {} } };
    const id = `compute:${provider}#hold-${(seq += 1)}`;
    try {
      await paid.admit({ id, name: `${provider}'s computer time`, holdUsd: usd, basis, chargedBy: provider, tool: COMPUTE_TOOL, hold: true, ...(given.owed ? { owed: true as const } : {}) });
    } catch (error) {
      const capped = (error as { code?: unknown })?.code === "spend_cap_reached";
      const given = error as { forGood?: boolean; figures?: Refusal["figures"] };
      const refused = capped ? String((error as Error).message) : `${provider}'s computer time could not be held: ${String((error as Error)?.message ?? error)}`;
      return { refused, ...(capped ? { refusal: { refuse: refused, code: "spend_cap_reached", forGood: given.forGood ?? true, ...(given.figures ? { figures: given.figures } : {}) } } : {}) };
    }
    let dropped: Promise<void> | undefined;
    return { hold: { drop: () => (dropped ??= paid.settle(id, 0, { givenBack: true }).then(() => undefined, () => undefined)) } };
  };
  /** Whether the run's cap can judge a step now: false while the run's spec, whose cap it is, is built. */
  const judging = () => ledger.judges?.() !== false;
  const stretchUsd = (priced: readonly Priced[]) => microUsd(priced.reduce((sum, one) => sum + one.usdPerSecond, 0) * COMPUTE_STRETCH_S);
  const basisOf = (provider: string, priced: readonly Priced[]) =>
    `${provider}'s computer time for its next ${COMPUTE_STRETCH_S} s: ${priced.map((one) => `${one.perSecond} ${COMPUTE_UNITS[one.resource].replace("_second", "")}${one.gpuType ? ` ${one.gpuType}` : ""} at $${one.rate} a ${COMPUTE_UNITS[one.resource].replace(/^[a-z]+_/, "")}`).join(", ")}`;

  /** A computer the claim holds: its priced resources, where its next booking starts (`from`), its hold for the next
   *  stretch, its timer, the tick under way (`ticking`), whether a refusal paused the run, and its stop once asked. */
  type Held = { provider: string; providerId: string; priced: Priced[]; from: number; hold: Hold | undefined; cancel: () => void; ticking: Promise<void>; paused: boolean; stopped?: Promise<void> };
  const held = new Map<string, Held>();
  const key = (provider: string, providerId: string) => `${provider}\u0000${providerId}`;

  /** The time `one` ran since its last booking, up to `to`, booked on the ledger: one owed step per priced resource, each
   *  named by its computer, resource and time (ref), so it is booked once; then its interval's booked time. */
  const book = async (one: Held, to: number): Promise<void> => {
    // A cap that can't judge yet would keep this booking waiting on the run's spec, which may be what is let go now (a
    // computer deleted because its spec's build failed): nothing is booked, and its time is the run's unheld time.
    if (!judging()) return;
    const from = one.from;
    const ms = Math.max(0, Math.floor(to - from));
    one.from = from + ms;
    if (ms === 0 || one.priced.length === 0) return;
    const paid = ledger.paid;
    if (paid) {
      await Promise.all(one.priced.map(async (resource) => {
        const usd = resource.usdPerSecond * (ms / 1000);
        const tag = computeTag(resource);
        const stepped = await paidStep(paid, undefined, { name: `${one.provider}'s computer time (${tag})`, holdUsd: usd, basis: `${ms / 1000} s of ${resource.perSecond} ${COMPUTE_UNITS[resource.resource]} at $${resource.rate}`, by: one.provider, tool: COMPUTE_TOOL, tag, ...OWED.bookedTime, ref: `compute:${one.provider}:${one.providerId}:${tag}@${from}-${from + ms}` }, async () => undefined, () => usd).catch((error: unknown) => ({ refused: String((error as Error)?.message ?? error) }));
        if ("refused" in stepped) log(logLine("compute_spend_unbooked", { said: `${ms / 1000} s of ${one.provider} ${one.providerId}'s ${tag} time was not booked on the run's ledger (${stepped.refused.slice(0, 200)})` }));
      }));
    }
    await options.booked?.(one.provider, one.providerId, ms).catch(() => undefined);
  };

  /** Each stretch: what ran booked, the next stretch held (a refusal pauses the run, once until a hold is taken again). */
  const tick = async (one: Held): Promise<void> => {
    // A stretch that passes while the run's spec is still built (a long image build) waits for the next: what ran is
    // booked from where it was then.
    if (!judging()) return;
    await book(one, now());
    // The stretch just booked is no longer ahead: its hold is given back, and the ledger has it back, before the next
    // stretch is asked for. Else the cap would count that stretch twice (booked and still held), and refuse a next one
    // it has room for.
    const last = one.hold;
    one.hold = undefined;
    await last?.drop();
    const next = await holdOf(one.provider, stretchUsd(one.priced), basisOf(one.provider, one.priced));
    if ("hold" in next) {
      if (one.stopped) await next.hold.drop();
      else one.hold = next.hold;
      // Held again (the run's cap was raised, or room came back): a later refusal pauses the run again.
      one.paused = false;
      return;
    }
    if (!one.paused && next.refusal && ledger.pause) {
      one.paused = true;
      await ledger.pause(next.refusal).catch(() => undefined);
    }
  };

  const stop = (provider: string, providerId: string): Promise<void> => {
    const one = held.get(key(provider, providerId));
    if (!one) return Promise.resolve();
    return (one.stopped ??= (async () => {
      one.cancel();
      await one.ticking;
      await book(one, now());
      const last = one.hold;
      one.hold = undefined;
      await last?.drop();
      held.delete(key(provider, providerId));
    })());
  };

  return {
    async before(provider, figures) {
      const priced = pricedOf(provider, figures, env);
      const usd = stretchUsd(priced);
      // A cap that can't judge yet (the claim's first computer, made while the run's spec is built) holds nothing ahead:
      // the computer's first stretch is held, owed, once it can (start), before the run's first request is judged.
      if (!ledger.paid || usd === 0 || ledger.judges?.() === false) return undefined;
      const held = await holdOf(provider, usd, basisOf(provider, priced));
      if ("refused" in held) throw new ComputeRefused(held.refused);
      return held.hold;
    },
    start(provider, providerId, figures, ahead) {
      const priced = pricedOf(provider, figures, env);
      const k = key(provider, providerId);
      // A computer with nothing priced is held and booked by nothing (its time unpriced), as is a provider that bills
      // nothing. One whose resources the operator priced at $0 is booked at $0 each stretch, so its usage read says $0
      // (never `unpriced`): nothing of it is held.
      if (held.has(k) || priced.length === 0 || unmetered(provider)) {
        void ahead?.drop();
        return;
      }
      const one: Held = { provider, providerId, priced, from: now(), hold: undefined, cancel: () => {}, ticking: Promise.resolve(), paused: false };
      held.set(k, one);
      // Its first stretch held at what it was made with (owed: it is made, so never refused), then the hold taken before
      // its create let go. The stretch's ticks wait for it, so a tick never drops a hold this has not set yet. Made
      // while the run's spec is built, the hold waits for the spec's cap: then nothing waits on it (a stop while the spec
      // fails would wait forever), and the hold, once the cap can judge, is let go at once if the computer was stopped.
      const first = holdOf(provider, stretchUsd(priced), basisOf(provider, priced), OWED.madeFirstStretch).then((answer) => {
        if ("hold" in answer) {
          if (one.stopped) void answer.hold.drop();
          else one.hold = answer.hold;
        }
        void ahead?.drop();
      });
      if (judging()) one.ticking = first;
      else void first.catch(() => undefined);
      const cancel = every(() => {
        one.ticking = one.ticking.then(() => (one.stopped ? undefined : tick(one))).catch(() => undefined);
      }, COMPUTE_STRETCH_S * 1000);
      one.cancel = () => {
        cancel();
        one.cancel = () => {};
      };
    },
    stop,
    async stopAll() {
      await Promise.all([...held.values()].map((one) => stop(one.provider, one.providerId)));
    },
  };
}
