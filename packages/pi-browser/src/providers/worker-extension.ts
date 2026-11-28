// The Stagehand extension a local launched Chrome is given: a copy in the lease's private TMPDIR whose pages and worker may
// connect to nothing but the extension's own files and the browser's DevTools socket. Run code executes in that worker with
// the extension's host permissions, so the browser itself refuses what the observer can only watch. A copy, because the
// manifest is Stagehand's bytes and a directory shared by every lease cannot name this lease's socket; created before the
// browser starts, because its path decides the extension's id and so the one Origin the browser's socket is opened to. The
// copy's worker also carries one rewrite, so a process that dies inside a run can be reattached at once (endBatchesOnRelease).
import { readFileSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdpCall } from "../core/cdp-call.js";
import { BrowserFailureError } from "../core/custody.js";
import { browserFailure } from "../core/failures.js";
import { extensionDirectory, extensionOrigin } from "./chrome-args.js";

export const COPY = "stagehand-extension";
/** The name Stagehand's extension carries, which is how Stagehand finds it in a browser. */
export const STAGEHAND_EXTENSION = "Stagehand Runtime";
const LOAD_MS = 20_000;

/** The Stagehand release the rewrite below was written against; a test holds it to the installed one, so a bump re-reads it. */
export const REWRITE_FOR = "4.4.0";
const WORKER = "service-worker.js";
/** The first line of a rewritten worker, so the copy a browser runs can be told from Stagehand's own. */
export const REWRITE_MARK = "// pi-browser: a released client's callback batches end with it (see NOTICE in this directory).\n";
export const COPY_NOTICE = `This directory is a copy of the extension in @browserbasehq/stagehand ${REWRITE_FOR} (dist/extension), under
Stagehand's MIT license (LICENSE, beside this file). @parcha/pi-browser changed two files in it:
- manifest.json: a content security policy limiting the extension's connections to its own files and one browser's
  DevTools socket.
- ${WORKER}: when the extension releases a client that went away, it now aborts that client's running callback batches,
  rather than leaving each to run until its own timeout.
`;

// Stagehand's extension keeps a dead client's callback batch running until the batch's own timeout, and holds the next client's
// stagehand.init behind it: releasing the client (ClientLifecycle.lost, then RPCClient.releaseClient) does not reach the batch's
// AbortController (createCallbackBatchController), while disposing the instance waits for every request in flight, the batch
// among them, and init queues behind that disposal. A process that dies inside a run is reattached only after its last batch's
// deadline (60 s by default), as long as Stagehand's own init deadline. The rewrite has releaseClient abort the running batches.
// That alone frees init (lines in Stagehand 4.4.0's dist/extension/service-worker.js): run() races the callback against its
// abort (:14696), so it rejects at once; only the outer callback_batch request holds the instance (:13368), the commands a batch
// sends taking none; its error reply throws, the client being gone (:13224), and its finally still releases the instance. One
// client is attached at a time and the router serves whichever it is, so only the dead client's batches are running when its
// release comes. Delete this rewrite once Stagehand ships the same change (upstream issue to be linked here).
const EDITS: ReadonlyArray<{ name: string; find: string; to: string }> = [
  { name: "the batch registry",
    find: "function createCallbackBatchController(router) {\n",
    to: "function createCallbackBatchController(router) {\n\tconst active = new Set();\n" },
  { name: "a batch's start",
    find: "\t\tconst controller = new AbortController();\n\t\tconst timeoutId = setTimeout(() => {\n\t\t\tcontroller.abort(/* @__PURE__ */ new Error(`Stagehand callback batch timed out after ${options.timeout}ms`));\n\t\t}, options.timeout);\n",
    to: "\t\tconst controller = new AbortController();\n\t\tconst timeoutId = setTimeout(() => {\n\t\t\tcontroller.abort(/* @__PURE__ */ new Error(`Stagehand callback batch timed out after ${options.timeout}ms`));\n\t\t}, options.timeout);\n\t\tactive.add(controller);\n" },
  { name: "a batch's end",
    find: "\t\t\tclearTimeout(timeoutId);\n\t\t\tif (!controller.signal.aborted) controller.abort(/* @__PURE__ */ new Error(\"Stagehand callback batch has completed\"));\n",
    to: "\t\t\tclearTimeout(timeoutId);\n\t\t\tactive.delete(controller);\n\t\t\tif (!controller.signal.aborted) controller.abort(/* @__PURE__ */ new Error(\"Stagehand callback batch has completed\"));\n" },
  { name: "the batch controller's interface",
    find: "\treturn { run };\n}\nfunction createCallbackContextFacade(",
    to: "\treturn {\n\t\trun,\n\t\tabortAll(reason) {\n\t\t\tfor (const controller of active) controller.abort(reason);\n\t\t}\n\t};\n}\nfunction createCallbackContextFacade(" },
  { name: "the client's release",
    find: "\treleaseClient() {\n\t\tthis.clientConnected = false;\n",
    to: "\treleaseClient() {\n\t\tthis.clientConnected = false;\n\t\tthis.router.callbackBatchController.abortAll(/* @__PURE__ */ new Error(\"Stagehand client disconnected\"));\n" },
];

