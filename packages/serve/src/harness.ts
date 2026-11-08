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
 *  null when it runs none there; harnessOffers sets it. `keys`, on one unavailable only for want of a model key: the keys
 *  any one of which, saved, lets it run here, so a key's row names it before it is saved (tool-keys.ts' rowUnlocks).
 *  The server's own: capabilities never serve it. */
/** `installs`: `on_first_use` on claude-agent or codex while its CLI is not installed in this server's data: its first run
 *  (or the first agent made on it) installs it (harness-install.ts). */
export type HarnessOffer = { id: HarnessId; available: boolean; steer: boolean; reason?: string; default_model?: string | null; keys?: readonly string[]; installs?: "on_first_use" };
/** A harness as capabilities list it: an offer with its `default_model` resolved (harnessOffers), never left out, and
 *  the memory a run of it reserves (`run_memory_mib`). */
export type HarnessCapability = HarnessOffer & { default_model: string | null; run_memory_mib: number };


const offered = new WeakMap<object, Promise<HarnessCapability[]>>();

/** What this server offers of each harness, checked once per environment: each one's entry in the harness table says
 *  why it does not run here (harness-table.ts: an adapter's package, pins and endpoint, on a model of its wire's vendor),
 *  and whether one of its runs fits in this host's memory at all (host.ts). Whether a revision's model fits its harness
 *  is that revision's (runnable.ts). */
export function harnessOffers(env: NodeJS.ProcessEnv): Promise<HarnessCapability[]> {
  let offers = offered.get(env);
  if (!offers) {
    offers = (async () => {
      const { hostMemory, neverFits } = await import("./host.js");
      const memory = hostMemory();
      const { harnessInstalled } = await import("./adapters.js");
      const { harnessOf } = await import("./harness-table.js");
      const probed = await Promise.all(HARNESSES.map(async (id): Promise<HarnessOffer> => {
        const entry = harnessOf(env, id)!;
        // The start's probe: these offers hold until a restart (server.ts), so the reason says so where installing fixes it.
        // Claude Code not installed yet says so (its install probes the offers again).
        const firstUse = entry.installs && !(await harnessInstalled(entry, env)) ? { installs: "on_first_use" as const } : {};
        const refused = await entry.refusal(env, undefined, { atStart: true });
        return refused === undefined ? { id, available: true, steer: entry.steer, ...firstUse } : { id, available: false, steer: entry.steer, ...refused, ...firstUse };
      }));
      // A harness that runs here but whose one run is more than this host's memory for runs never starts: said here, so
      // a save warns and a run is refused at once with why (runnable.ts), never a 429 to try again. One that lacks only a
      // key keeps its reason, but no key would run it: it has no `keys`.
      const base = probed.map((offer): HarnessOffer => {
        const tooBig = offer.available || offer.keys ? neverFits(offer.id, memory) : undefined;
        if (!tooBig) return offer;
        const { keys: _keys, ...rest } = offer;
        return offer.available ? { ...rest, available: false, reason: tooBig } : rest;
      });
      // Each harness's model when a definition names none, as a save and a run resolve it (runnable.ts): none for a
      // harness that does not run here, or that no model here would run on.
      const { harnessModel } = await import("./runnable.js");
      return Promise.all(base.map(async (offer): Promise<HarnessCapability> => {
        const resolved = offer.available ? await harnessModel(env, offer.id, undefined, true) : undefined;
        return { ...offer, default_model: resolved && "model" in resolved ? `${resolved.model.provider}/${resolved.model.modelId}` : null, run_memory_mib: harnessOf(env, offer.id)!.runMib };
      }));
    })();
    offered.set(env, offers);
  }
  return offers;
}

/** The harness a stored body names, as answers show it. */
export const harnessOfBody = (body: { harness?: string }): string => body.harness ?? DEFAULT_HARNESS;
