// What the page and its service worker agree on: the cache, and how a request is keyed in it. Portable: no DOM API.

/** The one cache of a checked-out run's page, assets and model chunks. */
export const CACHE_NAME = "walks-home-offline-v1";

/** A request's key in the cache: its origin and path, never its query (a page opened with ?threads=6 is the same page). */
export const cacheKey = (url: string | URL): string => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

/** The headers that make a page cross-origin isolated (wllama's threads need it), set on everything the service worker answers. */
export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

/** `response` with the isolation headers set (its body and status kept). A response that cannot be rewrapped (opaque, a redirect) is returned as it is. */
export function isolated(response: Response): Response {
  if (response.type === "opaque" || response.type === "opaqueredirect" || response.status === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The stage's own files, for a stage that is served from this origin under /show/ (serve.ts --show-dir): `/show/offline.json` is `{files: ["/show/", "/show/main.js", ...]}`, the URL paths the stage
 * requests, its document's included. Absent (a 404, nothing served there) it is no files; present, every entry must be a path under /show/ with no query, no fragment and no `..`, so what a
 * stage lists can never name the run's own files or another origin. Anything else is an error: a stage that cannot be listed whole is not cached half.
 */
export async function stageFiles(fetchList: () => Promise<Response>): Promise<string[]> {
  const r = await fetchList();
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`/show/offline.json: ${r.status}`);
  const body = (await r.json().catch(() => undefined)) as { files?: unknown } | undefined;
  if (!body || !Array.isArray(body.files)) throw new Error("/show/offline.json is not {files: [...]}");
  const out: string[] = [];
  for (const f of body.files) {
    if (typeof f !== "string" || !f.startsWith("/show/") || /[?#\\]/.test(f) || f.split("/").some((part) => part === ".." || part === ".") || f.includes("//")) throw new Error(`/show/offline.json lists ${JSON.stringify(f)}: only paths under /show/ with no query, fragment or dot segments`);
    out.push(f);
  }
  return [...new Set(out)];
}
