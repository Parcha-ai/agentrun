// A fetched HTML page read as its title, its text and its links, without ever holding the event loop. The host's tools
// run in the run's own process, so a read that holds the loop holds the run's heartbeat with it, and a run whose
// heartbeat lapses is fenced: go.dev/dl, 3.15 MB of tables, held it past 240 s in one markdown conversion. So one linear
// pass drops the blocks that hold no readable text, and another the elements the page hides from everyone (page-scan.ts:
// a help pop-up until its link is clicked is not the page's text); what is left is cut at READ_MAX_CHARS (the page is
// then `truncated`, and `html_chars` is its whole length); and a worker thread converts that to markdown, in pieces
// small enough that the converter stays linear (page-markdown.ts), within a deadline. A worker that has not answered by
// then, or that fails, is stopped, and the text is the page's plain text, read on the loop in steps that yield it
// (`converted: "text"`). browser_read's markdown (htmlMarkdown) goes through the same worker, which drops, picks and
// cuts the live page's HTML itself, since that HTML has no bound; its fallback is the browser's own text.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { decodeEntities } from "./entities.js";
import { cutHtml, HiddenDrop, hidingClassesOf, InertDrop, PageScan } from "./page-scan.js";
import type { Job } from "./read-page-worker.js";

/** The most of a page's HTML that is read, counted once its script, style, svg, noscript and template blocks and its
 *  comments are dropped. A million characters of go.dev/dl converts in about 0.8 s on a busy 48-core host and gives
 *  590,000 characters of markdown, ten times the 60,000 one web_fetch answer carries. */
export const READ_MAX_CHARS = 1_000_000;
/** How long the worker has for the markdown by default: six times what READ_MAX_CHARS of tables took. */
export const READ_DEADLINE_MS = 5_000;
/** `n` with its digits in groups of three ("3,154,060"): Intl's first use costs tens of milliseconds on the loop. */
export const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ",");
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
/** The worker's answer (read-page-worker.ts). */
type Answer = { text: string; title?: string; links?: string[]; truncated?: true; html_chars?: number };

/**
 * An HTML page's title, its text as markdown, and the absolute http(s) URLs it links to (resolved against its
 * `<base href>` or `url`), each once, in page order. The event loop is never held for longer than one linear step of a
 * bounded part of the page (see the file's head and PageRead). Rejects only with `signal`'s reason.
 */
export async function readPage(html: string, url: string, { deadlineMs = READ_DEADLINE_MS, signal }: ReadPageOptions = {}): Promise<PageRead> {
  signal?.throwIfAborted();
  // What the page hides from everyone who reads it (a help pop-up until its link is clicked, a closed dialog) is not
  // its text: the classes its own style hides are read before its style elements go.
  const hiding = hidingClassesOf(html);
  const kept = await dropHiddenOnLoop(await dropOnLoop(html, signal), hiding, signal);
  const read = cutHtml(kept, READ_MAX_CHARS);
  const cut = read.length < kept.length ? { truncated: true as const, html_chars: html.length } : {};
  await yieldToLoop();
  signal?.throwIfAborted();
  const markdown = await inWorker({ html: read, url }, deadlineMs, signal);
  if (markdown) return { title: markdown.title ?? "", text: markdown.text, links: markdown.links ?? [], converted: "markdown", ...cut };
  return { ...(await plainRead(read, url, signal)), converted: "text", ...cut };
}

/**
 * `html`'s markdown, made in the worker within `deadlineMs` (default READ_DEADLINE_MS): of its first article, else its
 * main, else its body element when `main` (mainOf), once its inert blocks are dropped, cut at READ_MAX_CHARS (then
 * `truncated`, and `html_chars` is the page's whole length). Null when the worker has not answered in time, failed, or
 * could not start. The event loop does no more than hand the worker the page. Rejects only with `signal`'s reason.
 */
export async function htmlMarkdown(html: string, { main = false, deadlineMs = READ_DEADLINE_MS, signal }: { main?: boolean } & ReadPageOptions = {}): Promise<{ text: string; truncated?: true; html_chars?: number } | null> {
  signal?.throwIfAborted();
  const answer = await inWorker({ html, main, max: READ_MAX_CHARS }, deadlineMs, signal);
  return answer && { text: answer.text, ...(answer.truncated ? { truncated: true as const, html_chars: answer.html_chars! } : {}) };
}

/** The worker's answer to `job`, or null when it has not answered within `deadlineMs`, failed, or could not start. */
function inWorker(job: Job, deadlineMs: number, signal: AbortSignal | undefined): Promise<Answer | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    // execArgv: none of the host's own flags (a test runner's --import, say) reach the worker.
    try { worker = new Worker(new URL("./read-page-worker.js", import.meta.url), { workerData: job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 1024 } }); } catch { resolve(null); return; }
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => undefined);
      finish();
    };
    const onAbort = () => settle(() => reject(signal!.reason));
    const timer = setTimeout(() => settle(() => resolve(null)), deadlineMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (answer: Partial<Answer> & { error?: string }) => settle(() => resolve(typeof answer?.text === "string" ? answer as Answer : null)));
    worker.once("error", () => settle(() => resolve(null)));
    worker.once("exit", () => settle(() => resolve(null)));
  });
}

/** `html` without its inert blocks (InertDrop), STEP_CHARS at a time with the loop yielded between steps. */
export async function dropOnLoop(html: string, signal?: AbortSignal): Promise<string> {
  const drop = new InertDrop(html);
  while (!drop.step(STEP_CHARS)) {
    await yieldToLoop();
    signal?.throwIfAborted();
  }
  return drop.result();
}

/** `html` without the elements it hides from everyone (HiddenDrop), with `classes` the ones its own style hid,
 *  STEP_CHARS at a time with the loop yielded between steps. */
async function dropHiddenOnLoop(html: string, classes: ReadonlySet<string>, signal?: AbortSignal): Promise<string> {
  const drop = new HiddenDrop(html, classes);
  while (!drop.step(STEP_CHARS)) {
    await yieldToLoop();
    signal?.throwIfAborted();
  }
  return drop.result();
}

/** `html`'s plain text, title and links, scanned STEP_CHARS at a time with the loop yielded between steps. */
async function plainRead(html: string, url: string, signal: AbortSignal | undefined): Promise<Read> {
  // Decoded here without node-html-parser, whose first load would hold the loop (entities.ts).
  const scan = new PageScan(html, url, decodeEntities, true);
  while (!scan.step(STEP_CHARS)) {
    await yieldToLoop();
    signal?.throwIfAborted();
  }
  return scan.result();
}
