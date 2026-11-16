// AgentRun's app attribution on OpenRouter (https://openrouter.ai/docs/app-attribution, read 2026-11-16): the one place
// that names the app. HTTP-Referer is the app's permanent id (its URL; without it no app page), X-OpenRouter-Title its
// display name, X-OpenRouter-Categories at most 2 of OpenRouter's own (an unknown one is dropped without an error).
// X-OpenRouter-App-Visibility is never sent: a new app sent `hidden` stays hidden for good, and AgentRun's is public.
// Sent by the model proxy where its upstream is OpenRouter's origin (proxy.ts), by serve's model route where pi-ai sends
// to OpenRouter itself (runner/model-route.ts), and by the Decisions provider, which serve hands this app (decisions.ts).
// A self-hosted server sends them on its owner's own key, so its usage counts toward AgentRun's listing, as Cline's and
// Roo's do; AGENTRUN_OPENROUTER_ATTRIBUTION=off where it starts sends none.

/** AgentRun on OpenRouter: the URL its app page already exists under (the repository's), its name, its categories. */
export const OPENROUTER_APP = { url: "https://github.com/Parcha-ai/agentrun", title: "AgentRun", categories: "cloud-agent,personal-agent" } as const;

/** The setting that turns attribution off: `off` (any case) sends no attribution header. */
export const OPENROUTER_ATTRIBUTION_ENV = "AGENTRUN_OPENROUTER_ATTRIBUTION";

/** Whether `origin` (a base URL) is OpenRouter's: its host is openrouter.ai. */
export function onOpenRouter(origin: string): boolean {
  return URL.canParse(origin) && new URL(origin).hostname === "openrouter.ai";
}

/** AgentRun's app, or none where `env` (the environment AgentRun started in) turns attribution off. */
export function openRouterApp(env: NodeJS.ProcessEnv = process.env): typeof OPENROUTER_APP | undefined {
  return env[OPENROUTER_ATTRIBUTION_ENV]?.trim().toLowerCase() === "off" ? undefined : OPENROUTER_APP;
}

/** The attribution headers a request to OpenRouter carries, or none where `env` turns them off. */
export function openRouterAttribution(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const app = openRouterApp(env);
  return app ? { "HTTP-Referer": app.url, "X-OpenRouter-Title": app.title, "X-OpenRouter-Categories": app.categories } : {};
}
