import type { ClientError } from "./client";
import { clock } from "./format";

export type AuthMode = "signed_in" | "sign_in" | "setup" | "token_link";

/** A server with no accounts: its session read says so (`accounts: false`). */
export const noAccounts = (r: { status: number; body: unknown }): boolean => r.status === 200 && (r.body as { accounts?: unknown } | null)?.accounts === false;

/** Where the person stands, from `GET /v2/auth/session`: no password yet (the first visit sets it), a password and no
 *  session (sign in), or signed in. A server without accounts (`accounts: false`) is reached through the link it
 *  printed, which carries its token once, unless `probe` (the status of a protected read) says the browser is in
 *  already. */

export function authMode(r: { status: number; body: unknown }, probe?: number): AuthMode {
  // No accounts: a protected read that already succeeds (a token the request carries) is in; otherwise use the link.
  if (noAccounts(r)) return probe === 200 ? "signed_in" : "token_link";
  const s = (r.body ?? {}) as { password_set?: boolean; signed_in?: boolean };
  if (s.signed_in) return "signed_in";
  return s.password_set ? "sign_in" : "setup";
}

/** Whether the server's first visit takes the setup code it printed (`GET /v2/auth/session` `setup_code`, served only
 *  before a password is set): a server at a public address, or listening on any address but loopback. */
export const setupTakesCode = (r: { status: number; body: unknown }): boolean => r.status === 200 && (r.body as { setup_code?: unknown } | null)?.setup_code === true;

/** A server at Render's own address (`*.onrender.com`), whose log and token are in the Render dashboard. */
const onRender = (host: string): boolean => /\.onrender\.com$/i.test(host);
/** A server at Railway's own address (`*.up.railway.app`), as the Railway template deploys one: its token in the
 *  service's Variables tab, its log in its deployment's Deploy Logs. */
const onRailway = (host: string): boolean => /\.up\.railway\.app$/i.test(host);

/** Where the setup code is, for whoever is asked for it (often not the one who started the server): the field's hint,
 *  line by line. `host` is the address the page was opened at: Render's own (`*.onrender.com`) and Railway's own
 *  (`*.up.railway.app`) get that host's two places alone; any other gets the log line, where a log is on each kind of
 *  server, and the token that stands in for the code. All say how to get a new code. The page never holds the code:
 *  these are only the places to look. */
export function setupCodePlaces(host: string): string[] {
  const line = "find the newest line that starts “Set up this server:”. Open that line's link, or paste what follows code= here.";
  if (onRender(host)) return [
    "This server is on Render. In the Render dashboard, open this service's Environment tab and paste the value of AGENTRUN_TOKEN here.",
    `Or open the service's Logs tab and ${line}`,
    "A code works once and lasts 30 minutes. When it has run out, Get a new code below prints a fresh one in the Logs tab. AGENTRUN_TOKEN does not expire.",
  ];
  if (onRailway(host)) return [
    "This server is on Railway. In the Railway dashboard, open this service's Variables tab and paste the value of AGENTRUN_TOKEN here.",
    `Or open the Deploy Logs of the service's latest deployment and ${line}`,
    "A code works once and lasts 30 minutes. When it has run out, Get a new code below prints a fresh one in the Deploy Logs. AGENTRUN_TOKEN does not expire.",
  ];
  return [
    `The server printed it in its log: ${line}`,
    "The log is the terminal the server runs in. Installed as a service: agentrun open opens this page with the code filled in, or agentrun service logs shows the log. A systemd unit of your own: journalctl --user -u <unit>. In Docker: docker logs <container>, or docker compose logs. On Render: the service's Logs tab.",
    "A code works once and lasts 30 minutes. When it has run out, Get a new code below prints a fresh one in the log. The server's API token works here too and does not expire: AGENTRUN_TOKEN (on Render, in the service's Environment tab), else the .token file in the server's data folder.",
  ];
}

/** What Get a new code's answer means (`POST /v2/setup/code`: whether the server printed a code, and when the one now
 *  good runs out; never the code): where its line is on this kind of server, and until what time it works. A code still
 *  good is kept, so the page says that one is the newest line. */
export function setupCodeRenewed(host: string, r: { printed: boolean; expires_at: string }): string {
  const log = onRender(host) ? "the service's Logs tab in the Render dashboard"
    : onRailway(host) ? "the Deploy Logs of the service's latest deployment in the Railway dashboard"
    : "the server's log (the terminal it runs in, docker logs <container>, or Render's Logs tab)";
  const line = `it is the newest “Set up this server:” line in ${log}.`;
  return r.printed
    ? `The server printed a new code: ${line} It works once, until ${clock(r.expires_at)}.`
    : `The current code is still good until ${clock(r.expires_at)}, so no new one was printed: ${line}`;
}

// The server says how long to wait (a second at first, a minute at most); a refusal without it says "in a minute".
const tryAgain = (e: ClientError): string => {
  const s = e.retryAfterMs === undefined ? 60 : Math.max(1, Math.ceil(e.retryAfterMs / 1000));
  return `Try again in ${s === 1 ? "a second" : s >= 60 ? "a minute" : `${s} seconds`}.`;
};

/** A refused Get a new code, in plain words; otherwise the server's own message. */
export function newCodeProblem(e: ClientError): string {
  if (e.status === 403 && /has its owner/.test(e.message)) return "This server has its owner already: sign in.";
  return e.message;
}

/** A refused sign-in or setup, in plain words; otherwise the server's own message. */
export function signInProblem(e: ClientError): string {
  if (e.status === 401) return "That is not the password.";
  if (e.status === 429) return `Too many sign-ins. ${tryAgain(e)}`;
  if (e.status === 403 && /has its owner/.test(e.message)) return "This server has its owner already: sign in.";
  if (e.status === 403 && /a new one is in the server's log/.test(e.message)) return "That setup code expired (a code lasts 30 minutes) or was voided after too many wrong tries. The server printed a new one: use the newest “Set up this server:” line in its log (on Render, the Logs tab).";
  if (e.status === 403 && /takes the setup code/.test(e.message)) return "Enter the setup code from the server's log.";
  // A code that is not the current one (an older link, a mistyped code): what to do, the same whether it came from the
  // link or was typed.
  if (e.status === 403 && /setup code/.test(e.message)) return "That setup code was refused: open the newest setup link in the server's log, or paste the server's token (AGENTRUN_TOKEN) here. A code works once and lasts 30 minutes: Get a new code prints a fresh one when it has run out.";
  return e.fields?.[0]?.message ?? e.message;
}

/** The setup code the server's printed link carries (`#code=`), taken once: the rest of the fragment is what the
 *  address keeps, so the code does not stay in the URL or the history (as the server's own setup page does). */
export function takeSetupCode(hash: string): { code: string | null; rest: string } {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const given = params.get("code");
  if (given === null) return { code: null, rest: hash };
  params.delete("code");
  const left = params.toString();
  // A printed code is base64url only: the link's code is its leading run of those, so a character a chat app took into
  // the link after it (a "." or ")", an invisible space) is no part of it. One inside it ends the run there.
  const code = /^[A-Za-z0-9_-]*/.exec(given)![0];
  return { code, rest: left ? `#${left}` : "" };
}
