// The console at "/" (apps/console, which this package's build copies into dist/console): its index.html and Vite's
// hashed assets under /assets/, public, under one strict CSP. The console signs a person in itself. With accounts it
// takes the owner's session cookie (owner.ts); without, a console session the link this start prints (`/?launch=<code>`)
// sets (ConsoleSessions): made at random, kept by the server, never computable from the API token, and the token's own
// link signs no browser in. Either stands in for the Bearer header on /v2, and for a write only from this origin with a JSON body, or
// with any body on a route that takes bytes (a PUT or POST marked `raw` in server.ts).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import type { Owner } from "./owner.js";
import { fileURLToPath } from "node:url";
import { ApiError } from "./errors.js";
import { hostPort, hostRefusedPage, movedPage } from "./host-check.js";

// img-src names Google's favicon service and the four hosts it redirects to: the console's Keys page shows a provider's
// icon from it (apps/console/src/components/ProviderIcon.tsx), sent with no referrer. Everything else is this origin's.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://www.google.com https://t0.gstatic.com https://t1.gstatic.com https://t2.gstatic.com https://t3.gstatic.com; base-uri 'none'; form-action https://github.com; frame-ancestors 'none'";
const SECURITY = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
const HTML = "text/html; charset=utf-8";
/** Strict-Transport-Security for a server whose public address (AGENTRUN_PUBLIC_URL) is https: a browser that saw it
 *  once opens the address over https only, for a year. None over http or with no public address (a browser would pin
 *  the loopback address to https and lose the console). */
