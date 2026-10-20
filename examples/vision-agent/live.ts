// The models of a live run, each named by its provider and public model id as pi-ai's catalog names it: the lead writes
// the code, the eyes watch a window with its sound (Google's take video; any other eyes take frames), Jev judges frames and
// draws the box (TYPESAFE_API_KEY, or the gateway's key), and Scribe v2 on fal writes what is said (FAL_KEY, needed only when a question
// needs speech). A run reaches the lead and the eyes with the user's own keys, or through a gateway (VIDEO_MODEL_BASE_URL
// and VIDEO_MODEL_API_KEY) that serves each model under its public id: OpenAI-compatible for OpenAI's and Google's, and
// Anthropic's own Messages API at its root (`/v1/messages`) for Anthropic's, which is what returns thinking. Such a gateway
// may also pass fal's queue through at its root (`/fal-queue`), which takes its key as a bearer token, and TypeSafe
// (`/typesafe`).
import { parseArgs } from 'node:util';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createModels, createProvider, type Models, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createJevRunner } from '@parcha/agentrun-jev';
import { modelsEyes } from '@parcha/pi-vision/durable';
import { falTranscriber } from '@parcha/pi-vision/transcribers';
import type { LiveParts } from '@parcha/agentrun-harness';
import spec from './demo.json' with { type: 'json' };

export type PublicModel = { provider: string; modelId: string };
export const publicName = (model: PublicModel) => `${model.provider}/${model.modelId}`;

/** Each provider's key, its lead and eyes when it is the only one a run has, and whether its eyes take video. */
export const PROVIDERS: Record<string, { make: () => Provider; key: string; lead: string; eyes: string; video: boolean }> = {
  openai: { make: openaiProvider as () => Provider, key: 'OPENAI_API_KEY', lead: 'gpt-6-luna', eyes: 'gpt-6-sol', video: false },
  google: { make: googleProvider as () => Provider, key: 'GEMINI_API_KEY', lead: 'gemini-3.8-flash', eyes: 'gemini-3.8-flash', video: true },
  anthropic: { make: anthropicProvider as () => Provider, key: 'ANTHROPIC_API_KEY', lead: 'claude-haiku-5-5', eyes: 'claude-haiku-5-5', video: false },
};
const byName = (name: string): PublicModel => { const [provider, ...id] = name.split('/'); return { provider: provider!, modelId: id.join('/') }; };
/** The lead and the eyes by default: one value each in demo.json (`models.lead.default`, `models.eyes.default`). */
export const LEAD: PublicModel = byName(spec.models.lead.default);
export const EYES: PublicModel = byName(spec.models.eyes.default);
/** Jev's price as TypeSafe lists it, per million input tokens. */
const JEV_PRICE = { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 };

/** No model key and no gateway: the one failure of `chooseModels` that is a missing key, told apart from a model named wrongly. */
class NoModelKey extends Error {}
const NO_MODEL_KEY = `a model key (${Object.values(PROVIDERS).map((each) => each.key).join(', ')}) or a gateway (VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY)`;

const parse = (name: string): PublicModel => {
  const [provider, ...id] = name.split('/');
  if (!provider || !id.length || !PROVIDERS[provider]) throw new Error(`a model is named provider/id with a provider of ${Object.keys(PROVIDERS).join(', ')}; ${name} is not`);
  return { provider, modelId: id.join('/') };
};

/** The lead and the eyes: those named, else the defaults when a gateway serves them or their keys are set, else the
 *  defaults of the providers whose keys are set (the eyes preferring Google's, which take video). */
export function chooseModels(env: NodeJS.ProcessEnv, named: { lead?: string; eyes?: string } = {}): { lead: PublicModel; eyes: PublicModel } {
  return { lead: chooseModel(env, 'lead', named.lead), eyes: chooseModel(env, 'eyes', named.eyes) };
}

/** One role's model: the one named, else the default when a gateway serves it or its key is set, else the default of
 *  the first provider whose key is set (the eyes preferring Google's, which take video). */
function chooseModel(env: NodeJS.ProcessEnv, role: 'lead' | 'eyes', name: string | undefined): PublicModel {
  const has = (provider: string) => Boolean(env.VIDEO_MODEL_BASE_URL || env[PROVIDERS[provider]!.key]);
  if (name) return parse(name);
  const fallback = role === 'lead' ? LEAD : EYES;
  if (has(fallback.provider)) return fallback;
  const provider = (role === 'lead' ? ['openai', 'anthropic', 'google'] : ['google', 'openai', 'anthropic']).find(has);
  if (!provider) throw new NoModelKey(`--live needs ${NO_MODEL_KEY}. SETUP-PROMPT.md says where to get one.`);
  return { provider, modelId: PROVIDERS[provider]![role] };
}

