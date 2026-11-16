// AgentRun's app attribution on OpenRouter (https://openrouter.ai/docs/app-attribution, read 2026-11-16): the one place
// that names the app. HTTP-Referer is the app's permanent id (its URL; without it no app page), X-OpenRouter-Title its
// display name, X-OpenRouter-Categories at most 2 of OpenRouter's own (an unknown one is dropped without an error).
// X-OpenRouter-App-Visibility is never sent: a new app sent `hidden` stays hidden for good, and AgentRun's is public.
// Sent by the model proxy where its upstream is OpenRouter's (host/proxy.ts), by the runner's model route where pi-ai
// sends to OpenRouter itself (serve runner/model-route.ts), and by the Decisions and Jev providers on OpenRouter
// (decisions openrouter.ts, jev index.ts), each importing it from `@parcha/agentrun-kernel/openrouter-app`. A self-hosted
// server sends them on its owner's own key, so its usage counts toward AgentRun's listing, as Cline's and Roo's do;
// AGENTRUN_OPENROUTER_ATTRIBUTION=off where it starts sends none.

/** AgentRun on OpenRouter: the URL its app page already exists under (the repository's), its name, its categories. */
export const OPENROUTER_APP = { url: "https://github.com/Parcha-ai/agentrun", title: "AgentRun", categories: "cloud-agent,personal-agent" } as const;

/** The setting that turns attribution off: `off` (any case) sends no attribution header. */
export const OPENROUTER_ATTRIBUTION_ENV = "AGENTRUN_OPENROUTER_ATTRIBUTION";

/** Another app's own attribution, for a library caller that names its app (the Decisions provider's `app` option): its
 *  URL and title in place of AgentRun's, and none of AgentRun's categories. */
export type OpenRouterApp = { url?: string; title?: string };

/** The attribution headers a request to OpenRouter carries: AgentRun's, or `app`'s where a caller names its own; none
 *  where `env` (the environment the process started in) turns them off. */
export function openRouterAttribution(env: Readonly<Record<string, string | undefined>>, app?: OpenRouterApp): Readonly<Record<string, string>> {
  if (env[OPENROUTER_ATTRIBUTION_ENV]?.trim().toLowerCase() === "off") return {};
  if (app) return { ...(app.url ? { "HTTP-Referer": app.url } : {}), ...(app.title ? { "X-OpenRouter-Title": app.title } : {}) };
  return { "HTTP-Referer": OPENROUTER_APP.url, "X-OpenRouter-Title": OPENROUTER_APP.title, "X-OpenRouter-Categories": OPENROUTER_APP.categories };
}
