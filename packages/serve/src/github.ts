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

/** An installation token of the App `appId` (its private key `pem`) for one repository: `target.installation`, or the
 *  installation GitHub says covers `target.repo` (GET /repos/{owner}/{repo}/installation, asked with the App's JWT); then
 *  POST /app/installations/{id}/access_tokens narrowed to that one repository, with the App's permissions. Pure apart
 *  from the calls to GitHub at `api`: serve's launch path mints with it today, and a runner can tomorrow; the run never
 *  sees the key. `expires_at` in ms. */
export async function mintInstallationToken(api: string, appId: string, pem: string, target: { installation?: number; repo: string }, nowMs?: number): Promise<{ ok: true; token: string; expires_at: number } | { ok: false; reason: "not_installed" | "no_repo" | "github_failed"; message: string }> {
  const [owner, name, extra] = target.repo.split("/");
  if (!owner || !name || extra !== undefined || !/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return { ok: false, reason: "no_repo", message: "No GitHub repository was named for this run: a GitHub event's run has one; another run names it in its input as https://github.com/<owner>/<repo>." };
  const notInstalled = { ok: false as const, reason: "not_installed" as const, message: `The GitHub App isn't installed on ${owner}/${name}: install it there (or add the repository to its installation), then run again.` };
  const jwt = appJwt(appId, pem, nowMs ?? Date.now());
  try {
    let installation = target.installation;
    if (installation === undefined) {
      const found = await githubCall(api, `/repos/${owner}/${name}/installation`, { jwt });
      const id = typeof found.json === "object" && found.json !== null ? (found.json as { id?: unknown }).id : undefined;
      if (found.status === 404) return notInstalled;
      if (found.status !== 200 || !Number.isSafeInteger(id)) return { ok: false, reason: "github_failed", message: `GitHub did not say which installation covers ${owner}/${name} (HTTP ${found.status}).` };
      installation = id as number;
    }
    const answer = await githubCall(api, `/app/installations/${installation}/access_tokens`, { method: "POST", jwt, body: { repositories: [name] } });
    const minted = (typeof answer.json === "object" && answer.json !== null ? answer.json : {}) as { token?: unknown; expires_at?: unknown };
    if (answer.status === 404 || answer.status === 422) return notInstalled;
    const expires = typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : NaN;
    if (answer.status !== 201 || typeof minted.token !== "string" || !Number.isFinite(expires)) return { ok: false, reason: "github_failed", message: `GitHub gave no token for ${owner}/${name} (HTTP ${answer.status}).` };
    return { ok: true, token: minted.token, expires_at: expires };
  } catch (error) {
    return { ok: false, reason: "github_failed", message: `GitHub did not give this run a token: ${(error as Error).message}.` };
  }
}
