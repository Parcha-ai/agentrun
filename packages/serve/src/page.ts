// The page at "/": pi-durable-agent's store page over the agent store in the data directory, with this package's
// serve.js and serve.css beside it. A browser holds the owner's session cookie (owner.ts), or the server's token as a
// cookie that the printed link sets once; either stands in for the Bearer header on /v2, and for a write only from the
// page's own origin with a JSON body. With accounts, a browser holding neither gets the setup page (no password yet) or
// the sign-in page.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Owner } from "./owner.js";
import { fileURLToPath } from "node:url";
import { STORE_PAGE_FILES, storeApi } from "@parcha/pi-durable-agent/serve";
import { ApiError } from "./errors.js";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
const HTML = "text/html; charset=utf-8";
const own = (file: string, type: string) => ({ path: fileURLToPath(new URL(`./page/${file}`, import.meta.url)), type });
/** The page's files, public: code and styles, no data. */
const FILES: Record<string, { path: string; type: string }> = {
  "/page.css": STORE_PAGE_FILES["/page.css"]!,
  "/page.js": STORE_PAGE_FILES["/page.js"]!,
  "/graph.js": STORE_PAGE_FILES["/graph.js"]!,
  "/serve.css": own("serve.css", "text/css; charset=utf-8"),
  "/serve.js": own("serve.js", "text/javascript; charset=utf-8"),
  "/account.js": own("account.js", "text/javascript; charset=utf-8"),
};
const PAGE = own("index.html", HTML);
const LOCKED = own("locked.html", HTML);
/** With accounts: the setup and sign-in pages' styles, public like the page's files. */
const ACCOUNT_FILES: Record<string, { path: string; type: string }> = {
  "/account.css": own("account.css", "text/css; charset=utf-8"),
};
const SETUP = own("setup.html", HTML);
const SIGN_IN = own("sign-in.html", HTML);

const read = new Map<string, Promise<Buffer>>();
const bytesOf = (path: string) => {
  let bytes = read.get(path);
  if (!bytes) read.set(path, (bytes = readFile(path)));
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
  send(req, res, error.status, "application/json", JSON.stringify(error.body(String(res.getHeader("x-request-id") ?? ""))), error.headers);

type PageServer = { token: string; dir: string; authFailed?: (route: string, reason: string) => void; owner?: Owner };

const redirect = (res: ServerResponse, location: string) => (res.writeHead(303, { ...SECURITY, location, "content-length": 0 }), void res.end());

async function answer(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer, held: boolean): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(req, res, new ApiError("method_not_allowed", `the page answers GET and HEAD; ${req.method} is not one`, {}, { allow: "GET, HEAD" }));
  const owner = server.owner;
  const file = FILES[raw] ?? (owner ? ACCOUNT_FILES[raw] : undefined);
  if (file) return send(req, res, 200, file.type, await bytesOf(file.path));
  if (owner && raw === "/setup") return owner.hasPassword() ? redirect(res, "/sign-in") : send(req, res, 200, HTML, await bytesOf(SETUP.path));
  if (owner && raw === "/sign-in") return owner.hasPassword() ? send(req, res, 200, HTML, await bytesOf(SIGN_IN.path)) : redirect(res, "/setup");
  const url = new URL(req.url ?? "/", "http://serve");
  if (raw.startsWith("/api/")) {
    if (!held && !same(String(req.headers.authorization ?? ""), `Bearer ${server.token}`)) {
      server.authFailed?.(raw, req.headers.authorization === undefined ? "no_credential" : "wrong_token");
      return refuse(req, res, new ApiError("unauthenticated", "the page's data needs the cookie the printed link sets, or Authorization: Bearer <the token>"));
    }
    const { status, value } = await storeApi({ dir: server.dir })(url.pathname, url.searchParams);
    return send(req, res, status, "application/json; charset=utf-8", JSON.stringify(value));
  }
  // With an owner the page is the owner's session alone: the token is for scripts and the CLI, and its link signs no
  // browser in, so nothing outlives a sign-out.
  if (owner) return held ? send(req, res, 200, HTML, await bytesOf(PAGE.path)) : redirect(res, owner.hasPassword() ? "/sign-in" : "/setup");
  const given = url.searchParams.get("token");
  // A token holds no whitespace, so a space in the link is a "+" that was not encoded.
  if (given !== null && (same(given, server.token) || same(given.replaceAll(" ", "+"), server.token))) {
    url.searchParams.delete("token");
    const rest = url.searchParams.toString();
    const cookie = `${cookieName(req)}=${sessionOf(server.token)}; HttpOnly; SameSite=Strict; Path=/${overHttps(req) ? "; Secure" : ""}`;
    res.writeHead(303, { ...SECURITY, location: `${raw}${rest ? `?${rest}` : ""}`, "set-cookie": cookie, "content-length": 0 });
    return void res.end();
  }
  if (given !== null) server.authFailed?.(raw, "wrong_link_token");
  if (!held || given !== null) return send(req, res, 401, HTML, await bytesOf(LOCKED.path));
  return send(req, res, 200, HTML, await bytesOf(PAGE.path));
}

/**
 * Answers the page's paths ("/", its files and its /api/*) and returns true; returns false for every other path. On a
 * /v2 path with no Authorization header, the page's cookie becomes the Bearer header for a GET or HEAD, and for any other
 * method only when the request's Origin is the page's own origin and its body is application/json.
 */
export function answerPage(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer): boolean {
  const held = server.owner ? signedIn(req, server.owner) : cookiesOf(req, cookieName(req)).some((value) => same(value, sessionOf(server.token)));
  if (raw.startsWith("/v2/")) {
    const safe = req.method === "GET" || req.method === "HEAD";
    if (held && req.headers.authorization === undefined && (safe || (req.headers.origin?.toLowerCase() === ownOrigin(req) && isJson(req)))) req.headers.authorization = `Bearer ${server.token}`;
    return false;
  }
  const accountPage = server.owner !== undefined && (raw === "/setup" || raw === "/sign-in" || Boolean(ACCOUNT_FILES[raw]));
  if (raw !== "/" && !FILES[raw] && !accountPage && !raw.startsWith("/api/")) return false;
  answer(req, res, raw, server, held).catch(() => {
    if (!res.headersSent) refuse(req, res, new ApiError("internal", "the page could not be read"));
    else res.destroy();
  });
  return true;
}
