// The harness that runs a revision: pi (pi-durable-disk's, the default and the one a revision that names none gets) or
// one of the run adapters. A revision keeps the harness it names; the default is never stored, so a revision written
// before this field existed and one that names pi are the same revision. Which harnesses this server runs is said in
// capabilities, and a revision naming one it does not run saves with a warning and is refused at run time.

export const HARNESSES = ["pi", "claude-agent", "codex", "opencode"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export const DEFAULT_HARNESS: HarnessId = "pi";

/** The memory one run of each harness reserves while its process lives, in MiB: what admission counts (host.ts).
 *  Measured 2026-11-03 on 529c3882e with the pinned binaries' sha256 checked a chunk at a time, not read whole: a
 *  real server in a cgroup of its own (MemoryMax 2048M, no swap), models on a loopback stand-in, one agent with read
 *  and write asked to write a file, read it back and answer; the cgroup's anon (memory.stat) sampled every 100 ms. A
 *  run's size is (the most anon with the runs going − the server's own after boot) / n, for n = 1 and n = 3, twice
 *  each, and the largest of the four is kept. The server's own growth while it serves the runs is in it.
 *    pi:           n=1 106, 106; n=3 96, 99 MB a run → 128 (+21%)
 *    codex:        n=1 132, 143; n=3 120, 131 MB a run → 192 (+34%)
 *    claude-agent: n=1 215, 208; n=3 211, 208 MB a run → 288 (+34%)
 *    opencode:     n=1 524, 501; n=3 509, 514 MB a run → 704 (+34%), measured the same way 2026-11-04 on the pinned
 *                  OpenCode 1.19.5 (its own process, a Bun binary, is most of it; at a 1024M limit two runs were
 *                  OOM-killed, and at 512M one short run completed)
 *  The margin covers a longer conversation than the probe's three steps; the CLI harnesses (codex, claude-agent) grow
 *  more with one, so theirs is larger. At a 512M limit the same build completed pi x3, codex x2 and claude-agent x1
 *  (and x2). A check that reads a binary whole adds its size to the server and to each run (294 MB for codex, 230 MB
 *  for the claude-agent CLI), and these sizes do not cover it. The faux model and the faux
 *  harness reserve the size of the harness they stand in for, so tests admit as a real server does. */
export const RUN_MIB: Readonly<Record<HarnessId, number>> = { pi: 128, "claude-agent": 288, codex: 192, opencode: 704 };

/** One harness as capabilities lists it: whether this server runs it, and when not, why; and whether it takes a message
 *  mid-turn (`steer`), or queues it for the turn's end. */
/** `default_model`: the model this server runs for the harness when a definition names none (`provider/model-id`), or
 *  null when it runs none there; harnessOffers sets it. */
export type HarnessOffer = { id: HarnessId; available: boolean; steer: boolean; reason?: string; default_model?: string | null };
/** A harness as capabilities list it: an offer with its `default_model` resolved (harnessOffers), never left out, and
 *  the memory a run of it reserves (`run_memory_mib`). */
export type HarnessCapability = HarnessOffer & { default_model: string | null; run_memory_mib: number };

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
 *  on a model of the harness's own provider (adapters.ts), and whether one of its runs fits in this host's memory at all
 *  (host.ts). Whether a revision's model fits its harness is that revision's (runnable.ts). */
export function harnessOffers(env: NodeJS.ProcessEnv): Promise<HarnessCapability[]> {
  let offers = offered.get(env);
  if (!offers) {
    offers = (async () => {
      const { hostMemory, neverFits } = await import("./host.js");
      const memory = hostMemory();
      const probed = env[FAUX_HARNESS_ENV] ? harnessesOf(env) : await (async () => {
        const { harnessReason } = await import("./adapters.js");
        return Promise.all(HARNESSES.map(async (id): Promise<HarnessOffer> => {
          if (id === DEFAULT_HARNESS) return { id, available: true, steer: true };
          // The start's probe: these offers hold until a restart (server.ts), so the reason says so where installing fixes it.
          const reason = await harnessReason(id, env, undefined, { atStart: true });
          return reason === undefined ? { id, available: true, steer: steersMidTurn(id) } : { id, available: false, steer: steersMidTurn(id), reason };
        }));
      })();
      // A harness that runs here but whose one run is more than this host's memory for runs never starts: said here, so
      // a save warns and a run is refused at once with why (runnable.ts), never a 429 to try again.
      const base = probed.map((offer): HarnessOffer => {
        const tooBig = offer.available ? neverFits(offer.id, memory) : undefined;
        return tooBig ? { ...offer, available: false, reason: tooBig } : offer;
      });
      // Each harness's model when a definition names none, as a save and a run resolve it (runnable.ts): none for a
      // harness that does not run here, or that no model here would run on.
      const { harnessModel } = await import("./runnable.js");
      return Promise.all(base.map(async (offer): Promise<HarnessCapability> => {
        const resolved = offer.available ? await harnessModel(env, offer.id, undefined, true) : undefined;
        return { ...offer, default_model: resolved && "model" in resolved ? `${resolved.model.provider}/${resolved.model.modelId}` : null, run_memory_mib: RUN_MIB[offer.id] };
      }));
    })();
    offered.set(env, offers);
  }
  return offers;
}

/** The harness a stored body names, as answers show it. */
export const harnessOfBody = (body: { harness?: string }): string => body.harness ?? DEFAULT_HARNESS;
