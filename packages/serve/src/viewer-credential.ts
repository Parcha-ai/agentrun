// A run's viewer credential on an API-only server (AGENTRUN_API_ONLY=1): what POST /v2/runs/{id}/computer/viewer mints
// with the server's token, for the backend in front of this server to hand its user, whose browser has no owner's
// session here. It opens that run's live page, its files and its socket (/v2/runs/{id}/computer/live/...) and nothing
// else, from AGENTRUN_PUBLIC_URL's origin alone (server.ts checks the Origin).
//
// Its form: `<expiry, ms since the epoch>.<HMAC-SHA256 of (run id, expiry) under a key from the seal key>`, base64url.
// Nothing is stored: every server on the same store has the same seal key, so each checks it alike, and a restart changes
// nothing. It is revoked by its run's end: whoever checks it reads the run's row each time (computer-commands.ts runOver),
// so a run that ended (completed, failed or cancelled) refuses it on every server at once, and an open socket on it is
// closed within LIVE_RECHECK_MS (browser-live.ts OpenViewers). A stop (input_required) does not end it: the run is still
// open, its computer may still be up, and its next message goes on; the minutes below bound it then.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { cookiesOf, overHttps } from "./page.js";

/** How long a credential opens a run's live view: 5 minutes, long enough for a backend to hand the link to its user's
 *  browser and for that page to open its socket, short enough that a link left in a history or a log is dead soon after.
 *  A socket opened in time stays open until its run ends (or its viewer does): the view goes on while the person watches. */
export const VIEWER_CREDENTIAL_MS = 5 * 60_000;

/** The query parameter the minted link carries the credential in; the page's answer sets it as a cookie for its files and
 *  socket, which the page asks for by path alone. */
export const VIEWER_PARAM = "viewer";
const COOKIE = "agentrun-viewer";
const FORM = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

/** The credentials' key, from the server's seal key: one purpose, never the seal key itself. */
export const viewerCredentialKey = (sealKey: Buffer): Buffer => createHmac("sha256", sealKey).update("agentrun live viewer credential").digest();

const macOf = (key: Buffer, runId: string, expiresAt: number): Buffer => createHmac("sha256", key).update(`${runId}\n${expiresAt}`).digest();

/** A credential for run `runId`, from `now`: its value and when it expires (ms since the epoch). */
export function mintViewerCredential(key: Buffer, runId: string, now: number): { credential: string; expiresAt: number } {
  const expiresAt = now + VIEWER_CREDENTIAL_MS;
  return { credential: `${expiresAt}.${macOf(key, runId, expiresAt).toString("base64url")}`, expiresAt };
}

/** Whether `credential` was minted for run `runId` and has not expired at `now`, its MAC compared in constant time. Its
 *  run's end is the caller's to read. */
export function viewerCredentialFor(key: Buffer, runId: string, credential: string, now: number): boolean {
  const [, expiry, mac] = FORM.exec(credential) ?? [];
  if (expiry === undefined || mac === undefined) return false;
  const expiresAt = Number(expiry);
  const given = Buffer.from(mac, "base64url");
  const expected = macOf(key, runId, expiresAt);
  return given.length === expected.length && timingSafeEqual(given, expected) && now < expiresAt;
}

/** The credential a request to a run's live view carries: the link's query parameter (the page), else its cookie (the
 *  page's files and socket). */
export function viewerCredentialOf(req: IncomingMessage): string | undefined {
  const query = (req.url ?? "").split("?")[1];
  const given = query === undefined ? null : new URLSearchParams(query).get(VIEWER_PARAM);
  return given ?? cookiesOf(req, COOKIE)[0];
}

/** The cookie the page's answer sets: run `runId`'s live view's path alone, until the credential expires. */
export const viewerCookie = (req: IncomingMessage, runId: string, credential: string, expiresAt: number, now: number): string =>
  `${COOKIE}=${credential}; HttpOnly; SameSite=Strict; Path=/v2/runs/${runId}/computer/live; Max-Age=${Math.max(0, Math.floor((expiresAt - now) / 1000))}${overHttps(req) ? "; Secure" : ""}`;

/** When `credential` expires (ms since the epoch): read only after viewerCredentialFor took it. */
export const viewerExpiry = (credential: string): number => Number(credential.split(".")[0]);
