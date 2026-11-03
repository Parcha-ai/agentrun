// A model provider that refuses the run's key (401) says so in a person's words, naming the key and where to set it,
// in place of the provider's raw answer as each harness passes it on: pi-ai's (`401: {"message":"User not found"}`),
// the Claude CLI's ("Failed to authenticate. API Error: 401 User not found") and Codex's ("unexpected status 401
// Unauthorized: User not found, url: ..."). Formed where a run's error is (runs.ts), so it holds on every harness.
import { DEFAULT_HARNESS } from "./harness.js";
import { hostModel, MODEL_KEYS, openRouterOnly } from "./model.js";

/** The key a run's model requests carry, and who reads it: a provider's (saved in Settings → Model keys, or set where
 *  AgentRun starts), or serve's gateway's (set where AgentRun starts only). */
export type RunKey = { who: string; field: string; saved: boolean };

const row = (id: string): RunKey | undefined => {
  const found = MODEL_KEYS.find((r) => r.id === id);
  return found && { who: found.label, field: found.field, saved: true };
};

/** The key `harness`'s run of model `ref` (the revision's; none, this host's default for the harness) sends, by the route
 *  each harness takes (adapters.ts, model.ts); undefined where it is not a model key this server names. */
export function runKeyOf(env: NodeJS.ProcessEnv, harness: string = DEFAULT_HARNESS, ref?: string): RunKey | undefined {
  const named = ref ?? hostModel(env, "default", harness);
  const provider = named?.includes("/") ? named.slice(0, named.indexOf("/")) : undefined;
  const gateway: RunKey = { who: "The gateway at AGENT_MODEL_BASE_URL", field: "AGENT_MODEL_API_KEY", saved: false };
  if (harness === "claude-agent") return row(provider === "openrouter" || openRouterOnly("claude-agent", env) ? "openrouter" : "anthropic");
  if (env.AGENT_MODEL_BASE_URL) return gateway;
  if (harness === "codex") return row(provider === "openrouter" || openRouterOnly("codex", env) ? "openrouter" : "openai");
  return provider === undefined ? undefined : row(provider);
}

/** The provider's own words after its 401: the message of the JSON it answered, else the text, its status word and any
 *  `url:` tail cut; its first sentence only, at most 200 characters. */
function detailOf(rest: string): string {
  const brace = rest.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(rest.slice(brace, rest.lastIndexOf("}") + 1)) as { error?: { message?: unknown } | string; message?: unknown };
      const said = typeof body.error === "object" ? body.error?.message : body.error ?? body.message;
      if (typeof said === "string") rest = said;
    } catch {
      rest = rest.slice(0, brace);
    }
  }
  const text = rest.replace(/^[\s:.-]*(unauthorized\b)?[\s:.-]*/i, "").replace(/,?\s*url:.*$/is, "").trim();
  return (text.split(/(?<=[.!?])\s/)[0] ?? "").slice(0, 200).replace(/[.\s]+$/, "");
}

/** `text`, a run's error, in a person's words when it is a provider's 401 for `key`, with no value of `secrets` in it;
 *  undefined when it is not one. */
export function keyRefusal(text: string | undefined, key: RunKey | undefined, secrets: readonly string[] = []): string | undefined {
  if (!text || !key) return undefined;
  const at = /(?:^|\D)401(?:\D|$)/.exec(text);
  if (!at) return undefined;
  let detail = detailOf(text.slice(at.index + at[0].indexOf("401") + 3));
  for (const secret of secrets) if (secret.length >= 8) detail = detail.split(secret).join("[redacted]");
  const where = key.saved ? "set it where AgentRun starts, or save it in Settings → Model keys." : "set it where AgentRun starts.";
  return `${key.who} refused ${key.field} (401${detail ? `: ${detail}` : ""}): ${where}`;
}
