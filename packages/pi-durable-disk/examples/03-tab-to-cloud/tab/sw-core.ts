// The service worker's answer to one request, with its dependencies passed in so Node can test both paths (sw.ts wires the real cache and fetch). Portable: no DOM API.
//   - A model chunk of a cached run (`/api/runs/<id>/work/home/model/...`) is immutable and was checked against the manifest's sha256 when it was cached: cache first.
//   - Everything else (the page, its script, the wasm, any other page on this origin) goes to the network first, with a short timeout, and falls back to the cache only when the
//     network is not there or too slow. A network answer is passed through untouched and never stored, so a page the checkout did not cache stays whatever the server says.
import { cacheKey, isolated } from "./offline-cache.ts";

/** The part of a Cache the worker reads. */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
}

/** What the worker has learned about the network: when it last gave nothing in time. Shared by the worker's requests (one object for its lifetime). */
export interface NetworkState {
  downUntil: number;
}

export interface ServeDeps {
  cache: CacheLike;
  fetch(request: Request, signal: AbortSignal): Promise<Response>;
  /** How long the network gets before the cache answers instead. */
  timeoutMs: number;
  /** After the network gave nothing in time, requests the cache holds go to the cache at once for this long (a page is dozens of requests; each waiting the full timeout on a tunnel that accepts and never answers would take a minute). Default 30 s. */
  downMs?: number;
  state?: NetworkState;
  now?(): number;
}

/** A model chunk (or the manifest) of a run's disk, as the page asks for it. */
const IMMUTABLE = /^\/api\/runs\/[^/]+\/work\/home\/model\//;

export const isImmutable = (url: string | URL): boolean => IMMUTABLE.test(new URL(url).pathname);

const unavailable = () => new Response("not available: this run is checked out to this browser and this file was not cached", { status: 504, headers: { "content-type": "text/plain" } });

export async function serve(request: Request, deps: ServeDeps): Promise<Response> {
  const key = cacheKey(request.url);
  const cached = async () => {
    const hit = await deps.cache.match(key);
    return hit ? isolated(hit) : undefined;
  };
  if (isImmutable(request.url)) {
    const hit = await cached();
    if (hit) return hit;
    try {
      return await deps.fetch(request, new AbortController().signal);
    } catch {
      return unavailable();
    }
  }
  const now = deps.now ?? Date.now;
  // The network was found down a moment ago: what the cache holds is answered from it at once; anything else still gets its try.
  if (deps.state && now() < deps.state.downUntil) {
    const hit = await cached();
    if (hit) return hit;
  }
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("the network is too slow")), deps.timeoutMs)));
    return await Promise.race([deps.fetch(request, stop.signal), timeout]);
  } catch {
    stop.abort(); // the network gave nothing in time: the cache answers, and the request is dropped
    if (deps.state) deps.state.downUntil = now() + (deps.downMs ?? 30_000);
    return (await cached()) ?? unavailable();
  } finally {
    clearTimeout(timer);
  }
}
