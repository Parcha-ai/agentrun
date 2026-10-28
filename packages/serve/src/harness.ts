// The harness that runs a revision: pi (pi-durable-disk's, the default and the one a revision that names none gets) or
// one of the run adapters. A revision keeps the harness it names; the default is never stored, so a revision written
// before this field existed and one that names pi are the same revision. Which harnesses this server runs is said in
// capabilities, and a revision naming one it does not run saves with a warning and is refused at run time.

export const HARNESSES = ["pi", "claude-agent", "codex"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export const DEFAULT_HARNESS: HarnessId = "pi";

/** One harness as capabilities lists it: whether this server runs it, and when not, why. */
export type HarnessOffer = { id: HarnessId; available: boolean; reason?: string };

/** A module whose `script(spec)` scripts run-adapters' faux harness: with it, every harness but pi runs on that faux
 *  harness, as `--faux` runs pi on the faux model. */
export const FAUX_HARNESS_ENV = "AGENTRUN_SERVE_FAUX_HARNESS";

/** What this server offers of each harness. */
export function harnessesOf(env: NodeJS.ProcessEnv): HarnessOffer[] {
  return HARNESSES.map((id) => (id === DEFAULT_HARNESS || env[FAUX_HARNESS_ENV] ? { id, available: true } : { id, available: false, reason: `This server does not run ${id} yet.` }));
}

const offered = new WeakMap<object, Promise<HarnessOffer[]>>();

/** What this server offers of each harness, checked once per environment: each adapter's package, pins and endpoint,
 *  on a model of the harness's own provider (adapters.ts). Whether a revision's model fits its harness is that
 *  revision's (runnable.ts). */
export function harnessOffers(env: NodeJS.ProcessEnv): Promise<HarnessOffer[]> {
  let offers = offered.get(env);
  if (!offers) {
    offers = (async () => {
      if (env[FAUX_HARNESS_ENV]) return harnessesOf(env);
      const { harnessReason } = await import("./adapters.js");
      return Promise.all(HARNESSES.map(async (id): Promise<HarnessOffer> => {
        if (id === DEFAULT_HARNESS) return { id, available: true };
        const reason = await harnessReason(id, env, undefined);
        return reason === undefined ? { id, available: true } : { id, available: false, reason };
      }));
    })();
    offered.set(env, offers);
  }
  return offers;
}

/** The harness a stored body names, as answers show it. */
export const harnessOfBody = (body: { harness?: string }): string => body.harness ?? DEFAULT_HARNESS;
