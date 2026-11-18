// telemetry.agentrun.ai: the Cloudflare Worker in front of PostHog for AgentRun's anonymous usage counts
// (docs/telemetry.md, packages/serve/src/telemetry.ts). It takes one event at a time, checks it is ours, rebuilds it from
// the documented fields alone and sends that on with a header set of its own. None of the request's headers go on, so
// PostHog never gets the server's address (no X-Forwarded-For, no CF-Connecting-IP, no X-Real-IP): PostHog's ingest is
// not on Cloudflare, so a Worker's request there carries only the headers the Worker gives it, plus CF-Worker naming
// this zone. The Worker keeps nothing and logs nothing (observability off in wrangler.json).

/** PostHog's US capture route. */
export const UPSTREAM = "https://us.i.posthog.com/i/v0/e/";
/** The one path the server sends to (TELEMETRY_URL in telemetry.ts). */
export const PATH = "/i/v0/e/";
/** An event is about 400 bytes; anything past this is not one of ours. */
export const MAX_BYTES = 2048;

const EVENTS = new Set(["server_started", "heartbeat", "first_run_completed"]);
const RUNS = new Set(["0", "1-10", "11-100", "101+"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const WORD = /^[a-z0-9_]{1,20}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const plain = (status, text) => new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * The event as PostHog gets it, rebuilt from `body`'s documented fields, or undefined when `body` is not one of ours:
 * another key, another event name, a field out of shape. The result never holds a field the server's event does not.
 */
export function eventOf(body, key) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { api_key, event, distinct_id, timestamp, properties: p } = body;
  if (typeof key !== "string" || key === "" || api_key !== key) return undefined;
  if (!EVENTS.has(event) || typeof distinct_id !== "string" || !UUID.test(distinct_id)) return undefined;
  if (typeof timestamp !== "string" || !ISO.test(timestamp) || Number.isNaN(Date.parse(timestamp))) return undefined;
  if (typeof p !== "object" || p === null) return undefined;
  if (typeof p.version !== "string" || !VERSION.test(p.version)) return undefined;
  if (typeof p.os !== "string" || !WORD.test(p.os) || typeof p.arch !== "string" || !WORD.test(p.arch)) return undefined;
  if (!Number.isInteger(p.node) || p.node < 0 || p.node > 999 || !RUNS.has(p.runs)) return undefined;
  return {
    api_key: key,
    event,
    distinct_id,
    timestamp,
    properties: { version: p.version, os: p.os, arch: p.arch, node: p.node, runs: p.runs, $process_person_profile: false, $geoip_disable: true },
  };
}

/** One request: refused in words, or sent on as the rebuilt event. `send` is fetch, a test's fake in tests. */
export async function handle(request, env, send = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return plain(404, "not found");
  if (request.method !== "POST") return plain(405, "POST only");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BYTES) return plain(413, "too large");
  const text = await request.text();
  if (text.length > MAX_BYTES) return plain(413, "too large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return plain(400, "not an AgentRun event");
  }
  const event = eventOf(body, env.TELEMETRY_KEY);
  if (event === undefined) return plain(400, "not an AgentRun event");
  try {
    const sent = await send(env.UPSTREAM || UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2_500),
    });
    return plain(sent.ok ? 200 : 502, sent.ok ? "ok" : "upstream refused");
  } catch {
    return plain(502, "upstream unreachable");
  }
}

export default { fetch: (request, env) => handle(request, env) };
