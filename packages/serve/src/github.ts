// GitHub's API as this server calls it for its one GitHub App (github-connection.ts): the App's JWT, which GitHub takes
// for the App's own endpoints (its installations, and later an installation's token), and one JSON request with a
// bounded wait. The API's base is given, so a test points it at a GitHub of its own.
import { createSign } from "node:crypto";

/** GitHub's REST API, and its site, where a person makes and installs an App. */
export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
/** How long a call to GitHub may take, whole. */
const GITHUB_MS = 15_000;

const base64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** The App's JWT (GitHub's "Generating a JSON Web Token for a GitHub App"): RS256 under its private key, `iss` its id,
 *  `iat` a minute back for clock drift, `exp` nine minutes on (GitHub takes ten at most). */
export function appJwt(appId: string, pem: string, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const signed = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }))}`;
  return `${signed}.${createSign("RSA-SHA256").update(signed).sign(pem, "base64url")}`;
}

/** One call to GitHub's API at `api`: its status and its JSON (null when it answers none). A network failure or a wait
 *  past GITHUB_MS throws, saying which; what GitHub answered is the caller's to word, never passed on as it is. */
export async function githubCall(api: string, path: string, options: { method?: "GET" | "POST"; jwt?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<{ status: number; json: unknown }> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(GITHUB_MS)]) : AbortSignal.timeout(GITHUB_MS);
  let res: Response;
  try {
    res = await fetch(`${api.replace(/\/+$/, "")}${path}`, {
      method: options.method ?? "GET",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agentrun-serve", ...(options.jwt ? { authorization: `Bearer ${options.jwt}` } : {}), ...(options.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal,
    });
  } catch (error) {
    throw new Error(`GitHub could not be reached (${(error as Error).name === "TimeoutError" ? `no answer in ${GITHUB_MS / 1000} s` : (error as Error).message})`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}