/** The catalog of a run's models: through the gateway when one is set (an Anthropic model over the Messages API at the
 *  gateway's root, where the client adds /v1/messages and the model's thinking comes back as thinking blocks, which chat
 *  completions through the gateway do not return; any other over the Responses API when it speaks it, else chat completions
 *  at the gateway's base URL), else each provider with its own key. */
function catalogOf(env: NodeJS.ProcessEnv, models: readonly PublicModel[]): Models {
  const catalog = createModels();
  for (const id of new Set(models.map((model) => model.provider))) {
    const original = PROVIDERS[id]!.make();
    if (!env.VIDEO_MODEL_BASE_URL) {
      if (!env[PROVIDERS[id]!.key]) throw new Error(`--live with ${id} models needs ${PROVIDERS[id]!.key}.`);
      catalog.setProvider(original as never);
      continue;
    }
    if (!env.VIDEO_MODEL_API_KEY) throw new Error('VIDEO_MODEL_BASE_URL needs VIDEO_MODEL_API_KEY (the gateway\'s credential).');
    const messages = id === 'anthropic';
    const baseUrl = messages ? gatewayRoot(env) : env.VIDEO_MODEL_BASE_URL;
    const apiKey = env.VIDEO_MODEL_API_KEY;
    const entries = models.filter((model) => model.provider === id).map((model) => {
      const entry = original.getModels().find((each) => each.id === model.modelId);
      if (!entry) throw new Error(`${id} has no model ${model.modelId} in this build of pi-ai`);
      if (messages) return { ...entry, api: 'anthropic-messages' as const, baseUrl };
      return { ...entry, api: entry.api === 'openai-responses' ? 'openai-responses' as const : 'openai-completions' as const, baseUrl };
    });
    catalog.setProvider(createProvider({
      id, name: original.name, baseUrl,
      auth: { apiKey: { name: 'the model gateway', resolve: async () => ({ auth: { apiKey }, source: 'the model gateway' }) } },
      models: entries as never,
      api: (messages ? { 'anthropic-messages': anthropicMessagesApi() } : { 'openai-responses': openAIResponsesApi(), 'openai-completions': openAICompletionsApi() }) as never,
    }) as never);
  }
  return catalog;
}

/** The gateway's root: its base URL without the trailing /v1, where it passes other services through by name. */
const gatewayRoot = (env: NodeJS.ProcessEnv) => env.VIDEO_MODEL_BASE_URL!.replace(/\/v1\/?$/, '');

/** Scribe v2 on fal: fal's own queue with FAL_KEY, else the gateway's pass-through with its key as a bearer token; none
 *  without either, and a question that needs no speech runs without it. */
export function transcriberOf(env: NodeJS.ProcessEnv) {
  if (env.FAL_KEY) return falTranscriber({ apiKey: () => env.FAL_KEY });
  if (env.VIDEO_MODEL_BASE_URL && env.VIDEO_MODEL_API_KEY) return falTranscriber({ apiKey: () => env.VIDEO_MODEL_API_KEY, queueUrl: `${gatewayRoot(env)}/fal-queue`, auth: 'bearer' });
  return undefined;
}

/** Jev's key: TYPESAFE_API_KEY when it is given, else the gateway's own when a gateway is set (it passes Jev through
 *  under its credential); none otherwise. */
export const jevKeyOf = (env: NodeJS.ProcessEnv): string | undefined => env.TYPESAFE_API_KEY || (env.VIDEO_MODEL_BASE_URL ? env.VIDEO_MODEL_API_KEY : undefined) || undefined;

/** Jev's runner options: through the gateway's TypeSafe pass-through (`/typesafe`) when a gateway is set, else
 *  TYPESAFE_BASE_URL when set, else TypeSafe's own address. */
export function jevOptionsOf(env: NodeJS.ProcessEnv) {
  const baseURL = env.VIDEO_MODEL_BASE_URL ? `${gatewayRoot(env)}/typesafe` : env.TYPESAFE_BASE_URL || undefined;
  return { apiKey: jevKeyOf(env), pricing: JEV_PRICE, ...(baseURL ? { baseURL } : {}) };
}

/** The lead and the eyes the flags name: `--model` alone names the lead, `--provider` with a bare id makes it provider/id. */
export function namedModels(models: { provider?: string; model?: string; eyesModel?: string }): { lead?: string; eyes?: string } {
  const lead = models.model && models.provider && !models.model.includes('/') ? `${models.provider}/${models.model}` : models.model;
  return { ...(lead ? { lead } : {}), ...(models.eyesModel ? { eyes: models.eyesModel } : {}) };
}

