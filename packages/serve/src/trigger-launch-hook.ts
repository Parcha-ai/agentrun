// The launch hook: a server started with AGENTRUN_LAUNCH_HOOK_URL and AGENTRUN_LAUNCH_HOOK_SECRET hands each trigger firing
// that would start a run to the host behind it instead (triggers.ts drive), and starts no run of its own for it. The host
// starts the run through the API (POST /v2/agents/{agent_id}/runs with `trigger_firing` and its own model_key, keys and
// max_cost_usd: the firing's run, under its key, triggers.ts handedStart) and answers 2xx, before or after that start
// (after: within LAUNCH_HOOK_LATE_START_MS of that 2xx, the firing's start_by); any other answer, or none within
// LAUNCH_HOOK_TIMEOUT_MS, and the firing is skipped with why, unless the host started its run. Unset, nothing changes.
// Off this machine the hook is https: a firing's input can carry a person's data, and the signature proves who sent it,
// not that no one else read it.
// The POST is signed as the outbound webhook's messages are (standard-webhooks.ts): `webhook-id` (the firing's id, the
// same each time it is handed), `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of
// "{id}.{timestamp}.{body}">` under the secret's key, so a host checks it with any Standard Webhooks library.
import { fetch as undiciFetch } from "undici";
import { keyBytes, MIN_KEY_BYTES, SECRET_PREFIX, signatureOf } from "./standard-webhooks.js";
import type { Json } from "./validate.js";

export const LAUNCH_HOOK_URL_ENV = "AGENTRUN_LAUNCH_HOOK_URL";
export const LAUNCH_HOOK_SECRET_ENV = "AGENTRUN_LAUNCH_HOOK_SECRET";
/** How long the host has to answer a firing, its connection included. */
export const LAUNCH_HOOK_TIMEOUT_MS = 10_000;
/** How long after its 2xx a host that answered without starting the firing's run may still start it (one start, under
 *  the firing: triggers.ts handedStart). From the answer, not from fired_at: a catch-up, a firing that waited on its
 *  trigger's max_active_runs, or one a stop cut short and the next start handed again reaches the host late, and its
 *  host gets the same 10 minutes as any. */
export const LAUNCH_HOOK_LATE_START_MS = 10 * 60_000;

/** A host this machine alone answers: localhost, 127.0.0.0/8 or ::1, as URL writes them (lower case, IPv4 in four parts,
 *  IPv6 in brackets and shortest form). */
const loopback = (hostname: string): boolean => hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);

/** The hook a server hands its firings to: where, and the secret it signs with. `bound`: a test's own signal for a POST's
 *  LAUNCH_HOOK_TIMEOUT_MS, else AbortSignal.timeout. */
export type LaunchHook = { readonly url: string; readonly secret: string; readonly bound?: (ms: number) => AbortSignal };

/** What the host is sent for a firing: its id (the message's webhook-id too), its trigger, the agent and the revision a
 *  run would start on now, the run's input as the trigger gives it, and the firing's time. */
export type HookFiring = { firing_id: string; trigger_id: string; agent_id: string; revision_id: string | null; input: Json; fired_at: string };

/** The host's answer: taken (2xx); or why the firing is skipped; or `stopped`, the server's stop cut it short and the
 *  firing is left as it was. */
export type Handed = { taken: true } | { skipped: string } | { stopped: true };

/** The launch hook `given` sets (the URL from the environment, the secret as the server holds its own), or undefined when
 *  neither is set. Throws, in words that never hold the secret, when one is set without the other, the URL is not https
 *  (http only to loopback) or holds a user or password, or the secret is not a `whsec_` secret of MIN_KEY_BYTES or more. */
export function launchHookFrom(given: { url?: string | undefined; secret?: string | undefined }): LaunchHook | undefined {
  const url = given.url?.trim() || undefined;
  const secret = given.secret?.trim() || undefined;
  if (!url && !secret) return undefined;
  if (!secret) throw new Error(`${LAUNCH_HOOK_URL_ENV} is set without ${LAUNCH_HOOK_SECRET_ENV}: the launch hook signs every firing it hands over. Set both, or neither.`);
  if (!url) throw new Error(`${LAUNCH_HOOK_SECRET_ENV} is set without ${LAUNCH_HOOK_URL_ENV}: the launch hook needs the host's URL. Set both, or neither.`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${LAUNCH_HOOK_URL_ENV} is not a URL: give the host's http or https address for firings.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${LAUNCH_HOOK_URL_ENV} is an http or https address, not ${parsed.protocol}`);
  if (parsed.protocol === "http:" && !loopback(parsed.hostname)) {
    throw new Error(`${LAUNCH_HOOK_URL_ENV} is http to ${parsed.hostname}: a firing's input can carry a person's data, so a hook off this machine is https. Plain http is for 127.0.0.0/8, ::1 or localhost alone.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${LAUNCH_HOOK_URL_ENV} holds no user or password: the host checks the signature.`);
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error(`${LAUNCH_HOOK_SECRET_ENV} is a Standard Webhooks secret: ${SECRET_PREFIX} and its key in base64.`);
  if (keyBytes(secret) < MIN_KEY_BYTES) throw new Error(`${LAUNCH_HOOK_SECRET_ENV}'s key is shorter than ${MIN_KEY_BYTES} bytes: make one of 32 random bytes.`);
  return { url, secret };
}

/** Where `hook` sends, for the start's banner: its origin alone, never a path or query that may hold a token. */
export const hookOrigin = (hook: LaunchHook): string => new URL(hook.url).origin;

/** `firing` handed to `hook`: one signed POST of it, stamped at `now` (the triggers' clock), within the hook's bound and
 *  cut by `stop`. A redirect is not followed. */
export async function handToHost(hook: LaunchHook, firing: HookFiring, stop: AbortSignal, now: () => number = Date.now): Promise<Handed> {
  const timeoutMs = LAUNCH_HOOK_TIMEOUT_MS;
  const body = JSON.stringify(firing);
  const timestamp = String(Math.floor(now() / 1000));
  const headers = {
    "content-type": "application/json",
    "user-agent": "agentrun-serve-launch-hook/1",
    "webhook-id": firing.firing_id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signatureOf(hook.secret, firing.firing_id, timestamp, body),
  };
  const signal = AbortSignal.any([hook.bound ? hook.bound(timeoutMs) : AbortSignal.timeout(timeoutMs), stop]);
  try {
    const res = await undiciFetch(hook.url, { method: "POST", redirect: "manual", signal, headers, body });
    // The answer's body is not read: the run the host started is found by the firing's key, never by what it says.
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status <= 299) return { taken: true };
    const said = res.status >= 300 && res.status < 400 ? `answered ${res.status}: a redirect is not followed` : `answered ${res.status}`;
    return { skipped: `The launch hook ${said}, so the host did not take this firing.` };
  } catch (error) {
    if (stop.aborted) return { stopped: true };
    if ((error as Error).name === "TimeoutError" || signal.aborted) return { skipped: `The launch hook did not answer in ${timeoutMs / 1000} s, so the host did not take this firing.` };
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    return { skipped: `The launch hook was not reached${typeof code === "string" ? ` (${code})` : ""}, so the host did not take this firing.` };
  }
}