export function hstsHeaders(publicUrl: string | undefined): Record<string, string> {
  try {
    return publicUrl && new URL(publicUrl).protocol === "https:" ? { "strict-transport-security": "max-age=31536000" } : {};
  } catch {
    return {};
  }
}
/** The console's build, beside the server. */
const CONSOLE_DIR = fileURLToPath(new URL("./console/", import.meta.url));
/** The kinds of file Vite builds the console into; any other is not served. */
const CONSOLE_TYPES: Record<string, string> = { ".html": HTML, ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff" };
/** A segment of an asset's path as sent: no dot segment, no hidden file, no percent-encoding, no separator. */
const CONSOLE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** Addresses the console had before it took "/", and the old page's setup and sign-in, which the printed setup link
 *  still names: each sends the browser to "/", which keeps the link's #code. */
const MOVED = new Set(["/console", "/console/", "/setup", "/sign-in"]);
/** The share preview's addresses (the console's second entry, share.html): the page at /share/<run>, and the console's
 *  assets under /share/assets/, where the page's relative URLs land. */
const SHARE = "/share/";
/** A run's id as the share page's address names it: one segment, never a dot segment, a trailing slash allowed. */
const SHARE_RUN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/?$/;
/** The share page's answer to a browser without this server's session: a fixed page under the CSP, never share.html. */
const SIGN_IN_FIRST = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" /><title>Sign in first · AgentRun</title></head>
<body><main><h1>Sign in to this server first</h1><p>A share preview shows what a run's share would publish, and only this server's owner may read it. Sign in at <a href="/">the console</a>, or open the link this server printed when it started, then open this page again.</p></main></body></html>
`;

const digest = (text: string) => createHash("sha256").update(text).digest();
const same = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));
/** The most console sessions a server keeps at once; past it, the oldest is forgotten (its browser opens the link again). */
const CONSOLE_SESSIONS = 64;

/**
 * The console's sessions on a server with no accounts. Each start makes a launch code at random and prints its link
 * (`/?launch=<code>`, Serve's `consoleUrl`); a browser that opens it gets a session: an id made at random, kept here, in
 * memory, as its cookie. Neither the code nor an id is derived from the API token, so the token, whoever holds it, never
 * computes or fetches a session: its own link (`/?token=`) signs no browser in. A restart forgets them, and the new
 * start prints its own link.
 */
export class ConsoleSessions {
  readonly code = randomBytes(24).toString("base64url");
  /** The sessions, by the hash of their id (a lookup that reads no id), oldest first. */
  private readonly ids = new Set<string>();

  /** A new session's id when `code` is this start's, else undefined. */
  open(code: string): string | undefined {
    if (!same(code, this.code)) return undefined;
    const id = randomBytes(32).toString("base64url");
    this.ids.add(digest(id).toString("hex"));
    if (this.ids.size > CONSOLE_SESSIONS) this.ids.delete(this.ids.values().next().value!);
    return id;
  }

  /** Whether `value` is a session this server made. */
  holds(value: string): boolean {
    return this.ids.has(digest(value).toString("hex"));
  }
}
/** One name per port the browser opened: cookies are kept per host, not per port, and another server on this machine has
 *  another token. The port is the Host header's, the browser's: a server in a container sees its own port on its socket
 *  (7340, published at 7350), and so does another beside it. A Host with no port keeps the socket's. */
const browserPort = (req: IncomingMessage) => hostPort(req.headers.host) ?? req.socket.localPort;
const cookieName = (req: IncomingMessage) => `agentrun-${browserPort(req)}`;
export const cookiesOf = (req: IncomingMessage, name: string) =>
  String(req.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
/** Whether the browser reached this server over TLS, as the proxy in front says (X-Forwarded-Proto): `https`, or `wss`,
 *  which some proxies (Traefik) send on a WebSocket upgrade. Both are the page's https origin and its `__Host-` cookie. */
export const overHttps = (req: IncomingMessage) => ["https", "wss"].includes(String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase());
export const ownOrigin = (req: IncomingMessage) => `${overHttps(req) ? "https" : "http"}://${String(req.headers.host ?? "").toLowerCase()}`;
export const isJson = (req: IncomingMessage) => String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";

/** The owner's session cookie: `__Host-` on https, so no other host or path can set it; else one per port the browser opened. */
export const ownerCookieName = (req: IncomingMessage) => (overHttps(req) ? "__Host-agentrun-session" : `agentrun-${browserPort(req)}-session`);
/** A Set-Cookie line for the owner's session: `value`, or an empty one that ends it (`maxAgeS` 0); under `name`, this
 *  request's own unless another is given. */
export const ownerCookie = (req: IncomingMessage, value: string, maxAgeS: number, name = ownerCookieName(req)) =>
  `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${overHttps(req) ? "; Secure" : ""}`;
/** The owner's session cookies the request holds under this request's name and under any port's (`agentrun-<port>-session`),
 *  each with its name, valid or not: a browser sends a host's cookies to every port of it, so one signed in at 7340 and
 *  again through a tunnel at 8080 sends both to either. Which are this server's is the owner's to say (Owner.valid). */
export const sessionsAtEveryPort = (req: IncomingMessage): Array<{ name: string; value: string }> => {
  const own = ownerCookieName(req);
  return String(req.headers.cookie ?? "").split(";").flatMap((part) => {
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim();
    return at > 0 && (name === own || /^agentrun-\d{1,5}-session$/.test(name)) ? [{ name, value: part.slice(at + 1).trim() }] : [];
  });
};
/** The owner's session cookies the request holds, valid or not. */
export const heldSessions = (req: IncomingMessage) => cookiesOf(req, ownerCookieName(req));
/** Whether the request holds a session the owner signed in. */
export const signedIn = (req: IncomingMessage, owner: Owner) => heldSessions(req).some((value) => owner.valid(value));

function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: Buffer | string, headers: Record<string, string> = {}): void {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { ...SECURITY, "content-type": type, "content-length": bytes.length, ...headers });
  res.end(req.method === "HEAD" ? undefined : bytes);
}
/** A browser's answer for a Host the server refuses (host-check.ts): 403, a fixed page under the console's CSP. */
export const sendHostRefused = (req: IncomingMessage, res: ServerResponse) => send(req, res, 403, HTML, hostRefusedPage(req.socket.localPort ?? 0));
/** Whether `raw` is the console's own page, or one of the addresses that send a browser to it (MOVED). */
export const consoleEntry = (raw: string) => raw === "/" || MOVED.has(raw);
/** A browser's answer for the console under the server's earlier public address (public-address.ts): 308 to the new one,
 *  `to`, whose console takes the link's #fragment along (a browser keeps it across a redirect). no-store, so no browser
 *  keeps the redirect: the address may change back. */
export const sendMoved = (res: ServerResponse, to: string) => (res.writeHead(308, { ...SECURITY, location: `${to}/`, "content-length": 0 }), void res.end());
/** A browser's answer for any other page under the earlier public address: 403, a fixed page that links to `to`. */
export const sendMovedPage = (req: IncomingMessage, res: ServerResponse, to: string) => send(req, res, 403, HTML, movedPage(to));
const refuse = (req: IncomingMessage, res: ServerResponse, error: ApiError) =>
  send(req, res, error.status, "application/json", JSON.stringify(error.body(String(res.getHeader("x-request-id") ?? ""))), error.headers);

/** `takesBytes`: whether a request of `method` to `path` (under /v2) goes to a route whose body is bytes (server.ts). */
/** `publicUrl`: the address people open (AGENTRUN_PUBLIC_URL); an https one adds HSTS to every page answer (hstsHeaders). */
/** `sessions`: the console's sessions on a server with no accounts (ConsoleSessions); with `owner`, none. */
type PageServer = { token: string; authFailed?: (route: string, reason: string) => void; owner?: Owner; sessions?: ConsoleSessions; console?: string | undefined; takesBytes?: (method: string | undefined, path: string) => boolean; publicUrl?: string };

