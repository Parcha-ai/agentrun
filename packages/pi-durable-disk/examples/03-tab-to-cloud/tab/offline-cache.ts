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
