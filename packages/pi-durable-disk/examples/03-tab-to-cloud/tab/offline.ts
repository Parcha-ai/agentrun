// Taking a run offline: the page's side. The run's page, assets and model go into the cache the service worker answers from (sw.ts), a consistent copy of
// the run's store comes from the pipe into this browser's OPFS (local-store.ts), and the pipe is asked to hand the run over (a checkout: the claim is released
// only when the copy's head is the store's head). The record of what was checked out lives in OPFS too, so a reload knows. Browser only.
import { parseManifest } from "../../04-walks-home/tab/src/model.ts";
import { CACHE_NAME, cacheKey } from "./offline-cache.ts";

/** What does not work while the run is checked out to this browser. Shown in the page's checked-out panel and written in the PR and the README, word for word. */
export const CANNOT_OFFLINE: readonly string[] = [
  "Moves: the switcher, the agent's switch_environment tool and the cloud and sandbox targets need the server and the disk.",
  "Jev and the safety check: off in this mode, by decision. Nothing judges an answer.",
  "Viewers and operators: they follow the run through the server, which no longer runs it. They are told it is checked out to a browser.",
  "Cloud models: only the model on this page answers. The checkout needs the agent to be on it already.",
  "The computer (bash, node): it is not started. The model's conversation has no tools.",
  "Sync back: none. The checkout is one way, and this browser's copy is the only live one.",
];

export interface CheckoutRecord {
  run: string;
  /** `copied`: the copy is in OPFS and the pipe was asked; `done`: the pipe answered that the claim is released. */
  state: "copied" | "done";
  /** The head of the store the pipe released, and the copy's. */
  head: number;
  /** The agent's model id on the run (the cloud model), for the root conversation. */
  model: string;
  /** The conversation on the trained model (its id as pi-durable made it). */
  conversation: number | undefined;
  tab: string;
  at: number;
  manifestSha: string;
  chunks: number;
  bytes: number;
  /** The browser promised to keep this site's storage (navigator.storage.persist): without it the copy may be removed under storage pressure. */
  persistent: boolean;
}

const recordName = (run: string) => `checkout-${run.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("walks-home", { create: true });

export async function readCheckout(run: string): Promise<CheckoutRecord | undefined> {
  try {
    const file = await (await (await dir()).getFileHandle(recordName(run))).getFile();
    return JSON.parse(await file.text()) as CheckoutRecord;
  } catch {
    return undefined;
  }
}

export async function writeCheckout(record: CheckoutRecord): Promise<void> {
  const handle = await (await dir()).getFileHandle(recordName(record.run), { create: true });
  const out = await handle.createWritable();
  await out.write(JSON.stringify(record));
  await out.close();
}

export async function forgetCheckout(run: string): Promise<void> {
  await (await dir()).removeEntry(recordName(run)).catch(() => undefined);
}

/** Register the service worker and wait until it is active. */
export async function registerOfflineWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) throw new Error("this browser has no service workers, so the run cannot be taken offline");
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!registration.active) throw new Error("the service worker did not become active");
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface CacheProgress {
  done: number;
  total: number;
  what: string;
}

/**
 * Put in the cache everything a reload of this run's page needs with no network: the page, the assets the build lists (`/offline.json`: the page's script, the wasm of
 * the model runtime and of the store, the store's worker), the model's manifest and every chunk. A chunk is checked against the manifest's sha256 before it is kept;
 * one already cached is kept as it is. Nothing is put in the cache that did not come whole.
 */
export async function cacheRunForOffline(o: { run: string; secret: string; manifestText: string; onProgress?(p: CacheProgress): void }): Promise<{ files: number; bytes: number }> {
  const manifest = parseManifest(o.manifestText);
  const cache = await caches.open(CACHE_NAME);
  const shell = ((await (await fetch("/offline.json", { cache: "no-store" })).json()) as { files: string[] }).files;
  const pages = [`/run/${encodeURIComponent(o.run)}`, ...shell];
  const total = pages.length + 1 + manifest.chunks.length;
  let done = 0;
  let bytes = 0;
  const tick = (what: string) => o.onProgress?.({ done: ++done, total, what });
  for (const path of pages) {
    const r = await fetch(path, { cache: "reload" });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    bytes += Number(r.headers.get("content-length") ?? 0);
    await cache.put(cacheKey(new URL(path, location.origin)), r);
    tick(path);
  }
  const work = (path: string) => `${location.origin}/api/runs/${encodeURIComponent(o.run)}/work/${path}`;
  await cache.put(cacheKey(work("home/model/manifest.json")), new Response(o.manifestText, { headers: { "content-type": "application/octet-stream" } }));
  tick("the model's manifest");
  for (const chunk of manifest.chunks) {
    const key = cacheKey(work(chunk.path));
    // A chunk cached earlier (a checkout that failed after it) is kept only if its bytes are the manifest's: the path is fixed by the chunk's index, so another model's chunk can sit under it.
    const have = await cache.match(key);
    if (have) {
      const old = await have.arrayBuffer();
      if (old.byteLength === chunk.size && hex(await crypto.subtle.digest("SHA-256", old)) === chunk.sha256) {
        bytes += chunk.size;
        tick(chunk.path);
        continue;
      }
    }
    // `?fresh`: past the service worker's cache, which would hand back the very bytes that just failed the check (a model changed under the same chunk paths).
    const r = await fetch(`${work(chunk.path)}?fresh=${Date.now()}`, { headers: bearer(o.secret), cache: "no-store" });
    if (!r.ok) throw new Error(`${chunk.path}: ${r.status}`);
    const body = await r.arrayBuffer();
    if (body.byteLength !== chunk.size) throw new Error(`${chunk.path}: ${body.byteLength} bytes, the manifest says ${chunk.size}`);
    if (hex(await crypto.subtle.digest("SHA-256", body)) !== chunk.sha256) throw new Error(`${chunk.path}: its sha256 is not the manifest's`);
    await cache.put(key, new Response(body, { headers: { "content-type": "application/octet-stream", "content-length": String(body.byteLength) } }));
    bytes += body.byteLength;
    tick(chunk.path);
  }
  return { files: total, bytes };
}