const redirect = (res: ServerResponse, location: string, headers: Record<string, string> = {}) => (res.writeHead(303, { ...SECURITY, location, "content-length": 0, ...headers }), void res.end());

/** A file of the console: a known type inside `dir`, read through no link that leaves it. Vite's hashed assets are cached
 *  for a year; index.html is no-store. `hosted`: a share host's answer (its own headers, and the page's text rewritten). */
async function file(req: IncomingMessage, res: ServerResponse, raw: string, dir: string, rel: string, status = 200, hosted?: { headers: Record<string, string>; rewrite?: (text: string) => string }): Promise<void> {
  const missing = () => refuse(req, res, new ApiError("not_found", `no file ${raw} in the console`));
  const type = CONSOLE_TYPES[extname(rel).toLowerCase()];
  if (!type || !rel.split("/").every((segment) => CONSOLE_SEGMENT.test(segment))) return missing();
  const [root, real] = await Promise.all([realpath(dir).catch(() => null), realpath(join(dir, rel)).catch(() => null)]);
  if (!root || !real) {
    // A refusal (a wrong link token) stays a refusal on a server without its console: only a plain miss is a 404.
    return rel === "index.html" ? send(req, res, status === 200 ? 404 : status, "text/plain; charset=utf-8", "This server was built without its console: run npm ci && npm run build at the repository's root, which builds the console first, then start the server again.\n") : missing();
  }
  if (!real.startsWith(root + sep) || !(await stat(real)).isFile()) return missing();
  const bytes = await readFile(real);
  send(req, res, status, type, hosted?.rewrite ? hosted.rewrite(bytes.toString("utf8")) : bytes, { "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store", ...hosted?.headers });
}

/** A share host's pages' CSP (share-host.ts): this origin's scripts, styles, data, and nothing from anywhere else, so a
 *  public page makes no outbound fetch (a graph's image URL among them). */
export const SHARE_HOST_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HOSTED = { "content-security-policy": SHARE_HOST_CSP, "x-robots-tag": "noindex" };
/** The page's asset URLs as Vite writes them with base "./" (`./assets/x`), moved under the share host's /r/_assets/: the
 *  page answers at /r/<id> and /r/<id>/, where a relative URL would land elsewhere. */
