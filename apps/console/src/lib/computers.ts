import type { Place } from "./place";
import type { Computer, ComputerKindView } from "./v2";

/** Capabilities' computers list (`computers.kinds`), or null on a server that lists none. */
export function computersOf(caps: unknown): ComputerKindView[] | null {
  const computers = (caps as { computers?: { kinds?: unknown } } | null | undefined)?.computers;
  return Array.isArray(computers?.kinds) ? (computers.kinds as ComputerKindView[]) : null;
}

/** Whether a kind can be picked here: offered, and (but none, which needs no provider) a provider of it is ready. */
export const pickable = (kind: ComputerKindView): boolean => kind.offered && (kind.kind === "none" || kind.providers.some((p) => p.ready));

/** Why a kind can't be picked, in the server's words: the kind's own, else its first provider's that isn't ready. */
export const whyNot = (kind: ComputerKindView): string | undefined => kind.why ?? kind.providers.find((p) => !p.ready)?.why;

/** The computer a pick of `kind` makes: none needs no provider; another keeps `current`'s provider when that one serves
 *  it ready, else takes its first ready provider. */
export function pickKind(kind: ComputerKindView, current: Computer | undefined): Computer {
  if (kind.kind === "none") return { kind: "none" };
  const kept = current?.kind === kind.kind && kind.providers.some((p) => p.ready && p.id === current.provider) ? current.provider : undefined;
  const provider = kept ?? kind.providers.find((p) => p.ready)?.id;
  return provider ? { kind: kind.kind, provider } : { kind: kind.kind };
}

/** The place a computer is, as the server keeps place as its view: a sandbox is that provider's box; any other computer
 *  leaves the run's folder on the runner. */
export const placeOfComputer = (computer: Computer): Place => (computer.kind === "sandbox" && computer.provider ? { mode: "sandbox", box: computer.provider } : { mode: "runner" });
