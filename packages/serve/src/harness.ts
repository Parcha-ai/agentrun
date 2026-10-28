// The harness that runs a revision: pi (pi-durable-disk's, the default and the one a revision that names none gets) or
// one of the run adapters. A revision keeps the harness it names; the default is never stored, so a revision written
// before this field existed and one that names pi are the same revision. Which harnesses this server runs is said in
// capabilities, and a revision naming one it does not run saves with a warning and is refused at run time.

export const HARNESSES = ["pi", "claude-agent", "codex"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export const DEFAULT_HARNESS: HarnessId = "pi";

/** One harness as capabilities lists it: whether this server runs it, and when not, why. */
export type HarnessOffer = { id: HarnessId; available: boolean; reason?: string };

/** What this server offers of each harness. */
export function harnessesOf(_env: NodeJS.ProcessEnv): HarnessOffer[] {
  return HARNESSES.map((id) => (id === DEFAULT_HARNESS ? { id, available: true } : { id, available: false, reason: `This server does not run ${id} yet.` }));
}

/** The harness a stored body names, as answers show it. */
export const harnessOfBody = (body: { harness?: string }): string => body.harness ?? DEFAULT_HARNESS;