const hostedAssets = (text: string) => text.replace(/(\s(?:src|href)=["'])\.\/assets\//g, "$1/r/_assets/");
/** A share host's page for a share (the console's share.html), its asset URLs under /r/_assets/, under SHARE_HOST_CSP. */
export const sendHostedSharePage = (req: IncomingMessage, res: ServerResponse, dir: string | undefined) => file(req, res, "/r/<id>", dir ?? CONSOLE_DIR, "share.html", 200, { headers: HOSTED, rewrite: hostedAssets });
/** A share host's asset at /r/_assets/`rel`: the console's assets/`rel`, the same rules as /assets/. */
export const sendHostedAsset = (req: IncomingMessage, res: ServerResponse, raw: string, dir: string | undefined, rel: string) =>
  rel.endsWith(".html") ? refuse(req, res, new ApiError("not_found", `no file ${raw} in the console`)) : file(req, res, raw, dir ?? CONSOLE_DIR, `assets/${rel}`, 200, { headers: HOSTED });

async function answer(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer, held: boolean): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(req, res, new ApiError("method_not_allowed", `the console answers GET and HEAD; ${req.method} is not one`, {}, { allow: "GET, HEAD" }));
  const dir = server.console ?? CONSOLE_DIR;
  if (raw.startsWith(SHARE)) return share(req, res, raw, dir, server, held);
  if (MOVED.has(raw)) return redirect(res, `/${(req.url ?? "").slice(raw.length)}`);
  if (raw !== "/") return file(req, res, raw, dir, raw.slice(1));
  const given = launch(req, res, raw, server, raw);
  if (given === "answered") return;
  return file(req, res, raw, dir, "index.html", given === "wrong" ? 401 : 200);
}

/** The printed link's code in a page's address (`raw`: `/`, or `/share/<run>` the CLI opens). Without accounts, a right
 *  code gives this browser a console session (ConsoleSessions) and a redirect to the same page without it; "answered".
 *  The token is for scripts and the CLI: a token in the address signs nothing in, here or with an owner, and leaves it
 *  (the same address without it, no cookie). With an owner the console is the owner's session alone, so a code leaves
 *  the same way. A wrong code is "wrong" and sets nothing (the page answers 401); none is "none". `where` names the page
 *  in the failure log. */
function launch(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer, where: string): "answered" | "wrong" | "none" {
  const url = new URL(req.url ?? "/", "http://serve");
  const without = () => (url.searchParams.delete("token"), url.searchParams.delete("launch"), `${raw}${url.searchParams.size ? `?${url.searchParams}` : ""}`);
  const given = url.searchParams.get("launch");
  if (url.searchParams.has("token") || (server.owner && given !== null)) return redirect(res, without()), "answered";
  if (given === null) return "none";
  // A code holds no "+", but a space in the link is one that was not encoded all the same.
  const id = server.sessions?.open(given) ?? server.sessions?.open(given.replaceAll(" ", "+"));
  if (id !== undefined) return redirect(res, without(), { "set-cookie": `${cookieName(req)}=${id}; HttpOnly; SameSite=Strict; Path=/${overHttps(req) ? "; Secure" : ""}` }), "answered";
  server.authFailed?.(where, "wrong_launch_code");
  return "wrong";
}

/** The share preview (share.html) at /share/<run>, the owner's alone: a browser without this server's session (`held`:
 *  the owner's signed-in session with accounts, the printed link's without) gets SIGN_IN_FIRST, a 401, and so does a
 *  wrong launch code; a right one opens the session here as on `/` (launch). The page reads the run's export with that
 *  session (GET /v2/runs/<run>/export) and nothing else. Its assets are the console's, public. */
async function share(req: IncomingMessage, res: ServerResponse, raw: string, dir: string, server: PageServer, held: boolean): Promise<void> {
  const rest = raw.slice(SHARE.length);
  if (rest.startsWith("assets/")) return file(req, res, raw, dir, rest);
  if (!SHARE_RUN.test(rest)) return refuse(req, res, new ApiError("not_found", `no page ${raw}: a share preview is /share/<run id>`));
  // The CLI opens /share/<run>?launch=<code> when it knows the code: the same session as `/?launch=`, landing here.
  const given = launch(req, res, raw, server, "/share");
  if (given === "answered") return;
  if (given === "wrong" || !held) {
    if (given === "none") server.authFailed?.("/share", "no_session");
    return send(req, res, 401, HTML, SIGN_IN_FIRST);
  }
  return file(req, res, raw, dir, "share.html");
}

/** The requests the owner's password session sends from the page (a write only from this server's own origin, with a
 *  JSON body), never under an accounts-off console session. */
const ownerSessions = new WeakSet<IncomingMessage>();
/** Whether `req` came from the owner's page under their password session (answerPage). A token, whoever holds it, never
 *  did. */
export const byOwnerSession = (req: IncomingMessage): boolean => ownerSessions.has(req);
/** The requests the console sends under an accounts-off console session (ConsoleSessions: the launch link's, made at
 *  random, never from the token), held to this server's own origin and a JSON body as every page write is: a fact
 *  secret-writes.ts reads (mayWriteSecrets), never an owner. */
const consoleSessions = new WeakSet<IncomingMessage>();
/** Whether `req` came from the accounts-off console's page session (answerPage). */
export const byConsoleSession = (req: IncomingMessage): boolean => consoleSessions.has(req);

/**
 * Answers the console's paths ("/" and its /assets/*, the addresses that moved to "/", and the share preview under
 * /share/), and returns true; returns false for every other path. On a /v2 path with no Authorization header, the browser's cookie
 * becomes the Bearer header for a GET or HEAD, and for any other method only when the request's Origin is this server's
 * own origin and its body is application/json, or the request is a PUT or POST to a route that takes bytes, with any
 * content type.
 */
export function answerPage(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer): boolean {
  const held = server.owner ? signedIn(req, server.owner) : cookiesOf(req, cookieName(req)).some((value) => server.sessions?.holds(value) === true);
  if (raw.startsWith("/v2/")) {
    const safe = req.method === "GET" || req.method === "HEAD";
    const bytes = (req.method === "PUT" || req.method === "POST") && server.takesBytes?.(req.method, raw.slice(3)) === true;
    if (held && req.headers.authorization === undefined && (safe || (req.headers.origin?.toLowerCase() === ownOrigin(req) && (isJson(req) || bytes)))) {
      req.headers.authorization = `Bearer ${server.token}`;
      // The owner's password session (accounts on), never a cookie a token mints: what approving a note asks for, and
      // what capabilities read to say whether this caller may (byOwnerSession).
      if (server.owner) ownerSessions.add(req);
      else consoleSessions.add(req);
    }
    return false;
  }
  if (raw !== "/" && !raw.startsWith("/assets/") && !MOVED.has(raw) && !raw.startsWith(SHARE)) return false;
  // Every page answer (the console, its assets, its redirects) at an https public address: HSTS.
  for (const [name, value] of Object.entries(hstsHeaders(server.publicUrl))) res.setHeader(name, value);
  answer(req, res, raw, server, held).catch(() => {
    if (!res.headersSent) refuse(req, res, new ApiError("internal", "the console could not be read"));
    else res.destroy();
  });
  return true;
}
