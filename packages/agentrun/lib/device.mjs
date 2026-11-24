// Device sign-in (RFC 8628) for `agentrun login`, used when the target's GET /v2/capabilities offers it:
// `sign_in.device`, the metadata's URL and the scope to ask for. The person opens the address printed, enters the code
// and approves there; the token endpoint then answers a token, which login keeps where it keeps a pasted one. Every URL
// fetched is on the target's own origin, over https unless the target is on this machine; no redirect is followed; each
// answer's size and shape are checked before any of it is used. The device code and the token are never printed, never
// in an error and never in argv.
import { OWN_VERSION } from "./own.mjs";
import { CLOUD_CONSOLE, CLOUD_URL } from "./target.mjs";

/** What each request of the flow names itself: this package and its version. */
const USER_AGENT = `agentrun-cli/${OWN_VERSION}`;

/** A sign-in that stopped: its exit code (cli.mjs's), and words of this CLI's own, never a server's answer. */
export class SignInError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NOTHING = "nothing was written";
const refuse = (code, message) => new SignInError(code, message);
const bad = (what) => refuse(1, `The server's device sign-in ${what}; ${NOTHING}.`);

/** The most read of a capabilities answer, and of each answer of the device flow. */
const CAPABILITIES_BYTES = 4 * 1024 * 1024;
const ANSWER_BYTES = 64 * 1024;
/** How long one request may take. */
const REQUEST_MS = 10_000;
/** The longest wait between two polls after a server error or a failed request. */
const BACKOFF_MS = 60_000;
/** The interval when the authorization's answer names none (RFC 8628 3.2), and what slow_down adds to it (3.5). */
const INTERVAL_S = 5;
const SLOW_DOWN_MS = 5_000;
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]); // key-gate: loopback-rule the hosts a device sign-in may reach over http
const VISIBLE = /^[\x21-\x7e]{1,2048}$/;
/** A user code is printed on the line after the cross-origin one: a short token with no space, so a server can't put a
 *  sentence of its own beside the warning. */
const USER_CODE = /^[\x21-\x7e]{1,32}$/;
const SECRET = /^[\x21-\x7e]{1,8192}$/;
const SCOPE_TOKEN = "[\\x21\\x23-\\x5b\\x5d-\\x7e]+";
const SCOPE = new RegExp(`^${SCOPE_TOKEN}(?: ${SCOPE_TOKEN})*$`);
const OBJECT = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SECONDS = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** `value` as a URL when this flow takes it: absolute and printable, with no user, password, fragment, backslash or port
 *  0, no query unless `query`; https, or http on a loopback host while the target is on one too; and on the target's own
 *  origin unless `elsewhere` (an address the person opens, which the flow never fetches). Else undefined. */
function urlOf(value, target, { query = false, elsewhere = false } = {}) {
  if (typeof value !== "string" || !VISIBLE.test(value) || /[\\#]/.test(value) || (!query && value.includes("?")) || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.port === "0") return undefined;
  const sealed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname) && LOOPBACK.has(target.hostname));
  return sealed && (elsewhere || url.origin === target.origin) ? url : undefined;
}

/** An OAuth error code from an answer's body, when it is one: a short lowercase word, never a server's free text. */
const errorOf = (body) => (typeof body?.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error : undefined);

