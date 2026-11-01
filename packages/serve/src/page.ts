// The console at "/" (apps/console, which this package's build copies into dist/console): its index.html and Vite's
// hashed assets under /assets/, public, under one strict CSP. The console signs a person in itself. With accounts it
// takes the owner's session cookie (owner.ts); without, the server's token as a cookie that the printed link (`/?token=`)
// sets once. Either stands in for the Bearer header on /v2, and for a write only from this origin with a JSON body. The
// store's read-only JSON (/api/*, pi-durable-agent's store page's data) answers the Bearer token or either cookie.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import type { Owner } from "./owner.js";
import { fileURLToPath } from "node:url";
import { storeApi } from "@parcha/pi-durable-agent/serve";
import { ApiError } from "./errors.js";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
const HTML = "text/html; charset=utf-8";
/** The console's build, beside the server. */
const CONSOLE_DIR = fileURLToPath(new URL("./console/", import.meta.url));
/** The kinds of file Vite builds the console into; any other is not served. */
const CONSOLE_TYPES: Record<string, string> = { ".html": HTML, ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff" };
/** A segment of an asset's path as sent: no dot segment, no hidden file, no percent-encoding, no separator. */
const CONSOLE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** Addresses the console had before it took "/", and the old page's setup and sign-in, which the printed setup link
 *  still names: each sends the browser to "/", which keeps the link's #code. */
const MOVED = new Set(["/console", "/console/", "/setup", "/sign-in"]);

const digest = (text: string) => createHash("sha256").update(text).digest();
const same = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));
/** The cookie's value: a MAC of the token, so the cookie is never the API key itself. */
const sessionOf = (token: string) => createHmac("sha256", token).update("agentrun-serve page").digest("base64url");
/** One name per port: cookies are kept per host, not per port, and another server on this machine has another token. */
const cookieName = (req: IncomingMessage) => `agentrun-${req.socket.localPort}`;
const cookiesOf = (req: IncomingMessage, name: string) =>
  String(req.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
export const overHttps = (req: IncomingMessage) => String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase() === "https";
export const ownOrigin = (req: IncomingMessage) => `${overHttps(req) ? "https" : "http"}://${String(req.headers.host ?? "").toLowerCase()}`;
export const isJson = (req: IncomingMessage) => String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";

/** The owner's session cookie: `__Host-` on https, so no other host or path can set it; else one per port. */
export const ownerCookieName = (req: IncomingMessage) => (overHttps(req) ? "__Host-agentrun-session" : `agentrun-${req.socket.localPort}-session`);
/** A Set-Cookie line for the owner's session: `value`, or an empty one that ends it (`maxAgeS` 0). */
export const ownerCookie = (req: IncomingMessage, value: string, maxAgeS: number) =>
  `${ownerCookieName(req)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${overHttps(req) ? "; Secure" : ""}`;
/** Whether the request holds a session the owner signed in. */
export const signedIn = (req: IncomingMessage, owner: Owner) => cookiesOf(req, ownerCookieName(req)).some((value) => owner.valid(value));

function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: Buffer | string, headers: Record<string, string> = {}): void {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { ...SECURITY, "content-type": type, "content-length": bytes.length, ...headers });
  res.end(req.method === "HEAD" ? undefined : bytes);
}
const refuse = (req: IncomingMessage, res: ServerResponse, error: ApiError) =>
  send(req, res, error.status, "application/json", JSON.stringify(error.body(String(res.getHeader("x-request-id") ?? ""))), error.headers);

type PageServer = { token: string; dir: string; authFailed?: (route: string, reason: string) => void; owner?: Owner; console?: string | undefined };

const redirect = (res: ServerResponse, location: string, headers: Record<string, string> = {}) => (res.writeHead(303, { ...SECURITY, location, "content-length": 0, ...headers }), void res.end());

/** A file of the console: a known type inside `dir`, read through no link that leaves it. Vite's hashed assets are cached
 *  for a year; index.html is no-store. */
