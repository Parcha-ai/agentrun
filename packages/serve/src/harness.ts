// The harness that runs a revision: pi (pi-durable-disk's, the default and the one a revision that names none gets) or
// one of the run adapters. A revision keeps the harness it names; the default is never stored, so a revision written
// before this field existed and one that names pi are the same revision. Which harnesses this server runs is said in
// capabilities, and a revision naming one it does not run saves with a warning and is refused at run time.

export const HARNESSES = ["pi", "claude-agent", "codex", "opencode"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export const DEFAULT_HARNESS: HarnessId = "pi";

/** One harness as capabilities lists it: whether this server runs it, and when not, why; and whether it takes a message
 *  mid-turn (`steer`), or queues it for the turn's end. */
/** `default_model`: the model this server runs for the harness when a definition names none (`provider/model-id`), or
 *  null when it runs none there; harnessOffers sets it. */
export type HarnessOffer = { id: HarnessId; available: boolean; steer: boolean; reason?: string; default_model?: string | null };
/** A harness as capabilities list it: an offer with its `default_model` resolved (harnessOffers), never left out. */
export type HarnessCapability = HarnessOffer & { default_model: string | null };

/** Whether a harness takes a message mid-turn: pi does; another harness's run queues it for the turn's end. */
export const steersMidTurn = (id: string): boolean => id === DEFAULT_HARNESS;

/** A module whose `script(spec)` scripts run-adapters' faux harness: with it, every harness but pi runs on that faux
 *  harness, as `--faux` runs pi on the faux model. */
export const FAUX_HARNESS_ENV = "AGENTRUN_SERVE_FAUX_HARNESS";

/** What this server offers of each harness. */
export function harnessesOf(env: NodeJS.ProcessEnv): HarnessOffer[] {
  return HARNESSES.map((id) => (id === DEFAULT_HARNESS || env[FAUX_HARNESS_ENV] ? { id, available: true, steer: steersMidTurn(id) } : { id, available: false, steer: steersMidTurn(id), reason: `This server does not run ${id} yet.` }));
}

const offered = new WeakMap<object, Promise<HarnessCapability[]>>();

/** What this server offers of each harness, checked once per environment: each adapter's package, pins and endpoint,
 *  on a model of the harness's own provider (adapters.ts). Whether a revision's model fits its harness is that
 *  revision's (runnable.ts). */
export function harnessOffers(env: NodeJS.ProcessEnv): Promise<HarnessCapability[]> {
  let offers = offered.get(env);
  if (!offers) {
    offers = (async () => {
      const base = env[FAUX_HARNESS_ENV] ? harnessesOf(env) : await (async () => {
        const { harnessReason } = await import("./adapters.js");
        return Promise.all(HARNESSES.map(async (id): Promise<HarnessOffer> => {
          if (id === DEFAULT_HARNESS) return { id, available: true, steer: true };
          // The start's probe: these offers hold until a restart (server.ts), so the reason says so where installing fixes it.
          const reason = await harnessReason(id, env, undefined, { atStart: true });
          return reason === undefined ? { id, available: true, steer: steersMidTurn(id) } : { id, available: false, steer: steersMidTurn(id), reason };
        }));
      })();
      // Each harness's model when a definition names none, as a save and a run resolve it (runnable.ts): none for a
      // harness that does not run here, or that no model here would run on.
      const { harnessModel } = await import("./runnable.js");
      return Promise.all(base.map(async (offer): Promise<HarnessCapability> => {
        const resolved = offer.available ? await harnessModel(env, offer.id, undefined, true) : undefined;
        return { ...offer, default_model: resolved && "model" in resolved ? `${resolved.model.provider}/${resolved.model.modelId}` : null };
      }));
    })();
    offered.set(env, offers);
  }
  return offers;
}

/** The harness a stored body names, as answers show it. */
export const harnessOfBody = (body: { harness?: string }): string => body.harness ?? DEFAULT_HARNESS;