/** What a live run lacks, each key by name and what it is for; empty when it can start. A gateway (VIDEO_MODEL_BASE_URL)
 *  serves the lead, the eyes and Jev under VIDEO_MODEL_API_KEY, so it is the only key then, TYPESAFE_API_KEY being Jev's
 *  own when given; without one, Jev needs TYPESAFE_API_KEY and each provider the run uses needs its own key. A model named
 *  in a way that is not provider/id is not a missing key: it throws. */
export function missingKeys(env: NodeJS.ProcessEnv, named: { lead?: string; eyes?: string } = {}): string[] {
  const missing: string[] = [];
  if (env.VIDEO_MODEL_BASE_URL) {
    chooseModels(env, named);
    if (!env.VIDEO_MODEL_API_KEY) missing.push("VIDEO_MODEL_API_KEY (the gateway's credential: VIDEO_MODEL_BASE_URL is set, and the gateway serves the lead, the eyes and Jev)");
    return missing;
  }
  if (!jevKeyOf(env)) missing.push('TYPESAFE_API_KEY (typesafe.ai: Jev judges the frames and pages and draws the boxes)');
  const uses = new Map<string, string[]>();
  const unchosen: string[] = [];
  for (const role of ['lead', 'eyes'] as const) {
    try {
      const model = chooseModel(env, role, named[role]);
      uses.set(model.provider, [...(uses.get(model.provider) ?? []), `the ${role} ${publicName(model)}`]);
    } catch (error) {
      if (!(error instanceof NoModelKey)) throw error;
      unchosen.push(role);
    }
  }
  for (const [provider, roles] of uses) if (!env[PROVIDERS[provider]!.key]) missing.push(`${PROVIDERS[provider]!.key} (${roles.join(' and ')})`);
  if (unchosen.length === 2) missing.push(NO_MODEL_KEY);
  else if (unchosen.length) missing.push(`a key for the ${unchosen[0]} (${Object.values(PROVIDERS).map((each) => each.key).join(', ')}) or a gateway (VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY)`);
  return missing;
}

/** The error a live run that lacks keys stops with, naming each; none when it has what it needs. */
export const keysError = (env: NodeJS.ProcessEnv, named: { lead?: string; eyes?: string } = {}): Error | undefined => {
  const missing = missingKeys(env, named);
  return missing.length ? new Error(`--live is missing ${missing.join('; ')}. SETUP-PROMPT.md says where to get ${missing.length === 1 ? 'it' : 'them'}.`) : undefined;
};

/** The command line's refusal of a live run that lacks keys, said before anything starts, so a refused run leaves no
 *  recording and no directory: its message, or none when the run is not a live one or has what it needs. A child of the
 *  run (`--child`) is the supervisor's, and the supervisor has checked. */
export function preflight(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { values } = parseArgs({ args: [...argv], strict: false, options: { live: { type: 'boolean' }, child: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, 'eyes-model': { type: 'string' } } });
  if (values.live !== true || values.child === true) return undefined;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const named = namedModels({ ...(text(values.provider) ? { provider: text(values.provider)! } : {}), ...(text(values.model) ? { model: text(values.model)! } : {}), ...(text(values['eyes-model']) ? { eyesModel: text(values['eyes-model'])! } : {}) });
  try { return keysError(env, named)?.message; } catch (error) { return (error as Error).message; }
}

/** The reference entry's live parts: the lead and eyes the flags name or the keys allow, Jev as the host's judge (which
 *  `vision.judge` goes through, held to the demo's Jev caps), and the transcriber. */
export function liveParts(context: { env: NodeJS.ProcessEnv; models: { provider?: string; model?: string; eyesModel?: string } }): LiveParts {
  const { env, models } = context;
  const named = namedModels(models);
  const lacking = keysError(env, named);
  if (lacking) throw lacking;
  const chosen = chooseModels(env, named);
  const catalog = catalogOf(env, [chosen.lead, chosen.eyes]);
  const eyes = modelsEyes(catalog as never, chosen.eyes, { thinking: 'low', accepts: { video: PROVIDERS[chosen.eyes.provider]!.video } });
  if (!eyes) throw new Error(`${publicName(chosen.eyes)} takes no images, so it cannot be the eyes`);
  const transcriber = transcriberOf(env);
  const runJudge = createJevRunner(jevOptionsOf(env));
  return {
    host: { models: { catalog, lead: { provider: chosen.lead.provider, modelId: chosen.lead.modelId } }, decisions: { runJudge: runJudge as never } },
    models: { lead: publicName(chosen.lead), eyes: publicName(chosen.eyes), jev: 'typesafe/jev-1.14.0', ...(transcriber ? { transcriber: `fal/${transcriber.model}` } : {}) },
    vision: () => ({ eyes, ...(transcriber ? { transcriber } : {}) }),
  };
}
