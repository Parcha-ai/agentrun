// The service worker of a run checked out to this browser. The page registers it when the run is checked out (not before: an online run is untouched by it) and
// puts the run's page, its assets and its model chunks in the cache (offline.ts). From then on a request the cache holds is answered from it, whether or not the
// network is there, and every answer carries the cross-origin isolation headers, so a reload with no network comes back isolated and the model loads with its threads.
// A request the cache does not hold goes to the network, with the same headers on the answer; with no network it is a 504 that says so.
import { cacheKey, CACHE_NAME, isolated } from "./offline-cache.ts";

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

async function serve(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(cacheKey(request.url));
  if (hit) return isolated(hit);
  try {
    return isolated(await fetch(request));
  } catch {
    return new Response("not available: this run is checked out to this browser and this file was not cached", { status: 504, headers: { "content-type": "text/plain" } });
  }
}

scope.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only this site's GETs; the worker's own script is left to the browser, so an update can arrive when there is a network.
  if (request.method !== "GET" || url.origin !== scope.location.origin || url.pathname === "/sw.js") return;
  event.respondWith(serve(request));
});
