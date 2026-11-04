// A model provider that refuses the run's key (401) says so in a person's words, naming the key and where to set it,
// in place of the provider's raw answer as each harness passes it on. Formed where a run's error is (runs.ts), so it
// holds on every harness. Only the shapes the harnesses give count (REFUSED); a 401 anywhere else in an error (a
// count, a file name, a duration, another service's status) is no refused key, and the error is left as it is.
import { DEFAULT_HARNESS } from "./harness.js";
import { redactSecrets } from "./learn/secrets.js";
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
  if (harness === "codex" || harness === "opencode") return row(provider === "openrouter" || openRouterOnly(harness, env) ? "openrouter" : "openai");
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

/** The most of a run's error or a tool's output serve ever shows: a Timeline row's text, cut at 2000 characters
 *  (pi-durable-agent's CAPS.text; a summary and a tool result's preview at 500), which the error box reads too. */
const SHOWN = 2000;

/** `text`, a run's error as serve shows it, with no held secret in it: the one rule learning's checker uses
 *  (learn/secrets.ts redactSecrets: each value as written, JSON-escaped, base64 at each offset, hex and percent-encoded,
 *  and secret-shaped text), over `secrets`, the values the server holds and handed its run.
 *
 *  Only the head serve can show is read: SHOWN characters, plus room for the longest held value in its widest encoded
 *  form (6 times it, for JSON's \uXXXX; percent is 3, hex 2, base64 4/3) and 16 more. A key whose start the cut can show
 *  starts before SHOWN, so it ends inside that head and is found whole; one that starts later is never shown. So a long
 *  error costs no more to redact than a short one, whatever it holds. */
export function redacted(text: string, secrets: readonly string[]): string {
  const longest = secrets.reduce((most, value) => Math.max(most, value.length), 0);
  const window = SHOWN + 6 * longest + 16;
  if (text.length <= window) return redactSecrets(text, secrets, Buffer.byteLength(text));
  const out = redactSecrets(text.slice(0, window), secrets, window * 4);
  // A replacement moves what follows it left by at most S characters in all: the shortening, plus 2 for each "[redacted]"
  // (a value of 8 or 9 characters grows into it). So output[0, SHOWN - S) comes from raw text before SHOWN, where every
  // key that starts ends inside the window and was found whole; past that, a copy the window cut could come into view.
  const shift = window - out.length + 2 * out.split("[redacted]").length - 2;
  const keep = SHOWN - shift;
  return keep <= 0 ? "[redacted]" : `${out.slice(0, keep)}...`;
}

/** A provider's 401 as each harness puts it, at the start of the run's error:
 *  - pi-ai: `401: <body>` (its OpenAI-shaped APIs, OpenRouter's chat completions among them), `401 <body>` (Anthropic's
 *    SDK), or `<provider> API error (401): <body>` (its Responses API, serve's gateway's `agent-model API error (401): …`);
 *  - the Claude CLI, named by its adapter: `claude-agent: Failed to authenticate. API Error: 401 <message>`;
 *  - the Codex binary, named by its adapter: `codex: unexpected status 401 Unauthorized: <message>, url: …`.
 *  The match ends at the status, and the provider's words follow it. */
const REFUSED = /^(?:401\b|[^:\n]*\berror \(401\)|(?:claude-agent: )?(?:Failed to authenticate\. )?API Error: 401\b|(?:codex: )?unexpected status 401\b)/;

/** `text`, a run's error, in a person's words when it is a provider's 401 for `key` (REFUSED), with no value of
 *  `secrets` in it; undefined when it is not one. */
export function keyRefusal(text: string | undefined, key: RunKey | undefined, secrets: readonly string[] = []): string | undefined {
  if (!text || !key) return undefined;
  // Every held key's value out of the whole text first: cut afterwards, a key the provider echoed across the cut would
  // keep its start in the words.
  const said = redacted(text, secrets);
  const at = REFUSED.exec(said);
  if (!at) return undefined;
  const detail = detailOf(said.slice(at[0].length));
  const where = key.saved ? "set it where AgentRun starts, or save it in Settings → Model keys." : "set it where AgentRun starts.";
  return `${key.who} refused ${key.field} (401${detail ? `: ${detail}` : ""}): ${where}`;
}

/** Codex's errors end on the address it sent the request to (", url: " and then serve's own loopback model proxy, with
 *  its port and /v1/responses); any loopback address in a run's error is the host's, never a person's. Only a loopback
 *  host itself: a host name that only starts with a loopback name goes on past it, is a public host, and keeps its
 *  address. Every pattern is tried at one place or advances past what it read, so a rewrite takes time in proportion to
 *  the text. */
const LOOPBACK_TAIL = /^url:\s*https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?![\w.-])(:\d+)?\S*\s*$/i; // key-gate: loopback-rule strips the loopback proxy address codex prints
const LOOPBACK = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?![\w.-])(:\d+)?[^\s,;:)\x22\x27\]]*/gi; // key-gate: loopback-rule replaces any loopback address in a run error
const LOOPBACK_BARE = /(?<![\w.\/-])(?:127\.0\.0\.1|localhost|\[::1\])(:\d+)(?![\w.-])/gi; // key-gate: loopback-rule replaces a bare loopback address with its port, a refused connection to the proxy

/** `text`, a run's error, with no loopback address in it: Codex's `url:` tail goes (tried at the last "url:" only), and
 *  any other, with a scheme or bare with its port, becomes "a local address". */
export function withoutLoopback(text: string): string {
  let at = -1;
  for (const found of text.matchAll(/url:/gi)) at = found.index;
  let out = text;
  if (at >= 0 && LOOPBACK_TAIL.test(text.slice(at))) {
    out = text.slice(0, at).trimEnd();
    if (out.endsWith(",")) out = out.slice(0, -1);
  }
  return out.replace(LOOPBACK, "a local address").replace(LOOPBACK_BARE, "a local address");
}
