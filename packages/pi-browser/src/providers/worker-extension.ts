// The Stagehand extension a local launched Chrome is given: a copy in the lease's private TMPDIR whose pages and worker may
// connect to nothing but the extension's own files and the browser's DevTools socket. Run code executes in that worker with
// the extension's host permissions, so the browser itself refuses what the observer can only watch. A copy, because the
// manifest is Stagehand's bytes and a directory shared by every lease cannot name this lease's socket; created before the
// browser starts, because its path decides the extension's id and so the one Origin the browser's socket is opened to.
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cdpCall } from "./cdp-call.js";
import { extensionDirectory, extensionOrigin } from "./chrome-args.js";

export const COPY = "stagehand-extension";
const LOAD_MS = 20_000;

/** `<into>/stagehand-extension`, a copy of Stagehand's extension directory. */
export async function copyExtension(into: string, source: string = extensionDirectory()): Promise<string> {
  const copy = path.join(into, COPY);
  await cp(source, copy, { recursive: true, dereference: true });
  return copy;
}

/** The policy for the extension's pages and worker: its own files, and the browser's DevTools socket by its whole URL path. A
 *  manifest that already sets one is left alone only when it is exactly this one (an earlier load of this copy wrote it and failed
 *  before the browser took it, so a retry is safe); any other is not guessed at. */
export function connectPolicy(manifest: Record<string, unknown>, devtoolsUrl: string): Record<string, unknown> {
  const socket = new URL(devtoolsUrl);
  if (socket.protocol !== "ws:" && socket.protocol !== "wss:") throw new Error("the browser's DevTools URL is not a WebSocket URL");
  const policy = { extension_pages: `script-src 'self'; object-src 'self'; connect-src 'self' ${socket.protocol}//${socket.host}${socket.pathname}` };
  if (manifest.content_security_policy === undefined) return { ...manifest, content_security_policy: policy };
  if (JSON.stringify(manifest.content_security_policy) === JSON.stringify(policy)) return manifest;
  throw new Error("Stagehand's extension manifest already sets a content security policy, so its connections cannot be limited");
}

/** The id Chrome gives the unpacked extension at `copy`: the Origin the browser's socket was opened to, without its scheme. */
export const copyId = (copy: string): string => extensionOrigin(copy).slice("chrome-extension://".length);

/** The permissions a locked copy's manifest drops: Stagehand's worker never uses them, and `scripting` would let code run in
 *  the worker (a model's run code) script any tab. */
export const LOCKED_PERMISSIONS: readonly string[] = ["scripting"];
/** The one offscreen document Stagehand's worker makes: its heartbeat page (STAGEHAND_SERVICE_WORKER_HEARTBEAT_PATH). */
export const HEARTBEAT = "offscreen/service-worker-heartbeat.html";
/** What a locked copy's worker runs first, before any of its code or code it is given: the extension APIs that would let
 *  run code go around a DevTools guard are replaced by the few calls Stagehand's worker makes (its heartbeat, its tab
 *  focus), each held to what it uses. Gone: opening, moving or scripting a tab or a window (on any URL, a file:// one
 *  among them; every extension may, with no permission), driving a tab over the debugger API, moving one of its own
 *  pages (the worker's clients), an offscreen document but the heartbeat (a fresh extension context), and every other
 *  API that opens or captures a page. The originals stay in this closure alone; each replaced property is fixed, so run
 *  code can neither restore nor reach them. A lock that cannot take hold throws, and the worker does not start. */
