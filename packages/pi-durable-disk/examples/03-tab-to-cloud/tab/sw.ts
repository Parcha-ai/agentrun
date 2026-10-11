// The service worker of a run checked out to this browser. The page registers it when the run is checked out (not before: an online run is untouched by it) and
// puts the run's page, its assets and its model chunks in the cache (offline.ts). The model's chunks are answered from the cache first (immutable, sha-checked); everything
// else goes to the network first and falls back to the cache when the network is down or slow (sw-core.ts), so after one checkout the other pages of this origin are unchanged
// and online. What the cache answers carries the cross-origin isolation headers, so a reload with no network comes back isolated and the model loads with its threads.
import { CACHE_NAME } from "./offline-cache.ts";
import { serve, type NetworkState } from "./sw-core.ts";

/** The part of a service worker's global scope this file uses. */
interface FetchEventLike extends Event {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
const scope = self as unknown as {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
};

scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));

/** How long the network gets before the cache answers instead. A tunnel's closed localhost port refuses at once; this covers a connection that hangs. */
const NETWORK_TIMEOUT_MS = 3_000;

const network: NetworkState = { downUntil: 0 };

const answer = async (request: Request): Promise<Response> => {
  const cache = await caches.open(CACHE_NAME);
  return serve(request, { cache, state: network, fetch: (r, signal) => (r.mode === "navigate" ? fetch(r) : fetch(r, { signal })), timeoutMs: NETWORK_TIMEOUT_MS });
};

scope.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only this site's GETs; the worker's own script is left to the browser, so an update can arrive when there is a network.
  if (request.method !== "GET" || url.origin !== scope.location.origin || url.pathname === "/sw.js") return;
  event.respondWith(answer(request));
});
