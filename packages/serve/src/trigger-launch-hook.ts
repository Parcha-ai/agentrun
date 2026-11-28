// The launch hook: a server started with AGENTRUN_LAUNCH_HOOK_URL and AGENTRUN_LAUNCH_HOOK_SECRET hands each trigger firing
// that would start a run to the host behind it instead (triggers.ts drive), and starts no run of its own for it. The host
// starts the run through the API (POST /v2/agents/{agent_id}/runs with `trigger_firing` and its own model_key, keys and
// max_cost_usd: the firing's run, under its key, on its trigger's target, triggers.ts handedStart) and answers 2xx,
// before or after that start (after: within LAUNCH_HOOK_LATE_START_MS of that 2xx, the firing's start_by). Any other
// answer, or none within LAUNCH_HOOK_TIMEOUT_MS, is a failed try of the firing under its trigger's retry policy
// (HookFailed), unless the host started its run. Unset, nothing changes.
// Off this machine the hook is https: a firing's input can carry a person's data, and the signature proves who sent it,
// not that no one else read it.
// The POST is signed as the outbound webhook's messages are (standard-webhooks.ts): `webhook-id` (the firing's id, the
// same each time it is handed), `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of
// "{id}.{timestamp}.{body}">` under the secret's key, so a host checks it with any Standard Webhooks library.
import { fetch as undiciFetch } from "undici";
import { answerOf, keyBytes, MIN_KEY_BYTES, SECRET_PREFIX, signedRequest } from "./standard-webhooks.js";
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

/** The hook a server hands its firings to: where, and the secret it signs with. `bound`: a test's seam, a signal that can
 *  cut a POST before LAUNCH_HOOK_TIMEOUT_MS, never after: the 10 s bound is always set as well. */
export type LaunchHook = { readonly url: string; readonly secret: string; readonly bound?: (ms: number) => AbortSignal };

/** What the host is sent for a firing: its id (the message's webhook-id too), its trigger, the agent and the revision a
 *  run would start on now, the run's input as the trigger gives it, the firing's time, and the trigger's cap: the most
 *  its run may cost, which the host's own max_cost_usd may lower and never raise. The firing keeps the lowest cap any
 *  hand of it told (FiringRow.hooked): a retry sends the lower of it and the target's cap by then, and the host's start
 *  runs under the lower of it and the target's cap at the start (toldCap), never past what the host was last told. A
 *  null means the agent's default when the host starts the run. */
export type HookFiring = { firing_id: string; trigger_id: string; agent_id: string; revision_id: string | null; input: Json; fired_at: string; max_cost_usd: number | null };

/** A handed firing's cap: the lower of the lowest its hook told the host (`told`) and its target's now, so a target
 *  lowered after the hand lowers it and one raised after never raises it. A told null (the agent's default) takes the
 *  cap the target has gained since, which the agent's default still bounds at the host's start (TriggerTargets.start). */
export function toldCap(told: number | null, now: number | undefined): number | null {
  if (now === undefined) return told;
  return told === null ? now : Math.min(told, now);
}

/** The host's answer: taken (2xx); or `stopped`, the server's stop cut it short and the firing is left as it was. Any
 *  other answer, or none, is a HookFailed. */
export type Handed = { taken: true } | { stopped: true };

/** Why the hook did not take a firing, a failed try of it (triggers.ts answered): `failure` is the status the host
 *  answered, `timeout` or `unreachable`. No answer, no connection, a 5xx or a 429 is `retryable`, tried again under the
 *  trigger's retry policy; any other answer fails the firing. Its code is hook_failed, and its words begin with it and
 *  the failure, so a firing's error and reason say which. */
export class HookFailed extends Error {
  override name = "HookFailed";
  readonly code = "hook_failed";
  readonly retryable: boolean;
  constructor(readonly failure: number | "timeout" | "unreachable", why: string) {
    super(`hook_failed (${failure}): the launch hook ${why}, so its host did not take this firing.`);
    this.retryable = typeof failure !== "number" || failure >= 500 || failure === 429;
  }
}

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
 *  cut by `stop`. A redirect is not followed. Throws HookFailed when the host does not take it. */
export async function handToHost(hook: LaunchHook, firing: HookFiring, stop: AbortSignal, now: () => number = Date.now): Promise<Handed> {
  const body = JSON.stringify(firing);
  const timestamp = String(Math.floor(now() / 1000));
  const headers = signedRequest(hook.secret, firing.firing_id, timestamp, body, "agentrun-serve-launch-hook/1");
  const signal = AbortSignal.any([AbortSignal.timeout(LAUNCH_HOOK_TIMEOUT_MS), ...(hook.bound ? [hook.bound(LAUNCH_HOOK_TIMEOUT_MS)] : []), stop]);
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(hook.url, { method: "POST", redirect: "manual", signal, headers, body });
  } catch (error) {
    if (stop.aborted) return { stopped: true };
    if ((error as Error).name === "TimeoutError" || signal.aborted) throw new HookFailed("timeout", `did not answer in ${LAUNCH_HOOK_TIMEOUT_MS / 1000} s`);
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    throw new HookFailed("unreachable", `was not reached${typeof code === "string" ? ` (${code})` : ""}`);
  }
  // The answer's body is not read: the run the host started is found by the firing's key, never by what it says.
  const failure = await answerOf(res);
  if (failure === undefined) return { taken: true };
  throw new HookFailed(res.status, failure);
}
