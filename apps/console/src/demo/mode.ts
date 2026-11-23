// Demo mode's switch: whether this browser shows the console over sample data in place of its server's. The choice is
// this browser's alone (localStorage), so it never changes what the server holds or what another browser sees.

import { ClientError } from "@/lib/client";
import type { Upload } from "@/lib/uploads";

const KEY = "agentrun.console.demo";

/** What demo mode answers a write it does not make. */
export const DEMO_REFUSAL = "Demo mode shows sample data, so this change was not made. Turn demo mode off in Settings → Demo to work with your own server.";

/** The files picked in demo mode, by id: each one's name and what it holds, kept in this page until a run takes it (its
 *  `inputs/<path>`) or it is let go of. Only text is read; another kind of file is kept as a line that names it. */
const picked = new Map<string, { path: string; text: string }>();
export const demoPicked = {
  get: (id: string) => picked.get(id) ?? null,
  drop: (id: string) => picked.delete(id),
};
const TEXT = /^(text\/|application\/(json|xml|yaml|x-yaml|csv|x-ndjson))/;
const textOf = async (file: File): Promise<string> => {
  if (!(TEXT.test(file.type) || /\.(md|txt|csv|json|ya?ml|xml|log|tsv)$/i.test(file.name))) return `${file.name}: ${file.size} bytes. Demo mode keeps the file in this page and shows only text files' contents.\n`;
  // A browser's Blob reads its text; an older one (and jsdom) only through a FileReader.
  if (typeof file.text === "function") { try { return await file.text(); } catch { /* read it the older way */ } }
  return new Promise((done) => {
    const reader = new FileReader();
    reader.onload = () => done(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => done("");
    reader.readAsText(file);
  });
};

/** Demo mode's upload: a picked file is kept in this page, as the server would keep it, and never sent. The start screens'
 *  own upload is an XMLHttpRequest to the server, which the demo's `fetch` never sees. */
export const demoUpload: Upload = (file, onProgress, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new ClientError(0, "aborted", "The upload was stopped."));
  let sent = 0;
  const tick = setInterval(() => {
    sent = Math.min(1, sent + 0.34);
    onProgress(sent);
    if (sent < 1) return;
    clearInterval(tick);
    void textOf(file).then((text) => {
      if (signal.aborted) return;
      const at = new Date().toISOString();
      const id = `file_demo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      picked.set(id, { path: file.name, text });
      resolve({ file_id: id, path: file.name, size_bytes: file.size, content_type: file.type || "application/octet-stream", sha256: "0".repeat(64), status: "ready", created_at: at, expires_at: null });
    });
  }, 120);
  signal.addEventListener("abort", () => { clearInterval(tick); reject(new ClientError(0, "aborted", "The upload was stopped.")); }, { once: true });
});
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const local = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The choice held on this page when the browser's storage refuses it (private mode): it lasts until the page reloads. */
let held: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();

/** Whether demo mode is on in this browser. */
export function demoOn(store: Store | null = local()): boolean {
  if (held !== null) return held;
  try { return store?.getItem(KEY) === "on"; } catch { return false; }
}

/** Turns demo mode on or off, here and for every page of the console that listens (`onDemoChange`). */
export function setDemo(on: boolean, store: Store | null = local()): void {
  try {
    if (on) store?.setItem(KEY, "on"); else store?.removeItem(KEY);
    held = store ? null : on;
  } catch { held = on; }
  for (const l of listeners) l(on);
}

/** Calls `listener` at each change of the switch made on this page; answers the way to stop. */
export function onDemoChange(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
