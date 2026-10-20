// What `--live` swaps for the scripted lead: the review and report agents run on Google's gemini-3.8-flash, at the thinking each node asks for (medium in job.ts), with the key in GEMINI_API_KEY. The model is
// called from the process that runs the job, which on the disk's live runner is in a Daytona sandbox: there the variable holds the placeholder of a Daytona secret, and Daytona's egress proxy puts the key into the
// request's header for generativelanguage.googleapis.com only, so the box never holds the key (live.ts). The spend is bounded inside each process, whatever the model does: at most MAX_CALLS model calls and
// MAX_OUTPUT_TOKENS tokens per answer (its thinking included); past the calls, a call ends at once with an error and nothing is sent. The entry's `--max-usd` is the cap over the whole run.
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { createModels, createProvider, type Provider } from '@earendil-works/pi-ai/models';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import type { LiveParts } from '@parcha/agentrun-harness';

export const LEAD = { provider: 'google', modelId: 'gemini-3.8-flash' } as const;
/** Model calls one process may make: the job needs about five per invoice and a few for the report. */
export const MAX_CALLS = 60;
/** Tokens one answer may hold, its thinking included. */
export const MAX_OUTPUT_TOKENS = 8192;

type Api = ReturnType<typeof googleGenerativeAIApi>;

/** The Google API with each call counted: one past `max` is sent with its signal already aborted, so it ends at once with an error and reaches no server. Every call's answer is held to `maxOutputTokens`. */
export function boundedApi(inner: Api, max = MAX_CALLS, maxOutputTokens = MAX_OUTPUT_TOKENS): Api & { calls(): number } {
  let calls = 0;
  const bound = <O extends { maxTokens?: number; signal?: AbortSignal }>(options: O | undefined): O => {
    calls += 1;
    const capped = { ...options, maxTokens: Math.min(options?.maxTokens ?? maxOutputTokens, maxOutputTokens) } as O;
    return calls > max ? { ...capped, signal: AbortSignal.abort(new Error(`the live part's cap of ${max} model calls in one process was reached`)) } : capped;
  };
  return {
    ...inner,
    stream: (model, context, options) => inner.stream(model, context, bound(options)),
    streamSimple: (model, context, options) => inner.streamSimple(model, context, bound(options)),
    calls: () => calls,
  };
}

export function live({ env }: { env: NodeJS.ProcessEnv }): LiveParts {
  if (!env.GEMINI_API_KEY) throw new Error('--live needs GEMINI_API_KEY (aistudio.google.com, Get API key), or in a Daytona sandbox the placeholder of a Daytona secret that holds it. SETUP-PROMPT.md says how.');
  const google = googleProvider() as Provider;
  const entry = google.getModels().find((model) => model.id === LEAD.modelId);
  if (!entry) throw new Error(`google has no model ${LEAD.modelId} in this build of pi-ai`);
  const catalog = createModels();
  catalog.setProvider(createProvider({
    id: google.id, name: google.name, baseUrl: google.baseUrl, auth: google.auth,
    models: [{ ...entry, maxTokens: MAX_OUTPUT_TOKENS }],
    api: boundedApi(googleGenerativeAIApi()),
  } as never) as never);
  return { host: { models: { catalog, lead: { provider: LEAD.provider, modelId: LEAD.modelId } } }, models: { lead: `${LEAD.provider}/${LEAD.modelId}` } };
}