/** A checkout the pipe refused or could not do; `code` is the pipe's (HEAD_MISMATCH, NOT_WRITER, CHECKED_OUT, ...). */
export class CheckoutError extends Error {
  readonly code: string;
  readonly head: number | undefined;
  constructor(code: string, message: string, head?: number) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
    this.head = head;
  }
}

/** A consistent copy of the run's store from the pipe (while this tab holds the run), with its head. */
export async function fetchStoreCopy(run: string, secret: string): Promise<{ bytes: Uint8Array; head: number }> {
  const r = await fetch(`/api/runs/${encodeURIComponent(run)}/store`, { headers: bearer(secret), cache: "no-store" });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new CheckoutError(body.code ?? String(r.status), body.error ?? `the pipe answered ${r.status}`);
  }
  const head = Number(r.headers.get("x-store-head"));
  if (!Number.isSafeInteger(head)) throw new CheckoutError("NO_HEAD", "the pipe sent a copy with no head");
  return { bytes: new Uint8Array(await r.arrayBuffer()), head };
}

/** Ask the pipe to hand the run over. Resolves with the head it released; the answer comes after the claim is released. */
export async function requestCheckout(o: { run: string; secret: string; tab: string; head: number; conversation: number | undefined }): Promise<number> {
  const r = await fetch(`/api/runs/${encodeURIComponent(o.run)}/checkout`, {
    method: "POST",
    headers: { ...bearer(o.secret), "x-pda-tab": o.tab, "content-type": "application/json" },
    body: JSON.stringify({ head: o.head, ...(o.conversation === undefined ? {} : { conversation: o.conversation }) }),
  });
  const body = (await r.json().catch(() => ({}))) as { head?: number; error?: string; code?: string };
  if (!r.ok) throw new CheckoutError(body.code ?? String(r.status), body.error ?? `the pipe answered ${r.status}`, body.head);
  return Number(body.head);
}

/** How a checkout ended, as far as the tab can know: the pipe handed the run over, refused (it answered, and nothing was released), or never answered (it may or may not have). */
export type HandoverOutcome = { state: "done"; head: number } | { state: "refused"; error: CheckoutError } | { state: "unknown"; error: Error };

/**
 * Ask for the handover, and when the answer does not come (a network error, not a refusal) ask again: the pipe answers a retry of a checkout it did make as the first time
 * (same tab, same head), so a lost answer is recovered, never guessed. An answer from the pipe, whatever it says, ends the asking.
 */
export async function confirmHandover(attempt: () => Promise<number>, o: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<HandoverOutcome> {
  const tries = o.tries ?? 5;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: Error = new Error("no answer");
  for (let i = 0; i < tries; i++) {
    try {
      return { state: "done", head: await attempt() };
    } catch (error) {
      if (error instanceof CheckoutError) return { state: "refused", error };
      last = error as Error;
      if (i < tries - 1) await sleep(o.delayMs ?? 1_000);
    }
  }
  return { state: "unknown", error: last };
}
