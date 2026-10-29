// The page at "/": the console (apps/console, built into dist/console by scripts/copy-page.mjs), a static app that
// reads this server's /v2. A browser holds the owner's session cookie (owner.ts), or the server's token as a cookie that
// the printed link sets once; either stands in for the Bearer header on /v2, and for a write only from the page's own
// origin with a JSON body. The console's code is public: it carries no data, no token and no address, and asks /v2 for
// everything, the owner's session included (GET /v2/auth/session), so it shows setup, sign-in or the console itself.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Owner } from "./owner.js";
import { ApiError } from "./errors.js";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const HTML = "text/html; charset=utf-8";
/** The console's build: index.html and assets/, beside the server. */
export const CONSOLE_DIR = fileURLToPath(new URL("./console/", import.meta.url));
/** What a server whose build has no console answers at its pages: plain, no script, under the same CSP. */
const NO_CONSOLE = `<!doctype html><meta charset="utf-8"><title>AgentRun Server</title><p>This server was built without its console. The API is at /v2.</p>\n`;
/** The types of the console's files, by extension. Anything else is not served. */
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const read = new Map<string, Promise<Buffer>>();
const bytesOf = (path: string) => {
  let bytes = read.get(path);
  if (!bytes) {
    read.set(path, (bytes = readFile(path)));
    // A file that is not there is read again next time: a build can land under a running server.
    bytes.catch(() => read.delete(path));
  }
  return bytes;
};

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
  send(req, res, error.status, "application/json", JSON.stringify(error.body(String(res.getHeader("x-request-id") ?? ""))), { "cache-control": "no-store", ...error.headers });

type PageServer = { token: string; dir: string; authFailed?: (route: string, reason: string) => void; owner?: Owner; consoleDir?: string };

/** The console's own file for a request path under /assets/, or undefined: the name decoded once, inside the console's
 *  assets directory only (no "..", no backslash, no NUL), with a type the console serves. */
function assetOf(raw: string, dir: string): { path: string; type: string } | undefined {
  let name: string;
  try {
    name = decodeURIComponent(raw.slice("/assets/".length));
  } catch {
    return undefined;
  }
  if (!name || name.includes("..") || name.includes("\0") || name.includes("\\")) return undefined;
  const base = join(dir, "assets");
  const path = normalize(join(base, name));
  const type = TYPES[extname(path).toLowerCase()];
  return path.startsWith(base + sep) && type ? { path, type } : undefined;
}

async function answer(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(req, res, new ApiError("method_not_allowed", `the page answers GET and HEAD; ${req.method} is not one`, {}, { allow: "GET, HEAD" }));
  const dir = server.consoleDir ?? CONSOLE_DIR;
  if (raw.startsWith("/assets/")) {
    const asset = assetOf(raw, dir);
    const bytes = asset ? await bytesOf(asset.path).catch(() => undefined) : undefined;
    if (!asset || !bytes) return refuse(req, res, new ApiError("not_found", `no file ${raw}`));
    // Hashed names: a file's content never changes under its name, so it may be kept.
    return send(req, res, 200, asset.type, bytes, { "cache-control": "public, max-age=31536000, immutable" });
  }
  const url = new URL(req.url ?? "/", "http://serve");
  const given = url.searchParams.get("token");
  // Without accounts, the printed link sets the token's cookie once and drops the token from the address. With an
  // owner the token's link signs no browser in: the page is the owner's session alone, so nothing outlives a sign-out.
  if (given !== null && !server.owner && (same(given, server.token) || same(given.replaceAll(" ", "+"), server.token))) {
    url.searchParams.delete("token");
    const rest = url.searchParams.toString();
    const cookie = `${cookieName(req)}=${sessionOf(server.token)}; HttpOnly; SameSite=Strict; Path=/${overHttps(req) ? "; Secure" : ""}`;
    res.writeHead(303, { ...SECURITY, "cache-control": "no-store", location: `${raw}${rest ? `?${rest}` : ""}`, "set-cookie": cookie, "content-length": 0 });
    return void res.end();
  }
  if (given !== null) server.authFailed?.(raw, "wrong_link_token");
  const index = await bytesOf(join(dir, "index.html")).catch(() => undefined);
  return send(req, res, 200, HTML, index ?? NO_CONSOLE, { "cache-control": "no-store" });
}

/** A path the console answers with its index.html: one with no extension (a route of the console), never the API's. */
const consolePath = (raw: string) => raw !== "/v2" && !raw.startsWith("/v2/") && raw !== "/api" && !raw.startsWith("/api/") && !extname(raw);

/**
 * Answers the console's paths ("/", any path with no extension, and /assets/*) and returns true; returns false for
 * every other path, so the API's own routes (and their JSON errors) answer it: an unknown /v2 path, /api/*, and a file
 * the console does not have are never the page. On a /v2 path with no Authorization header, the page's cookie becomes
 * the Bearer header for a GET or HEAD, and for any other method only when the request's Origin is the page's own origin
 * and its body is application/json.
 */
export function answerPage(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer): boolean {
  const held = server.owner ? signedIn(req, server.owner) : cookiesOf(req, cookieName(req)).some((value) => same(value, sessionOf(server.token)));
  if (raw.startsWith("/v2/")) {
    const safe = req.method === "GET" || req.method === "HEAD";
    if (held && req.headers.authorization === undefined && (safe || (req.headers.origin?.toLowerCase() === ownOrigin(req) && isJson(req)))) req.headers.authorization = `Bearer ${server.token}`;
    return false;
  }
  if (!raw.startsWith("/assets/") && !consolePath(raw)) return false;
  answer(req, res, raw, server).catch(() => {
    if (!res.headersSent) refuse(req, res, new ApiError("internal", "the page could not be read"));
    else res.destroy();
  });
  return true;
}
