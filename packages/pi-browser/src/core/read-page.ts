// A fetched HTML page read as its title, its text and its links, without ever holding the event loop. The host's tools
// run in the run's own process, so a read that holds the loop holds the run's heartbeat with it, and a run whose
// heartbeat lapses is fenced: go.dev/dl, 3.15 MB of tables, held it past 240 s in one markdown conversion. So one linear
// pass drops the blocks that hold no readable text (page-scan.ts); what is left is cut at READ_MAX_CHARS (the page is
// then `truncated`, and `html_chars` is its whole length); and a worker thread converts that to markdown, in pieces
// small enough that the converter stays linear (page-markdown.ts), within a deadline. A worker that has not answered by
// then, or that fails, is stopped, and the text is the page's plain text, read on the loop in steps that yield it
// (`converted: "text"`).
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { cutHtml, type Decode, InertDrop, PageScan } from "./page-scan.js";

/** The most of a page's HTML that is read, counted once its script, style, svg, noscript and template blocks and its
 *  comments are dropped. A million characters of go.dev/dl converts in about 0.8 s on a busy 48-core host and gives
 *  590,000 characters of markdown, ten times the 60,000 one web_fetch answer carries. */
export const READ_MAX_CHARS = 1_000_000;
/** How long the worker has for the markdown by default: six times what READ_MAX_CHARS of tables took. */
export const READ_DEADLINE_MS = 5_000;
/** How much of the page one step of the plain-text scan reads before it yields the loop. */
const STEP_CHARS = 32_768;

/** `converted`: "markdown", or "text" when the conversion did not finish in time (or failed) and the text is the page's
 *  plain text. `truncated` and `html_chars` (the page's whole length, in characters) when the page was cut at
 *  READ_MAX_CHARS before it was read: the text, the title and the links are then the cut page's. */
export type PageRead = { title: string; text: string; links: string[]; converted: "markdown" | "text"; truncated?: true; html_chars?: number };
/** `deadlineMs`: how long the conversion to markdown has (default READ_DEADLINE_MS). `signal` ends the read, the
 *  conversion stopped, with the signal's reason. */
export type ReadPageOptions = { deadlineMs?: number; signal?: AbortSignal };
type Read = Pick<PageRead, "title" | "text" | "links">;

let decoder: Promise<Decode> | undefined;
/** node-html-parser's entity decoder, loaded once. */
const decodeOf = () => (decoder ??= import("node-html-parser").then(({ TextNode }) => (text: string) => new TextNode(text).text));

/**
 * An HTML page's title, its text as markdown, and the absolute http(s) URLs it links to (resolved against its
 * `<base href>` or `url`), each once, in page order. The event loop is never held for longer than one linear step of a
 * bounded part of the page (see the file's head and PageRead). Rejects only with `signal`'s reason.
 */
export async function readPage(html: string, url: string, { deadlineMs = READ_DEADLINE_MS, signal }: ReadPageOptions = {}): Promise<PageRead> {
  signal?.throwIfAborted();
  const decode = decodeOf();
  const kept = await dropOnLoop(html, signal);
  const read = cutHtml(kept, READ_MAX_CHARS);
  const cut = read.length < kept.length ? { truncated: true as const, html_chars: html.length } : {};
  await yieldToLoop();
  signal?.throwIfAborted();
  const markdown = await inWorker(read, url, deadlineMs, signal);
  if (markdown) return { ...markdown, converted: "markdown", ...cut };
  return { ...(await plainRead(read, url, await decode, signal)), converted: "text", ...cut };
}

/** The worker's read of `html`, or null when it has not answered within `deadlineMs`, failed, or could not start. */
function inWorker(html: string, url: string, deadlineMs: number, signal: AbortSignal | undefined): Promise<Read | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    // execArgv: none of the host's own flags (a test runner's --import, say) reach the worker.
    try { worker = new Worker(new URL("./read-page-worker.js", import.meta.url), { workerData: { html, url }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 1024 } }); } catch { resolve(null); return; }
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => undefined);
      finish();
    };
    const onAbort = () => settle(() => reject(signal!.reason));
    const timer = setTimeout(() => settle(() => resolve(null)), deadlineMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (answer: Partial<Read> & { error?: string }) => settle(() => resolve(typeof answer?.text === "string" ? { title: answer.title ?? "", text: answer.text, links: answer.links ?? [] } : null)));
    worker.once("error", () => settle(() => resolve(null)));
    worker.once("exit", () => settle(() => resolve(null)));
  });
}

/** `html` without its inert blocks (InertDrop), STEP_CHARS at a time with the loop yielded between steps. */
async function dropOnLoop(html: string, signal: AbortSignal | undefined): Promise<string> {
  const drop = new InertDrop(html);
  while (!drop.step(STEP_CHARS)) {
    await yieldToLoop();
    signal?.throwIfAborted();
  }
  return drop.result();
}

/** `html`'s plain text, title and links, scanned STEP_CHARS at a time with the loop yielded between steps. */
async function plainRead(html: string, url: string, decode: Decode, signal: AbortSignal | undefined): Promise<Read> {
  const scan = new PageScan(html, url, decode, true);
  while (!scan.step(STEP_CHARS)) {
    await yieldToLoop();
    signal?.throwIfAborted();
  }
  return scan.result();
}
