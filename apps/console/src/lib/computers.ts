import { Globe, Monitor, Smartphone, Terminal } from "lucide-react";
import { type Place, type Places, runnerShellTools } from "./place";
import type { Computer, ComputerHold, ComputerKindView, ComputerProvider, RunMachine } from "./v2";

/** Each kind's name and what it gives a run, in the console's words. A kind the console doesn't know yet reads as its id. */
const KIND_WORDS = {
  none: { label: "None", gives: "The run's folder only." },
  sandbox: { label: "Sandbox", gives: "A Linux container." },
  desktop: { label: "Desktop", gives: "A screen, with a pointer and keys." },
  phone: { label: "Phone", gives: "A phone's screen and its apps." },
  browser: { label: "Browser", gives: "A browser the agent drives." },
} satisfies Record<RunMachine["kind"] | "none", { label: string; gives: string }>;
export const wordsOf = (kind: string): { label: string; gives: string } => (KIND_WORDS as Record<string, { label: string; gives: string }>)[kind] ?? { label: kind, gives: "" };
/** A provider of a kind, as GET /v2/computers lists it. */
export const providerOf = (kinds: readonly ComputerKindView[], kind: string, id: string): ComputerProvider | undefined =>
  kinds.find((k) => k.kind === kind)?.providers.find((p) => p.id === id);
export const KIND_ICONS = { browser: Globe, desktop: Monitor, phone: Smartphone, sandbox: Terminal } as const satisfies Record<RunMachine["kind"], unknown>;
export const DRIVES: Record<ComputerHold, string> = { agent: "The agent drives", pending: "Yours after the agent's step", person: "You drive" };

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
const CARRIED = ["image", "persistent", "gpu", "surface", "exec", "record", "needs"] as const;
export type CarriedField = (typeof CARRIED)[number];
export type Dropped = Partial<Pick<Computer, CarriedField>>;
export type Carried = { computer: Computer; dropped: Dropped };
type ProviderView = ComputerKindView["providers"][number];

/** Whether `value` says something: an absent or default (false record or persistent, true exec) setting carries nothing. */
const isSet = (field: CarriedField, value: unknown): boolean => value !== undefined && value !== (field === "exec");

const SUBJECT: Record<CarriedField, string> = {
  image: "The image", persistent: "Keeping the computer between runs", gpu: "The GPU", surface: "The way the agent drives it", exec: "The no-shell setting", record: "Recording",
  needs: "The programs the box must have",
};

/** Why `field`, set to `value`, can't be taken by `kind` with `provider` picked, in words; undefined when it can. Read
 *  from the served list (GET /v2/computers): the kind's `record` and `settings`, and the provider's `images`,
 *  `persistent` and `gpu`. A persistent computer is kept wherever the provider lists `persistent`: which of its images
 *  keep one, against the default image, isn't read here. */
export function refusal(field: CarriedField, value: unknown, kind: ComputerKindView | undefined, provider: ProviderView | undefined): string | undefined {
  const off = (why: string) => `${SUBJECT[field]} is off: ${why}.`;
  if (!kind) return off("this server doesn't list that kind");
  if (field === "record") return kind.record.available ? undefined : off(kind.record.why);
  if (kind.kind === "none") return off("with no computer, there is nothing to hold it");
  if (!kind.settings.includes(field)) return off(`a ${kind.kind} doesn't take it`);
  // A sandbox's needs are the sandbox's on any provider: its run checks them in the box it starts.
  if (field === "surface" || field === "exec" || field === "needs") return undefined;
  if (!provider) return off("this kind has no ready provider");
  if (field === "gpu") {
    const gpu = value as { type: string; count: number };
    if (!provider.gpu) return off(`${provider.name} has no GPUs`);
    // Serve's sentence for why a run on this server can't have the provider's GPUs (gpu-words.ts), ending in its own stop.
    if (provider.gpu.why) return `${SUBJECT[field]} is off: ${provider.gpu.why}`;
    if (!provider.gpu.types.includes(gpu.type)) return off(`${provider.name} has no ${gpu.type}`);
    return gpu.count <= provider.gpu.max ? undefined : off(`${provider.name} gives at most ${provider.gpu.max} per computer`);
  }
  if (field === "image") return provider.images?.includes(value as string) ? undefined : off(`${provider.name} does not offer "${value}" for a ${kind.kind}`);
  return provider.persistent ? undefined : off(`${provider.name}'s ${kind.kind} keeps no computer between runs`);
}

/** `next` with each setting `from` has that `next`'s kind and provider can take; the ones they can't are `dropped`. */
export function carry(next: Computer, from: Computer | undefined, kind: ComputerKindView | undefined): Carried {
  const provider = kind?.providers.find((p) => p.id === next.provider);
  const kept: Record<string, unknown> = {};
  const dropped: Record<string, unknown> = {};
  for (const field of CARRIED) {
    const value = from?.[field];
    if (!isSet(field, value)) continue;
    (refusal(field, value, kind, provider) ? dropped : kept)[field] = value;
  }
  return { computer: { ...next, ...kept }, dropped };
}

/** `computer` recorded (`record: true`) when `on`, else without `record` (absent is off). The Recording switch turns on
 *  only where the kind's served `record` is available, and says its `why` where it isn't. */
export function recorded(computer: Computer, on: boolean): Computer {
  const { record: _record, ...rest } = computer;
  return on ? { ...rest, record: true } : rest;
}

/** The place a computer is, as the server keeps place as its view: a sandbox is that provider's box; any other computer
 *  leaves the run's folder on the runner. */
export const placeOfComputer = (computer: Computer): Place => (computer.kind === "sandbox" && computer.provider ? { mode: "sandbox", box: computer.provider } : { mode: "runner" });

/** What an edit sets to put an agent on `computer`: the computer, the place it is, and, on the runner, the agent's `tools`
 *  without those that run only in a box (`sandbox_only` in the server's `offered` tools: bash and its background tools),
 *  save those the runner's own shell runs (bash in Mode 2: runnerShellTools of the server's `places`).
 *  The agent's Computer step and the Playground's move to the runner both make this edit. With no tools offered (the
 *  capabilities not read yet, or their read failed) which tools run only in a box is unknown, so an edit to the runner
 *  of an agent with tools is null: the caller changes nothing and says why. */
export function computerFields(computer: Computer, tools: readonly string[], offered: readonly { name: string; sandbox_only?: true }[], places: Places | null | undefined): { computer: Computer; place: Place; tools?: string[] } | null {
  const place = placeOfComputer(computer);
  if (place.mode === "runner" && tools.length && !offered.length) return null;
  const shell = runnerShellTools(places);
  const sandboxOnly = new Set(offered.filter((tool) => tool.sandbox_only && !shell.has(tool.name)).map((tool) => tool.name));
  return { computer, place, ...(place.mode === "runner" ? { tools: tools.filter((tool) => !sandboxOnly.has(tool)) } : {}) };
}

/** Said on a metered provider of a kind that bills by the minute: its minutes are the vendor's, outside the run's cap. */
export const METERED = "This provider bills by the minute through your own vendor account, and those minutes aren't counted in a run's spending cap.";
/** The kinds whose metered providers bill by the minute: never the browser. */
export const BY_THE_MINUTE: ReadonlySet<string> = new Set(["sandbox", "desktop", "phone"]);
