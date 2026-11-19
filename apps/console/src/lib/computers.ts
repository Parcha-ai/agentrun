import type { Place } from "./place";
import type { Computer, ComputerKindView } from "./v2";

/** Whether a kind can be picked here: offered, and (but none, which needs no provider) a provider of it is ready. */
export const pickable = (kind: ComputerKindView): boolean => kind.offered && (kind.kind === "none" || kind.providers.some((p) => p.ready));

/** Why a kind can't be picked, in the server's words: the kind's own, else its first provider's that isn't ready. */
export const whyNot = (kind: ComputerKindView): string | undefined => kind.why ?? kind.providers.find((p) => !p.ready)?.why;

/** The computer a pick of `kind` makes: none needs no provider; another keeps `current`'s provider when that one serves
 *  it ready, else takes its first ready provider. What else `current` set stays where the pick can take it (`carry`). */
export function pickKind(kind: ComputerKindView, current: Computer | undefined): Carried {
  if (kind.kind === "none") return carry({ kind: "none" }, current, kind);
  const kept = current?.kind === kind.kind && kind.providers.some((p) => p.ready && p.id === current.provider) ? current.provider : undefined;
  const provider = kept ?? kind.providers.find((p) => p.ready)?.id;
  return carry(provider ? { kind: kind.kind, provider } : { kind: kind.kind }, current, kind);
}

/** The settings a switch of kind or provider carries over, beside the kind and the provider. */
const CARRIED = ["image", "persistent", "gpu", "surface", "exec", "record"] as const;
export type CarriedField = (typeof CARRIED)[number];
export type Dropped = Partial<Pick<Computer, CarriedField>>;
export type Carried = { computer: Computer; dropped: Dropped };
type ProviderView = ComputerKindView["providers"][number];

/** The kinds that take `surface` and `exec`, as serve's computer-setting.ts has them. */
const DRIVEN: ReadonlySet<string> = new Set(["desktop", "phone"]);

/** Whether `value` says something: an absent or default (false record or persistent, true exec) setting carries nothing. */
const isSet = (field: CarriedField, value: unknown): boolean => value !== undefined && value !== (field === "exec");

const SUBJECT: Record<CarriedField, string> = {
  image: "The image", persistent: "Keeping the computer between runs", gpu: "The GPU", surface: "The way the agent drives it", exec: "The no-shell setting", record: "Recording",
};

/** Why `field`, set to `value`, can't be taken by `kind` with `provider` picked, in words; undefined when it can. Read
 *  from the served list (GET /v2/computers): the provider's `images`, `persistent` and `gpu`. Which kinds take a surface,
 *  exec or record is the server's computer-setting.ts (`DRIVEN`, `RECORDS`). A persistent computer is kept wherever the
 *  provider lists `persistent`: which of its images keep one, against the default image, isn't read here. */
export function refusal(field: CarriedField, value: unknown, kind: string, provider: ProviderView | undefined): string | undefined {
  const off = (why: string) => `${SUBJECT[field]} is off: ${why}.`;
  const nothing = kind === "none" ? "with no computer, there is nothing" : `a ${kind} has nothing`;
  if (field === "record") return RECORDS.has(kind) ? undefined : off(kind === "none" ? "with no computer, there is no screen to record" : `a ${kind} has no screen to record`);
  if (field === "surface" || field === "exec") return DRIVEN.has(kind) ? undefined : off(`only a desktop or a phone takes it, and ${nothing} to drive`);
  if (kind === "none") return off(`${nothing} to hold it`);
  if (!provider) return off("this kind has no ready provider");
  if (field === "gpu") {
    const gpu = value as { type: string; count: number };
    if (kind !== "sandbox") return off("only a sandbox takes GPUs");
    if (!provider.gpu) return off(`${provider.name} has no GPUs`);
    // Serve's sentence for why a run on this server can't have the provider's GPUs (gpu-words.ts), ending in its own stop.
    if (provider.gpu.why) return `${SUBJECT[field]} is off: ${provider.gpu.why}`;
    if (!provider.gpu.types.includes(gpu.type)) return off(`${provider.name} has no ${gpu.type}`);
    return gpu.count <= provider.gpu.max ? undefined : off(`${provider.name} gives at most ${provider.gpu.max} per computer`);
  }
  if (field === "image") return provider.images?.includes(value as string) ? undefined : off(`${provider.name} does not offer "${value}" for a ${kind}`);
  return provider.persistent ? undefined : off(`${provider.name}'s ${kind} keeps no computer between runs`);
}

/** `next` with each setting `from` has that `next`'s kind and provider can take; the ones they can't are `dropped`. */
export function carry(next: Computer, from: Computer | undefined, kind: ComputerKindView | undefined): Carried {
  const provider = kind?.providers.find((p) => p.id === next.provider);
  const kept: Record<string, unknown> = {};
  const dropped: Record<string, unknown> = {};
  for (const field of CARRIED) {
    const value = from?.[field];
    if (!isSet(field, value)) continue;
    (refusal(field, value, next.kind, provider) ? dropped : kept)[field] = value;
  }
  return { computer: { ...next, ...kept }, dropped };
}

/** `computer` recorded (`record: true`) when `on` and its kind records, else without `record` (absent is off). */
export function recorded(computer: Computer, on: boolean): Computer {
  const { record: _record, ...rest } = computer;
  return on && RECORDS.has(computer.kind) ? { ...rest, record: true } : rest;
}

/** The kinds a run's video records (`computer.record`), as serve's computer-setting.ts `record.kinds` has them. */
export const RECORDS: ReadonlySet<string> = new Set(["desktop", "phone", "browser"]);

/** The place a computer is, as the server keeps place as its view: a sandbox is that provider's box; any other computer
 *  leaves the run's folder on the runner. */
export const placeOfComputer = (computer: Computer): Place => (computer.kind === "sandbox" && computer.provider ? { mode: "sandbox", box: computer.provider } : { mode: "runner" });

/** Said on a metered provider of a kind that bills by the minute: its minutes are the vendor's, outside the run's cap. */
export const METERED = "This provider bills by the minute through your own vendor account, and those minutes aren't counted in a run's spending cap.";
/** The kinds whose metered providers bill by the minute: never the browser. */
export const BY_THE_MINUTE: ReadonlySet<string> = new Set(["sandbox", "desktop", "phone"]);