export const WORKER_LOCK = `/* pi-browser: run code in this worker reaches the browser through its DevTools guard alone. */
(() => {
  const api = globalThis.chrome;
  const only = (keys, props) => props !== null && typeof props === "object" && Object.keys(props).every((key) => keys.includes(key));
  const refused = (what) => Promise.reject(new Error("pi-browser: this browser's extension does not " + what));
  const { tabs, windows, offscreen } = api;
  const debuggerApi = api.debugger;
  const replace = {
    tabs: Object.freeze({ query: (query) => tabs.query(query), update: (id, props) => (only(["active"], props) ? tabs.update(id, props) : refused("move or reload a tab")), onCreated: tabs.onCreated }),
    windows: Object.freeze({ update: (id, props) => (only(["focused"], props) ? windows.update(id, props) : refused("change a window")) }),
    debugger: Object.freeze({ getTargets: () => debuggerApi.getTargets() }),
    // Stagehand's heartbeat page alone, the one document it makes: no other page of the extension's own.
    offscreen: offscreen ? Object.freeze({ createDocument: (params) => (only(["url", "reasons", "justification"], params) && params.url === ${JSON.stringify(HEARTBEAT)} ? offscreen.createDocument(params) : refused("open a page of its own")) }) : undefined,
  };
  for (const name of ["scripting", "sessions", "downloads", "pageCapture", "tabCapture", "desktopCapture", "tabGroups", "search", "history", "bookmarks", "readingList", "sidePanel", "action", "contextMenus", "devtools", "management", "permissions"]) replace[name] = undefined;
  for (const [name, value] of Object.entries(replace)) {
    Object.defineProperty(api, name, { value, writable: false, configurable: false, enumerable: true });
    if (api[name] !== value) throw new Error("pi-browser: the extension API " + name + " could not be locked");
  }
  // A worker's own clients: it could move one of the extension's pages elsewhere (WindowClient.navigate).
  Object.defineProperty(globalThis, "clients", { value: undefined, writable: false, configurable: false });
  if (globalThis.clients !== undefined) throw new Error("pi-browser: the worker's clients could not be locked");
})();
`;

/** Writes the policy into the copy and loads it into the running browser; answers the extension's id. `policyUrl`: the
 *  socket the extension may connect to, when it is not the one it is loaded through (a guard in front of it, cdp-guard.ts).
 *  `locked`: the copy also drops LOCKED_PERMISSIONS and its worker runs WORKER_LOCK first, so code run in it reaches the
 *  browser through the guard alone. */
export async function loadConfined(copy: string, devtoolsUrl: string, policyUrl: string = devtoolsUrl, { locked = false }: { locked?: boolean } = {}): Promise<string> {
  const file = path.join(copy, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const confined = connectPolicy(manifest, policyUrl);
  if (locked) {
    confined.permissions = (Array.isArray(manifest.permissions) ? manifest.permissions : []).filter((name) => !LOCKED_PERMISSIONS.includes(String(name)));
    const worker = (manifest.background as { service_worker?: unknown } | undefined)?.service_worker;
    if (typeof worker !== "string" || worker !== path.basename(worker)) throw new Error("Stagehand's extension names no service worker this copy can lock");
    const at = path.join(copy, worker);
    const code = await readFile(at, "utf8");
    if (!code.startsWith(WORKER_LOCK)) await writeFile(at, WORKER_LOCK + code);
  }
  await writeFile(file, JSON.stringify(confined, null, 2));
  const session = await cdpCall(devtoolsUrl, "Extensions.loadUnpacked", { path: copy }, LOAD_MS);
  try {
    const id = session.result?.id;
    if (typeof id !== "string" || !id) throw new Error("the browser did not return the extension's id");
    // The socket is open to the Origin the copy's path implies: an extension named otherwise could not use it.
    if (id !== copyId(copy)) throw new Error("the browser named the loaded extension differently than its directory implies");
    return id;
  } finally { session.close(); }
}

/** Whether the browser already holds, enabled, the extension with this id: the one a copy's path implies, never another that
 *  merely carries Stagehand's name (an earlier, unconfined copy would be taken for the lease's own). */
export async function isLoaded(devtoolsUrl: string, id: string): Promise<boolean> {
  const session = await cdpCall(devtoolsUrl, "Extensions.getExtensions", {}, LOAD_MS);
  try {
    return ((session.result?.extensions ?? []) as Array<{ id: string; enabled: boolean }>).some((e) => e.id === id && e.enabled);
  } finally { session.close(); }
}
