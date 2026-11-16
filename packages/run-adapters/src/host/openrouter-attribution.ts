// AgentRun's OpenRouter app attribution on the host's model requests: the model proxy adds it where its upstream is
// OpenRouter's origin (proxy.ts), and serve's model route where pi-ai sends to OpenRouter itself. What the headers are
// and when they are off is the one helper (../openrouter-app.ts), which the Decisions and Jev providers send too.
import { openRouterAttribution as attributionOf } from "../openrouter-app.js";

export { OPENROUTER_APP, OPENROUTER_ATTRIBUTION_ENV } from "../openrouter-app.js";

/** Whether `origin` (a base URL) is OpenRouter's: its host is openrouter.ai. */
export function onOpenRouter(origin: string): boolean {
  return URL.canParse(origin) && new URL(origin).hostname === "openrouter.ai";
}

/** The attribution headers a request to OpenRouter carries, or none where `env` turns them off. */
export function openRouterAttribution(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  return attributionOf(env);
}
