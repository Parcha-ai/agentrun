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

/** Whether the browser already holds, enabled, the extension with this id: the one a copy's path implies, never another that
 *  merely carries Stagehand's name (an earlier, unconfined copy would be taken for the lease's own). */
export async function isLoaded(devtoolsUrl: string, id: string): Promise<boolean> {
  const session = await cdpCall(devtoolsUrl, "Extensions.getExtensions", {}, LOAD_MS);
  try {
    return ((session.result?.extensions ?? []) as Array<{ id: string; enabled: boolean }>).some((e) => e.id === id && e.enabled);
  } finally { session.close(); }
}
