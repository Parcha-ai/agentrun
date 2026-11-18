// The harness that runs a revision: pi (the default and the one a revision that names none gets) or
// one of the run adapters. A revision keeps the harness it names; the default is never stored, so a revision written
// before this field existed and one that names pi are the same revision. Which harnesses this server runs is said in
// capabilities, and a revision naming one it does not run saves with a warning and is refused at run time.
import type { HarnessPromises } from "./harness-table.js";


/** The built-in harnesses' ids, in the table's order (harness-table.ts BUILTIN; harness-one-table.test.mjs holds them
 *  equal): the ids a definition may name on any server, and the type of a built-in one. What a server runs is its table's
 *  (harnessIds), which an owner's harness module may add to. */
export const HARNESSES = ["pi", "claude-agent", "codex", "opencode"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export const DEFAULT_HARNESS: HarnessId = "pi";
/** What a harness id is, as the API says it (openapi.ts): a harness module's id that is not one refuses the start. */
export const HARNESS_ID_PATTERN = "^[a-z][a-z0-9-]{0,39}$";
/** The names serve's own runs carry where a harness id goes, so a harness module may not take one (its start is refused):
 *  `learning`, a learning run's launch harness, which the runner's loop choice keys on (harness-loops.ts,
 *  learning-factory.ts LEARNING_HARNESS) and the stores' learning queries match; `sdk`, an SDK run's launch harness
 *  (sdk/runs.ts); and the names analytics files a run's harness under: `workflow`, a workflow revision's, and each SDK
 *  runtime's (sdk/schema.ts SDK_BINDING). Also every name a plain object already has that the id pattern admits
 *  (`constructor`): serve looks harnesses up by id in plain objects, where such an id would read Object's own member. */
export const RESERVED_HARNESS_IDS: readonly string[] = Object.freeze([
  "learning", "sdk", "workflow", "claude-agent-sdk", "codex-sdk",
  ...Object.getOwnPropertyNames(Object.prototype).filter((name) => new RegExp(HARNESS_ID_PATTERN).test(name)),
]);
/** The harnesses that run on a person's ChatGPT plan (chatgpt-plan.ts): those whose requests go to OpenAI's Responses
 *  API as the plan takes them. The others need a model key. */
export const PLAN_HARNESSES: readonly string[] = Object.freeze(["pi", "codex"] satisfies HarnessId[]);

/** One harness as capabilities lists it: whether this server runs it, and when not, why; and whether it takes a message
 *  mid-turn (`steer`), or queues it for the turn's end. */
/** `default_model`: the model this server runs for the harness when a definition names none (`provider/model-id`), or
 *  null when it runs none there; harnessOffers sets it. `keys`: the model keys any one of which runs it here, on one
 *  unavailable only for want of a model key (any one, saved, lets it run) and on an available one alike (which of the
 *  keys it runs on), so a key's row names it before and after any key is saved (tool-keys.ts' rowUnlocks). The
 *  server's own: capabilities never serve it. */
/** `installs`: `on_first_use` on claude-agent or codex while its CLI is not installed in this server's data: its first run
 *  (or the first agent made on it) installs it (harness-install.ts). */
/** `id`: one of the table's (harness-table.ts harnessIds): a built-in one (HARNESSES) or one an owner's harness module adds.
 *  `label`: its name in a sentence. `promises`: what it promises (HarnessPromises), as capabilities show it. */
export type HarnessOffer = { id: string; label: string; promises: HarnessPromises; available: boolean; steer: boolean; reason?: string; default_model?: string | null; keys?: readonly string[]; installs?: "on_first_use" };
/** A harness as capabilities list it: an offer with its `default_model` resolved (harnessOffers), never left out, and
 *  the memory a run of it reserves (`run_memory_mib`). */
export type HarnessCapability = HarnessOffer & { default_model: string | null; models: string[]; free_models: { id: string; context_window: number }[]; run_memory_mib: number; needs?: HarnessNeed[] };
/** What would give a harness that runs nothing here a model, any one of them: a model key (`key`), or the ChatGPT sign-in
 *  (`chatgpt`: codex and pi, on a server that signs in, not signed in or signed in no longer, AGENT_MODEL naming no key's
 *  model the harness runs: planWouldRun). */
export type HarnessNeed = "key" | "chatgpt";


const offered = new WeakMap<object, Promise<HarnessCapability[]>>();

/** `env` with every model key taken out (each provider's, model.ts PROVIDER_KEYS, and the gateway's), its other
 *  properties kept as they are: what a harness would ask for with no model key. */
async function withoutModelKeys(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  // model.ts imports this module: read late, as the other modules here are.
  const { GATEWAY_KEY_ENV, PROVIDER_KEYS } = await import("./model.js");
  const descriptors = Object.getOwnPropertyDescriptors(env);
  for (const name of [...Object.values(PROVIDER_KEYS).flat(), GATEWAY_KEY_ENV]) delete descriptors[name];
  return Object.defineProperties({}, descriptors) as NodeJS.ProcessEnv;
}

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
      const { harnessIds, harnessOf, NATIVE_PROMISES } = await import("./harness-table.js");
      const probed = await Promise.all(harnessIds(env).map(async (id): Promise<HarnessOffer> => {
        const entry = harnessOf(env, id)!;
        const named = { label: entry.label, promises: entry.promises ?? NATIVE_PROMISES };
        // The start's probe: these offers hold until a restart (server.ts), so the reason says so where installing fixes it.
        // Claude Code not installed yet says so (its install probes the offers again).
        const firstUse = entry.installs && !(await harnessInstalled(entry, env)) ? { installs: "on_first_use" as const } : {};
        const refused = await entry.refusal(env, undefined, { atStart: true });
        if (refused !== undefined) return { id, ...named, available: false, steer: entry.steer, ...refused, ...firstUse };
        // Available: which model keys run it here is what it would ask for with none of them (a key's row names it only
        // when that key is one), so a row reads the same before and after another provider's key is saved.
        const keyless = await entry.refusal(await withoutModelKeys(env), undefined, { atStart: true });
        return { id, ...named, available: true, steer: entry.steer, ...(keyless?.keys?.length ? { keys: keyless.keys } : {}), ...firstUse };
      }));
      // A harness that runs here but whose one run is more than this host's memory for runs never starts: said here, so
      // a save warns and a run is refused at once with why (runnable.ts), never a 429 to try again. One that lacks only a
      // key keeps its reason, but no key would run it: it has no `keys`.
      const base = probed.map((offer): HarnessOffer => {
        const tooBig = offer.available || offer.keys ? neverFits(offer.id, memory, env) : undefined;
        if (!tooBig) return offer;
        const { keys: _keys, ...rest } = offer;
        return offer.available ? { ...rest, available: false, reason: tooBig } : rest;
      });
      // Each harness's model when a definition names none, as a save and a run resolve it (runnable.ts): none for a
      // harness that does not run here, or that no model here would run on.
      const { harnessModel } = await import("./runnable.js");
      const { pickerCandidates, freeCandidates } = await import("./model-form.js");
      const { planWouldRun, withPlanWords } = await import("./model.js");
      return Promise.all(base.map(async (offer): Promise<HarnessCapability> => {
        const resolved = offer.available ? await harnessModel(env, offer.id, undefined, true) : undefined;
        // The models a person may pick for it (model-form.ts), each in the form it takes: those its entry's own choice
        // takes (the catalog it runs on knows the id, a key may still be missing: a save warns of that, never refuses),
        // so the picker never offers one a save would refuse. None for a harness that does not run here.
        const entry = harnessOf(env, offer.id)!;
        const models: string[] = [];
        // Its free models (model-form.ts freeCandidates) are offered after the others, by the same checks.
        const free = offer.available ? await freeCandidates(env, offer.id) : [];
        if (offer.available) {
          // Each choice passes what a save and a run ask, by construction: the save's own shape check (MODEL_REF), the
          // harness's own choice of it, and, on an adapter's wire, providerFor, the function a run starts with. A model
          // the wire cannot take (a vendor it does not run, an endpoint a key may not go to) is not offered; one that
          // lacks only a key is (a save warns of that, never refuses).
          const { MODEL_REF } = await import("./validate.js");
          const { providerFor, HarnessUnavailable } = await import("./provider.js");
          const { adapterFactsOf } = await import("./adapter-facts.js");
          const { FAUX_ENV } = await import("./model.js");
          const facts = adapterFactsOf(offer.id);
          for (const id of new Set([...pickerCandidates(env, offer.id), ...free.map((m) => m.id)])) {
            if (!MODEL_REF.test(id)) continue;
            const chosen = await entry.model(env, id, true);
            if (!chosen || !("model" in chosen || chosen.needs === "key")) continue;
            if (facts && "model" in chosen && !env[FAUX_ENV]) {
              try {
                providerFor(facts.wire, env, chosen.model, offer.id);
              } catch (error) {
                if (!(error instanceof HarnessUnavailable && error.keys?.length)) continue;
              }
            }
            models.push(id);
          }
        }
        // One that runs nothing here for want of a key (unavailable with `keys`, or available with no default model for
        // want of one: pi's) says what would give it a model: a key, and for codex and pi the ChatGPT sign-in where this
        // server signs in (planWouldRun), in its reason and in `needs`.
        const wantsKey = offer.available ? resolved !== undefined && "why" in resolved && resolved.needs === "key" : Boolean(offer.keys?.length);
        const sayWhy = !wantsKey ? {} : offer.available ? { reason: (resolved as { why: string }).why } : offer.reason ? { reason: withPlanWords(env, offer.id, offer.reason) } : {};
        const needs: HarnessNeed[] = wantsKey ? ["key", ...(planWouldRun(env, offer.id) ? (["chatgpt"] as const) : [])] : [];
        return { ...offer, ...sayWhy, default_model: resolved && "model" in resolved ? `${resolved.model.provider}/${resolved.model.modelId}` : null, models, free_models: free.filter((m) => models.includes(m.id)), run_memory_mib: entry.runMib, ...(needs.length ? { needs } : {}) };
      }));
    })();
    offered.set(env, offers);
  }
  return offers;
}

/** The harness a stored body names, as answers show it. */
export const harnessOfBody = (body: { harness?: string }): string => body.harness ?? DEFAULT_HARNESS;