/** `response`'s body, or undefined past `max` bytes, read no further. */
async function capped(response, max) {
  if (Number(response.headers.get("content-length")) > max) return void (await response.body?.cancel());
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One request, never redirected: `{ status, redirect }` for a 3xx, else `{ status, body, retryAfter }`, body the answer's
 *  JSON object (undefined when it holds none or is past `max`), retryAfter its Retry-After from `now`. A request that
 *  fails throws as fetch does. */
async function ask(url, { form, max = ANSWER_BYTES, ms = REQUEST_MS, now = Date.now } = {}) {
  const response = await fetch(url, {
    method: form ? "POST" : "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(ms),
    headers: { accept: "application/json", "user-agent": USER_AGENT, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  if (response.status >= 300 && response.status < 400) return await response.body?.cancel(), { status: response.status, redirect: true };
  const bytes = await capped(response, max);
  let body;
  try {
    body = bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
  } catch {
    body = undefined;
  }
  return { status: response.status, body: OBJECT(body) ? body : undefined, retryAfter: retryAfterMs(response.headers.get("retry-after"), now()) };
}

/** A Retry-After header's wait in ms from `now` (RFC 9110 10.2.3: delay seconds, or an HTTP date), 0 for anything else
 *  or a time already past. It is never cut short: the code's expiry bounds every wait. */
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string" || value.length > 64) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = /[a-z]/i.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > now ? at - now : 0;
}

/** Why a request failed, in a word: the cause's code, or the error's name (TimeoutError). */
const why = (error) => (typeof error?.cause?.code === "string" ? error.cause.code : typeof error?.name === "string" ? error.name : "an error");

/** The target's GET /capabilities, asked with no token: its JSON object, or undefined when it answers no 2xx (a target
 *  that offers nothing, so login reads a token from stdin). A redirect, an answer that is not a JSON object, or a target
 *  not reached is refused. */
export async function capabilitiesOf(base) {
  let answer;
  try {
    answer = await ask(`${base}/capabilities`, { max: CAPABILITIES_BYTES });
  } catch (error) {
    throw refuse(3, `Cannot reach the server at ${base} (${why(error)}); ${NOTHING}.`);
  }
  if (answer.redirect) throw refuse(1, `The server at ${base} answered GET /capabilities with a redirect (${answer.status}), which login never follows: give the address it redirects to; ${NOTHING}.`);
  if (answer.status < 200 || answer.status > 299) return undefined;
  if (!answer.body) throw refuse(1, `The server at ${base} answered GET /capabilities with something other than a JSON object; ${NOTHING}.`);
  return answer.body;
}

/** The device sign-in a capabilities answer offers, `{ metadata, scope }`, or undefined when it offers none (no
 *  sign_in.device). An offer this flow cannot take is refused: a target over http off this machine (exit 2), or an offer
 *  that is malformed or whose metadata is off the target's origin (exit 1). */
export function deviceOffer(capabilities, base) {
  const offer = capabilities?.sign_in;
  if (offer === undefined || offer === null) return undefined;
  if (!OBJECT(offer)) throw bad("offer (sign_in) is not an object");
  if (offer.device === undefined) return undefined;
  const target = new URL(base);
  if (target.protocol !== "https:" && !LOOPBACK.has(target.hostname)) throw refuse(2, `The server at ${base} offers a device sign-in over http, which would carry the token in the clear: use its https address; ${NOTHING}.`);
  const metadata = OBJECT(offer.device) ? urlOf(offer.device.metadata, target) : undefined;
  const scope = offer.device?.scope;
  if (!metadata || typeof scope !== "string" || scope.length > 1024 || !SCOPE.test(scope)) {
    throw bad("offer (sign_in.device) is not one this CLI takes: metadata must be an https URL on the server's own origin (http only on this machine) and scope an OAuth scope");
  }
  return { metadata, scope };
}

const CLOUD_PAIR = { api: new URL(CLOUD_URL).origin, page: new URL(CLOUD_CONSOLE).origin };

/** The origins of the printed `addresses` other than the target's, each once. Another origin is taken, not refused (a
 *  self-hosted console may live elsewhere), so the person is told it before the code. Cloud's API with its console page
 *  is the one pair never named, and it is exempt from this line alone. */
export function elsewhereOf(target, addresses) {
  const own = new URL(target).origin;
  const known = (origin) => own === CLOUD_PAIR.api && origin === CLOUD_PAIR.page;
  return [...new Set(addresses.filter((at) => at != null).map((at) => new URL(at).origin))].filter((origin) => origin !== own && !known(origin));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The device flow for `offer` on the target `base`, its lines to the person on `io.stderr`: the token, once the person
 *  approved. Every wait is `wait(ms)`'s and every reading of the time `now()`'s (a test's fake clock). Every refusal is a
 *  SignInError that says nothing was written. */
export async function deviceSignIn(base, offer, io, { wait = sleep, now = Date.now } = {}) {
  const target = new URL(base);
  // The server first, before anything else of the flow: a server named by a stale or wrong AGENTRUN_BASE_URL is seen
  // before any code is approved.
  io.stderr.write(`Signing in to ${target.origin}.\n`);
  const unreached = (url, error) => refuse(3, `Cannot reach ${url.origin} for the device sign-in (${why(error)}); ${NOTHING}.`);

  let meta;
  try {
    meta = await ask(offer.metadata, { now });
  } catch (error) {
    throw unreached(offer.metadata, error);
  }
  if (meta.redirect) throw bad(`metadata answered with a redirect (${meta.status}), which this CLI never follows`);
  if (meta.status !== 200 || !meta.body) throw bad(`metadata answered ${meta.status}${meta.body ? "" : ", not a JSON object (or one too large)"}`);
  // Only the fields the flow uses: the scope it asks for is the capabilities' (offer.scope), and no issuer is read.
  const m = meta.body;
  if (["client_id", "device_authorization_endpoint", "token_endpoint", "resource"].some((field) => typeof m[field] !== "string" || !VISIBLE.test(m[field]))) {
    throw bad("metadata lacks a field it needs, or holds one this CLI does not take");
  }
  const authorization = urlOf(m.device_authorization_endpoint, target);
  const tokenAt = urlOf(m.token_endpoint, target);
  if (!authorization || !tokenAt) throw bad("metadata names an endpoint that is off the server's own origin or not over https");
  if (m.verification_uri != null && !urlOf(m.verification_uri, target, { query: true, elsewhere: true })) throw bad("metadata's verification_uri is not an https URL");

  const started = now();
  let granted;
  try {
    granted = await ask(authorization, { form: { client_id: m.client_id, scope: offer.scope, audience: m.resource }, now });
  } catch (error) {
    throw unreached(authorization, error);
  }
  if (granted.redirect) throw bad(`authorization endpoint answered with a redirect (${granted.status}), which this CLI never follows`);
  const g = granted.body;
  if (granted.status === 200 && !g) throw bad("authorization endpoint answered something other than a JSON object, or one too large");
  if (granted.status !== 200 || g.error !== undefined) {
    const code = errorOf(g);
    if (code === "access_denied") throw refuse(4, `The sign-in was denied; ${NOTHING}.`);
    throw refuse(1, `The server refused the device sign-in request: ${granted.status}${code ? ` ${code}` : ""}; ${NOTHING}.`);
  }
  const interval = g.interval === undefined ? INTERVAL_S : g.interval;
  if (typeof g.device_code !== "string" || !SECRET.test(g.device_code) || typeof g.user_code !== "string" || !USER_CODE.test(g.user_code)
    || !urlOf(g.verification_uri, target, { query: true, elsewhere: true }) || (g.verification_uri_complete != null && !urlOf(g.verification_uri_complete, target, { query: true, elsewhere: true }))
    || !SECONDS(g.expires_in, 1, 3600) || !SECONDS(interval, 1, 300)) {
    throw bad("authorization endpoint answered a code this CLI does not take");
  }

  // The metadata's verification_uri first, when it names one, as the open-source connector's client does.
  const open = m.verification_uri ?? g.verification_uri;
  const elsewhere = elsewhereOf(target, [open, g.verification_uri_complete]);
  if (elsewhere.length) io.stderr.write(`The code is approved at ${elsewhere.join(" and ")}, not at ${target.origin}. Approve it only if ${target.origin} is the server you meant to sign in to.\n`);
  io.stderr.write(`Open ${open} and enter the code ${g.user_code}${g.verification_uri_complete ? ` (or open ${g.verification_uri_complete})` : ""}.\n`);
  io.stderr.write(`Waiting for the sign-in to be approved there; the code expires in ${Math.ceil(g.expires_in / 60)} min.\n`);

  const deadline = started + g.expires_in * 1000;
  const expired = () => refuse(4, `The code expired before the sign-in was approved; ${NOTHING}. Run agentrun login again.`);
  let every = interval * 1000;
  let delay = every;
  for (;;) {
    if (now() >= deadline) throw expired();
    await wait(Math.min(delay, deadline - now()));
    if (now() >= deadline) throw expired();
    let answer;
    try {
      answer = await ask(tokenAt, { form: { grant_type: GRANT_TYPE, device_code: g.device_code, client_id: m.client_id, audience: m.resource }, ms: Math.max(1, Math.min(REQUEST_MS, deadline - now())), now });
    } catch {
      // Not reached this time (a dropped connection, a timeout): wait longer, until the code expires.
      delay = Math.max(every, Math.min(BACKOFF_MS, delay * 2));
      continue;
    }
    if (answer.redirect) throw bad(`token endpoint answered with a redirect (${answer.status}), which this CLI never follows`);
    const code = errorOf(answer.body);
    if (answer.status === 200) {
      const t = answer.body;
      if (!t || t.error !== undefined || typeof t.access_token !== "string" || !SECRET.test(t.access_token) || typeof t.token_type !== "string" || t.token_type.toLowerCase() !== "bearer" || (t.expires_in !== undefined && !SECONDS(t.expires_in, 1, Number.MAX_SAFE_INTEGER))) {
        throw bad("token endpoint answered a token this CLI does not take (a bearer access_token of printable characters)");
      }
      return t.access_token;
    }
    if (answer.status === 400 && code === "authorization_pending") {
      delay = every;
      continue;
    }
    if (answer.status === 400 && code === "slow_down") {
      every += SLOW_DOWN_MS;
      delay = every;
      continue;
    }
    if (answer.status === 429 || answer.status >= 500) {
      delay = Math.max(every, Math.min(BACKOFF_MS, delay * 2), answer.retryAfter);
      continue;
    }
    if (code === "access_denied") throw refuse(4, `The sign-in was denied; ${NOTHING}.`);
    if (code === "expired_token") throw expired();
    throw refuse(1, `The server refused the sign-in: ${answer.status}${code ? ` ${code}` : ""}; ${NOTHING}.`);
  }
}
