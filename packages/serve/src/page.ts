// The page at "/": pi-durable-agent's store page over the agent store in the data directory, with this package's
// serve.js and serve.css beside it. A browser holds the server's token as a cookie that the printed link sets once; the
// cookie stands in for the Bearer header on /v2, and for a write only from the page's own origin with a JSON body.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
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
};
const PAGE = own("index.html", HTML);
const LOCKED = own("locked.html", HTML);
/** With accounts: the setup and sign-in pages, each with its own script, public like the page's files. */
const ACCOUNT_FILES: Record<string, { path: string; type: string }> = {
  "/account.css": own("account.css", "text/css; charset=utf-8"),
  "/setup.js": own("setup.js", "text/javascript; charset=utf-8"),
  "/sign-in.js": own("sign-in.js", "text/javascript; charset=utf-8"),
};
const SETUP = own("setup.html", HTML);
const SIGN_IN = own("sign-in.html", HTML);

/** With accounts: the origin a cookie's write must come from, whether there is an owner yet, and whether the request's
 *  session cookie signs someone in. */
export type PageAccounts = { isOrigin(origin: string | undefined): boolean; hasOwner(): boolean; signedIn(req: IncomingMessage, res: ServerResponse): Promise<boolean> };

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
const overHttps = (req: IncomingMessage) => String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim().toLowerCase() === "https";
const ownOrigin = (req: IncomingMessage) => `${overHttps(req) ? "https" : "http"}://${String(req.headers.host ?? "").toLowerCase()}`;
const isJson = (req: IncomingMessage) => String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";

function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: Buffer | string, headers: Record<string, string> = {}): void {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { ...SECURITY, "content-type": type, "content-length": bytes.length, ...headers });
  res.end(req.method === "HEAD" ? undefined : bytes);
}
const refuse = (req: IncomingMessage, res: ServerResponse, error: ApiError) =>
  send(req, res, error.status, "application/json", JSON.stringify(error.body(String(res.getHeader("x-request-id") ?? ""))), error.headers);

type PageServer = { token: string; dir: string; authFailed?: (route: string, reason: string) => void; accounts?: PageAccounts };

const redirect = (res: ServerResponse, location: string) => (res.writeHead(303, { ...SECURITY, location, "content-length": 0 }), void res.end());

async function answer(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer, held: boolean): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(req, res, new ApiError("method_not_allowed", `the page answers GET and HEAD; ${req.method} is not one`, {}, { allow: "GET, HEAD" }));
  const accounts = server.accounts;
  const file = FILES[raw] ?? (accounts ? ACCOUNT_FILES[raw] : undefined);
  if (file) return send(req, res, 200, file.type, await bytesOf(file.path));
  if (accounts && raw === "/setup") return accounts.hasOwner() ? redirect(res, "/sign-in") : send(req, res, 200, HTML, await bytesOf(SETUP.path));
  if (accounts && raw === "/sign-in") return accounts.hasOwner() ? send(req, res, 200, HTML, await bytesOf(SIGN_IN.path)) : redirect(res, "/setup");
  if (accounts && !held) held = await accounts.signedIn(req, res);
  const url = new URL(req.url ?? "/", "http://serve");
  if (raw.startsWith("/api/")) {
    if (!held && !same(String(req.headers.authorization ?? ""), `Bearer ${server.token}`)) {
      server.authFailed?.(raw, req.headers.authorization === undefined ? "no_credential" : "wrong_token");
      return refuse(req, res, new ApiError("unauthenticated", "the page's data needs the cookie the printed link sets, or Authorization: Bearer <the token>"));
    }
    const { status, value } = await storeApi({ dir: server.dir })(url.pathname, url.searchParams);
    return send(req, res, status, "application/json; charset=utf-8", JSON.stringify(value));
  }
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
  if (!held || given !== null) return send(req, res, 401, HTML, await bytesOf((accounts ? (accounts.hasOwner() ? SIGN_IN : SETUP) : LOCKED).path));
  return send(req, res, 200, HTML, await bytesOf(PAGE.path));
}

/**
 * Answers the page's paths ("/", its files and its /api/*) and returns true; returns false for every other path. On a
 * /v2 path with no Authorization header, the page's cookie becomes the Bearer header for a GET or HEAD, and for any other
 * method only when the request's Origin is the page's own origin and its body is application/json.
 */
export function answerPage(req: IncomingMessage, res: ServerResponse, raw: string, server: PageServer): boolean {
  const held = cookiesOf(req, cookieName(req)).some((value) => same(value, sessionOf(server.token)));
  if (raw.startsWith("/v2/")) {
    const safe = req.method === "GET" || req.method === "HEAD";
    // With accounts the page's origins are the ones the server was started with, never one the request names.
    const fromPage = server.accounts ? server.accounts.isOrigin(req.headers.origin?.toLowerCase()) : req.headers.origin?.toLowerCase() === ownOrigin(req);
    if (held && req.headers.authorization === undefined && (safe || (fromPage && isJson(req)))) req.headers.authorization = `Bearer ${server.token}`;
    return false;
  }
  const accountPage = server.accounts && (raw === "/setup" || raw === "/sign-in" || Boolean(ACCOUNT_FILES[raw]));
  if (raw !== "/" && !FILES[raw] && !raw.startsWith("/api/") && !accountPage) return false;
  answer(req, res, raw, server, held).catch(() => {
    if (!res.headersSent) refuse(req, res, new ApiError("internal", "the page could not be read"));
    else res.destroy();
  });
  return true;
}
