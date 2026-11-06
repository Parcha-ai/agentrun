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
/** The name Stagehand's extension carries, which is how Stagehand finds it in a browser. */
export const STAGEHAND_EXTENSION = "Stagehand Runtime";
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
 *  pages (the worker's clients), an offscreen document but the heartbeat (a fresh extension context), a request rule
 *  that does more than allow or block (Stagehand 4.4's domain policy), and every other API that opens or captures a page.
 *  Both of the worker's API namespaces are locked: `chrome` and `browser` (Chrome's second name for the same APIs, with
 *  objects of its own), and neither can be swapped. The originals stay in this closure alone; each replaced property is
 *  fixed, so run code can neither restore nor reach them.
 *  Run code shares this worker's realm, so it can replace any global or prototype method and hand the lock objects that
 *  lie (a Proxy, a getter that answers twice, a field on a prototype). So every intrinsic a wrapper uses is taken here,
 *  before any other code runs, and none is looked up at call time; and no wrapper forwards what it is given: it reads
 *  each field it allows once, as a primitive (or a list of them), refuses any other own field, and hands Chrome a new
 *  object with no prototype that holds those values alone. A lock that cannot take hold throws, and the worker does not
 *  start. */
export const WORKER_LOCK = `/* pi-browser: run code in this worker reaches the browser through its DevTools guard alone. */
(() => {
  "use strict";
  const realm = globalThis;
  const apply = Reflect.apply;
  const ownKeys = Reflect.ownKeys;
  const define = Reflect.defineProperty;
  const isArray = Array.isArray;
  const isInteger = Number.isInteger;
  const ErrorOf = Error;
  const PromiseOf = Promise;
  const reject = Promise.reject;
  const freeze = Object.freeze;
  const NO = freeze({ __proto__: null });
  const fail = () => { throw NO; };
  const refused = (what) => apply(reject, PromiseOf, [new ErrorOf("pi-browser: this browser's extension does not " + what)]);
  const field = (value) => ({ __proto__: null, value, writable: true, enumerable: true, configurable: true });
  const names = (list) => { const set = { __proto__: null }; for (let i = 0; i < list.length; i++) set[list[i]] = true; return set; };
  // The caller's object, its own fields all among those allowed (a Proxy answers for itself, and anything it adds is refused).
  const record = (value, allowed) => {
    if (value === null || typeof value !== "object") fail();
    const keys = ownKeys(value);
    const count = keys.length;
    for (let i = 0; i < count; i++) if (allowed[keys[i]] !== true) fail();
  };
  const flag = (value) => (typeof value === "boolean" ? value : fail());
  const int = (value) => (typeof value === "number" && isInteger(value) ? value : fail());
  const text = (value) => (typeof value === "string" ? value : fail());
  // A new list of the caller's items, each read once and checked.
  const list = (value, each) => {
    if (!isArray(value)) fail();
    const count = value.length;
    if (typeof count !== "number" || !isInteger(count) || count < 0 || count > 5000) fail();
    const out = [];
    for (let i = 0; i < count; i++) if (!define(out, i, field(each(value[i])))) fail();
    return out;
  };
  const QUERY = names(["active", "lastFocusedWindow", "currentWindow", "windowId"]);
  const ACTIVE = names(["active"]);
  const FOCUSED = names(["focused"]);
  const DOCUMENT = names(["url", "reasons", "justification"]);
  const REGEX = names(["regex", "isCaseSensitive", "requireCapturing"]);
  const UPDATE = names(["removeRuleIds", "addRules"]);
  const RULE = names(["id", "priority", "action", "condition"]);
  const ACTION = names(["type"]);
  const CONDITION = names(["regexFilter", "urlFilter", "isUrlFilterCaseSensitive", "resourceTypes", "excludedResourceTypes", "initiatorDomains", "tabIds"]);
  const HEARTBEAT = ${JSON.stringify(HEARTBEAT)};
  // A request rule of Stagehand 4.4's domain policy: it allows or blocks a request and does nothing else (no redirect, no
  // header changed), built anew from the caller's fields.
  const rule = (value) => {
    record(value, RULE);
    const out = { __proto__: null, id: int(value.id) };
    const priority = value.priority;
    if (priority !== undefined) out.priority = int(priority);
    const action = value.action;
    record(action, ACTION);
    const type = action.type;
    if (type !== "allow" && type !== "block") fail();
    out.action = { __proto__: null, type };
    const condition = value.condition;
    record(condition, CONDITION);
    const made = { __proto__: null };
    const regexFilter = condition.regexFilter;
    if (regexFilter !== undefined) made.regexFilter = text(regexFilter);
    const urlFilter = condition.urlFilter;
    if (urlFilter !== undefined) made.urlFilter = text(urlFilter);
    const caseSensitive = condition.isUrlFilterCaseSensitive;
    if (caseSensitive !== undefined) made.isUrlFilterCaseSensitive = flag(caseSensitive);
    const resourceTypes = condition.resourceTypes;
    if (resourceTypes !== undefined) made.resourceTypes = list(resourceTypes, text);
    const excludedResourceTypes = condition.excludedResourceTypes;
    if (excludedResourceTypes !== undefined) made.excludedResourceTypes = list(excludedResourceTypes, text);
    const initiatorDomains = condition.initiatorDomains;
    if (initiatorDomains !== undefined) made.initiatorDomains = list(initiatorDomains, text);
    const tabIds = condition.tabIds;
    if (tabIds !== undefined) made.tabIds = list(tabIds, int);
    out.condition = made;
    return out;
  };
  // One namespace's replacements, each wrapper calling that namespace's own originals, taken now.
  const locked = (api) => {
    const tabs = api.tabs;
    const windows = api.windows;
    const offscreen = api.offscreen;
    const dnr = api.declarativeNetRequest;
    const debuggerApi = api.debugger;
    const query = tabs && tabs.query;
    const update = tabs && tabs.update;
    const focus = windows && windows.update;
    const targets = debuggerApi && debuggerApi.getTargets;
    const createDocument = offscreen && offscreen.createDocument;
    const replace = {
      tabs: tabs ? freeze({
        query: (props) => {
          let args;
          try {
            const made = { __proto__: null };
            if (props !== undefined) {
              record(props, QUERY);
              const active = props.active;
              if (active !== undefined) made.active = flag(active);
              const last = props.lastFocusedWindow;
              if (last !== undefined) made.lastFocusedWindow = flag(last);
              const current = props.currentWindow;
              if (current !== undefined) made.currentWindow = flag(current);
              const windowId = props.windowId;
              if (windowId !== undefined) made.windowId = int(windowId);
            }
            args = [made];
          } catch { return refused("look a tab up but by its focus or window"); }
          return apply(query, tabs, args);
        },
        update: (id, props) => {
          let args;
          try {
            const tabId = int(id);
            record(props, ACTIVE);
            if (props.active !== true) fail();
            args = [tabId, { __proto__: null, active: true }];
          } catch { return refused("move or reload a tab"); }
          return apply(update, tabs, args);
        },
        onCreated: tabs.onCreated,
      }) : undefined,
      windows: windows ? freeze({
        update: (id, props) => {
          let args;
          try {
            const windowId = int(id);
            record(props, FOCUSED);
            if (props.focused !== true) fail();
            args = [windowId, { __proto__: null, focused: true }];
          } catch { return refused("change a window"); }
          return apply(focus, windows, args);
        },
      }) : undefined,
      debugger: debuggerApi ? freeze({ getTargets: () => apply(targets, debuggerApi, []) }) : undefined,
      declarativeNetRequest: dnr ? freeze({
        getSessionRules: () => apply(dnr.getSessionRules, dnr, []),
        isRegexSupported: (options) => {
          let args;
          try {
            record(options, REGEX);
            const made = { __proto__: null, regex: text(options.regex) };
            const caseSensitive = options.isCaseSensitive;
            if (caseSensitive !== undefined) made.isCaseSensitive = flag(caseSensitive);
            const capturing = options.requireCapturing;
            if (capturing !== undefined) made.requireCapturing = flag(capturing);
            args = [made];
          } catch { return refused("check a request rule's pattern but by its text"); }
          return apply(dnr.isRegexSupported, dnr, args);
        },
        updateSessionRules: (options) => {
          let args;
          try {
            record(options, UPDATE);
            const made = { __proto__: null };
            const removeRuleIds = options.removeRuleIds;
            if (removeRuleIds !== undefined) made.removeRuleIds = list(removeRuleIds, int);
            const addRules = options.addRules;
            if (addRules !== undefined) made.addRules = list(addRules, rule);
            args = [made];
          } catch { return refused("change a request but to allow or block it"); }
          return apply(dnr.updateSessionRules, dnr, args);
        },
        MAX_NUMBER_OF_SESSION_RULES: dnr.MAX_NUMBER_OF_SESSION_RULES,
        MAX_NUMBER_OF_REGEX_RULES: dnr.MAX_NUMBER_OF_REGEX_RULES,
      }) : undefined,
      // Stagehand's heartbeat page alone, the one document it makes: no other page of the extension's own.
      offscreen: offscreen ? freeze({
        createDocument: (params) => {
          let args;
          try {
            record(params, DOCUMENT);
            if (params.url !== HEARTBEAT) fail();
            const reasons = list(params.reasons, text);
            if (reasons.length !== 1 || reasons[0] !== "BLOBS") fail();
            args = [{ __proto__: null, url: HEARTBEAT, reasons: ["BLOBS"], justification: text(params.justification) }];
          } catch { return refused("open a page of its own"); }
          return apply(createDocument, offscreen, args);
        },
      }) : undefined,
    };
    for (const name of ["scripting", "sessions", "downloads", "pageCapture", "tabCapture", "desktopCapture", "tabGroups", "search", "history", "bookmarks", "readingList", "sidePanel", "action", "contextMenus", "devtools", "management", "permissions", "userScripts", "webNavigation", "webRequest", "debugger"].filter((name) => !(name in replace))) replace[name] = undefined;
    for (const [name, value] of Object.entries(replace)) {
      Object.defineProperty(api, name, { value, writable: false, configurable: false, enumerable: true });
      if (api[name] !== value) throw new Error("pi-browser: the extension API " + name + " could not be locked");
    }
  };
  // Both names Chrome gives a worker's APIs, each locked over its own objects, and each name fixed to what it holds now.
  const done = [];
  for (const name of ["chrome", "browser"]) {
    const api = realm[name];
    // A browser whose two names hold the one object locks it once.
    if (api !== undefined && api !== null && !done.includes(api)) { locked(api); done.push(api); }
    Object.defineProperty(realm, name, { value: api, writable: false, configurable: false });
    if (realm[name] !== api) throw new Error("pi-browser: the worker's " + name + " namespace could not be fixed");
  }
  // A worker's own clients: it could move one of the extension's pages elsewhere (WindowClient.navigate).
  Object.defineProperty(realm, "clients", { value: undefined, writable: false, configurable: false });
  if (realm.clients !== undefined) throw new Error("pi-browser: the worker's clients could not be locked");
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

type Installed = { id: string; name: string; enabled: boolean };
const installed = async (devtoolsUrl: string): Promise<Installed[]> => {
  const session = await cdpCall(devtoolsUrl, "Extensions.getExtensions", {}, LOAD_MS);
  try { return (session.result?.extensions ?? []) as Installed[]; } finally { session.close(); }
};

/** Whether the browser already holds, enabled, the extension with this id: the one a copy's path implies, never another that
 *  merely carries Stagehand's name (an earlier, unconfined copy would be taken for the lease's own). */
export async function isLoaded(devtoolsUrl: string, id: string): Promise<boolean> {
  return (await installed(devtoolsUrl)).some((e) => e.id === id && e.enabled);
}

/** Stagehand finds its extension by name and refuses a browser that holds two enabled, so every other extension carrying that
 *  name (an earlier, unconfined copy) is uninstalled: the one Stagehand finds is then the lease's own copy, `id`. Disabled ones
 *  go too, so none can be enabled again beside it. */
export async function soleStagehand(devtoolsUrl: string, id: string): Promise<void> {
  for (const other of (await installed(devtoolsUrl)).filter((e) => e.name === STAGEHAND_EXTENSION && e.id !== id)) {
    (await cdpCall(devtoolsUrl, "Extensions.uninstall", { id: other.id }, LOAD_MS)).close();
  }
}