async function file(req: IncomingMessage, res: ServerResponse, raw: string, dir: string, rel: string, status = 200): Promise<void> {
  const missing = () => refuse(req, res, new ApiError("not_found", `no file ${raw} in the console`));
  const type = CONSOLE_TYPES[extname(rel).toLowerCase()];
  if (!type || !rel.split("/").every((segment) => CONSOLE_SEGMENT.test(segment))) return missing();
  const [root, real] = await Promise.all([realpath(dir).catch(() => null), realpath(join(dir, rel)).catch(() => null)]);
  if (!root || !real) {
    return rel === "index.html" ? send(req, res, 404, "text/plain; charset=utf-8", "This server was built without its console: build apps/console, then rebuild the server.\n") : missing();
  }
  if (!real.startsWith(root + sep) || !(await stat(real)).isFile()) return missing();
  send(req, res, status, type, await readFile(real), { "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store" });
}

async function answer(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer, held: boolean): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(req, res, new ApiError("method_not_allowed", `the console answers GET and HEAD; ${req.method} is not one`, {}, { allow: "GET, HEAD" }));
  if (raw.startsWith("/api/")) {
    if (!held && !same(String(req.headers.authorization ?? ""), `Bearer ${server.token}`)) {
      server.authFailed?.(raw, req.headers.authorization === undefined ? "no_credential" : "wrong_token");
      return refuse(req, res, new ApiError("unauthenticated", "the page's data needs the cookie the printed link sets, or Authorization: Bearer <the token>"));
    }
    const url = new URL(req.url ?? "/", "http://serve");
    const { status, value } = await storeApi({ dir: server.dir })(url.pathname, url.searchParams);
    return send(req, res, status, "application/json; charset=utf-8", JSON.stringify(value));
  }
  const dir = server.console ?? CONSOLE_DIR;
  if (MOVED.has(raw)) return redirect(res, `/${(req.url ?? "").slice(raw.length)}`);
  if (raw !== "/") return file(req, res, raw, dir, raw.slice(1));
  // Without accounts, the printed link's token becomes this browser's cookie once. With an owner the console is the
  // owner's session alone: the token is for scripts and the CLI, and its link signs no browser in.
  const url = new URL(req.url ?? "/", "http://serve");
  const given = server.owner ? null : url.searchParams.get("token");
  // A token holds no whitespace, so a space in the link is a "+" that was not encoded.
  if (given !== null && (same(given, server.token) || same(given.replaceAll(" ", "+"), server.token))) {
    url.searchParams.delete("token");
    const rest = url.searchParams.toString();
    return redirect(res, `/${rest ? `?${rest}` : ""}`, { "set-cookie": `${cookieName(req)}=${sessionOf(server.token)}; HttpOnly; SameSite=Strict; Path=/${overHttps(req) ? "; Secure" : ""}` });
  }
  if (given !== null) server.authFailed?.(raw, "wrong_link_token");
  return file(req, res, raw, dir, "index.html", given === null ? 200 : 401);
}

/**
 * Answers the console's paths ("/" and its /assets/*, and the addresses that moved to "/") and the store's /api/*, and
 * returns true; returns false for every other path. On a /v2 path with no Authorization header, the browser's cookie
 * becomes the Bearer header for a GET or HEAD, and for any other method only when the request's Origin is this server's
 * own origin and its body is application/json.
 */
export function answerPage(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer): boolean {
  const held = server.owner ? signedIn(req, server.owner) : cookiesOf(req, cookieName(req)).some((value) => same(value, sessionOf(server.token)));
  if (raw.startsWith("/v2/")) {
    const safe = req.method === "GET" || req.method === "HEAD";
    if (held && req.headers.authorization === undefined && (safe || (req.headers.origin?.toLowerCase() === ownOrigin(req) && isJson(req)))) req.headers.authorization = `Bearer ${server.token}`;
    return false;
  }
  if (raw !== "/" && !raw.startsWith("/assets/") && !raw.startsWith("/api/") && !MOVED.has(raw)) return false;
  answer(req, res, raw, server, held).catch(() => {
    if (!res.headersSent) refuse(req, res, new ApiError("internal", "the console could not be read"));
    else res.destroy();
  });
  return true;
}