/** Stagehand's package root (the module it exports is dist/index.mjs). */
const stagehandRoot = (): string => path.join(path.dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "..");
/** The Stagehand version installed beside this package. */
export const installedStagehand = (): string => (JSON.parse(readFileSync(path.join(stagehandRoot(), "package.json"), "utf8")) as { version: string }).version;

/** Stagehand's extension worker with the rewrite above. Each place it changes must appear exactly once: a worker that has moved
 *  any of them is refused whole, naming the place and the installed Stagehand (`installed`), and never rewritten in part. A
 *  refusal fails the local Chrome launch with that error (copyExtension runs before Chrome starts, and the cdp provider removes
 *  what the launch made): a launch never goes ahead on a copy without the rewrite, nor on Stagehand's own directory. */
export function endBatchesOnRelease(worker: string, installed: string = installedStagehand()): string {
  for (const edit of EDITS) {
    const at = worker.indexOf(edit.find);
    if (at >= 0 && worker.indexOf(edit.find, at + 1) < 0) continue;
    throw new BrowserFailureError(browserFailure("browser_unavailable", `Stagehand's extension worker (${WORKER}, Stagehand ${installed}) has ${at < 0 ? "no" : "more than one"} match for ${edit.name}, which pi-browser rewrites so a gone client's callback batches end with it; the rewrite was written against Stagehand ${REWRITE_FOR}. No browser was started.`));
  }
  return REWRITE_MARK + EDITS.reduce((text, edit) => text.replace(edit.find, () => edit.to), worker);
}

/** `<into>/stagehand-extension`, a copy of Stagehand's extension directory, its worker rewritten (above), with Stagehand's LICENSE
 *  and a NOTICE naming what changed. The worker is rewritten before anything is copied, so a refused one leaves no copy. */
export async function copyExtension(into: string, source: string = extensionDirectory()): Promise<string> {
  const worker = endBatchesOnRelease(await readFile(path.join(source, WORKER), "utf8"));
  const copy = path.join(into, COPY);
  await cp(source, copy, { recursive: true, dereference: true });
  await writeFile(path.join(copy, WORKER), worker);
  await cp(path.join(stagehandRoot(), "LICENSE"), path.join(copy, "LICENSE"));
  await writeFile(path.join(copy, "NOTICE"), COPY_NOTICE);
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

/** Writes the policy into the copy and loads it into the running browser; answers the extension's id. */
export async function loadConfined(copy: string, devtoolsUrl: string): Promise<string> {
  const file = path.join(copy, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify(connectPolicy(manifest, devtoolsUrl), null, 2));
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
