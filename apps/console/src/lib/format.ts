import DOMPurify from "dompurify";
import { marked } from "marked";
import type { MouseEvent } from "react";
import type { Cost } from "./v2";

/** The tags DOMPurify keeps: its own allowed-tag config, read once through its uponSanitizeElement hook (the tag list is
 *  not exported). A tag's own name decides, never the tag tried alone: a table's <tr> and <td> are kept in a table, where
 *  on its own a browser drops them before the sanitizer sees them. */
let allowed: Record<string, boolean> | undefined;
const keeps = (name: string) => {
  if (!allowed) {
    DOMPurify.addHook("uponSanitizeElement", (_node, data) => { allowed ??= data.allowedTags; });
    DOMPurify.sanitize("<b></b>");
    DOMPurify.removeHook("uponSanitizeElement");
  }
  return allowed?.[name.toLowerCase()] === true;
};
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Markdown as the console reads it, everywhere it renders some (markdown() below). A single line break is a break: an
// answer asked for in three lines shows three (marked joined them into one). A tag the sanitizer would drop is text: an
// agent's placeholder ("Customer: <name>", "$<amount>") or a <script> it quotes reads as written, where marked passed it
// through as HTML and DOMPurify then removed it unseen. Tags DOMPurify keeps (<b>, <br>, <img>, a table's cells) stay
// HTML, and DOMPurify stays the last pass over everything. A block marked read as HTML that turns wholly into text (a
// template whose first line is "<name>") is a paragraph, its lines kept as `breaks` keeps a paragraph's.
marked.use({ breaks: true, renderer: { html: ({ text, block }) => {
  let kept = 0;
  const out = text.replace(/<\/?([A-Za-z][\w:-]*)[^<>]*>/g, (tag, name: string) => (keeps(name) ? (kept++, tag) : escapeHtml(tag)));
  return block && !kept && out !== text ? `<p>${out.trim().replace(/\n/g, "<br>\n")}</p>\n` : out;
} } });

/** A run's short label, the one every place that shows one uses: the id's last 8 characters. Run ids are UUIDv7s, whose
 *  leading digits are the start time (the same for runs started within about a minute); the tail is random. */
export const runLabel = (id: string) => id.slice(-8);

/** The console's times, every one it shows, in the viewer's own zone (the browser's): no `timeZone` is set. `clock`, the
 *  time of day (a Timeline step); `when`, the day and the time (everything else). */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether a cost is an estimate, by its basis. The label's "est." and the run page's billing disclaimer both read it. */
export const isEstimate = (c: Cost) => c.basis === "estimate";

/** A run's cost in dollars: a figure above zero never reads as $0 (under a hundredth of a cent it reads "<$0.0001"),
 *  four places under a cent, two from a cent up. */
export const dollars = (usd: number) => (usd > 0 && usd < 0.0001 ? "<$0.0001" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** A cost known so far in dollars: up to four places under a dollar, as the run's own usage row says it ("Cost so far:
 *  $0.0123 known"), since a partial sum is often cents and two places would disagree with the row beside it. Zeros past
 *  the cents go ($0.07, not $0.0700); above zero it never reads as $0. */
const soFarDollars = (usd: number) => {
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const [whole, places = ""] = usd.toFixed(4).split(".");
  return `$${whole}.${places.replace(/0+$/, "").padEnd(2, "0")}`;
};

/** The cost known so far, when the server can't give the whole (costsofar/1: `so_far_usd` and `unpriced`, sent only while
 *  `usd` is null); undefined when it says neither. */
export const soFar = (c: Cost | null | undefined): (Cost & { so_far_usd: number; unpriced: number }) | undefined =>
  c && c.usd === null && typeof c.so_far_usd === "number" && typeof c.unpriced === "number" ? (c as Cost & { so_far_usd: number; unpriced: number }) : undefined;

/** Said beside a cost known so far: why it is not the whole cost (a charge with no price: a model request cut, stopped or
 *  still pending, a model with no price, a decision or a paid tool call whose cost is unknown). */
export const soFarNote = (c: { unpriced: number }, { ended = false }: { ended?: boolean } = {}) =>
  `The charges priced${ended ? "" : " so far"}. ${c.unpriced} ${c.unpriced === 1 ? "charge has" : "charges have"} no price, so this is not the whole cost.`;

/** A run's status once it has ended: its cost is said as its whole, never "so far" (cost's `ended`). */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
export const runEnded = (status: string | undefined | null): boolean => typeof status === "string" && ENDED_STATUSES.has(status);

/** A charge on a timeline row, in words: "$0.0018", or what is known so far ("so far $0.001, 1 not priced") when one of its
 *  charges has no price. */
export const chargeWords = (u: { usd: number | null; so_far_usd?: number; unpriced?: number }): string =>
  u.usd !== null ? dollars(u.usd) : typeof u.so_far_usd === "number" ? `so far ${soFarDollars(u.so_far_usd)}, ${u.unpriced ?? 0} not priced` : "not priced";

/** A local estimate stays an estimate, and a cost the server does not know says so: the contract's "Null while unknown.
 *  A client shows null as unknown, never as $0" (a request cut before its answer, a cost still pending, or a model with
 *  no price). When the server says what is known so far, that is said ("so far $0.0123 · 1 not priced"), never as the
 *  whole cost; a run that has ended (`ended`) says what is known without "so far" ("$0.0123 known · 1 not priced"), as its
 *  usage row says its cost. Never a billed amount, never an invented zero. */
export function cost(c: Cost | null | undefined, { ended = false }: { ended?: boolean } = {}): string {
  const known = soFar(c);
  const est = (x: Cost) => (isEstimate(x) ? " est." : "");
  if (known) return ended ? `${soFarDollars(known.so_far_usd)}${est(known)} known · ${known.unpriced} not priced` : `so far ${soFarDollars(known.so_far_usd)}${est(known)} · ${known.unpriced} not priced`;
  if (!c || c.usd === null) return "Unknown";
  return `${dollars(c.usd)}${est(c)}`;
}

/** The run files a run's Markdown may link to: their paths as GET /v2/runs/{id}/files lists them, and `from`, the folder
 *  of the file the Markdown is in ("" for the run's answer), which its relative links are read from. */
export type LinkedFiles = { paths: readonly string[]; from?: string };

/** The run file a relative link names, resolved from `from` as a browser would (./, ../, %20; no query or fragment), or
 *  null when it names none (a link no URL parser takes included). A path from the root (/x) is the server's, never a run
 *  file. The folder is a path, not a URL: each of its names is encoded, so a #, ? or % in one is a character of it. */
function runFile(href: string, files: LinkedFiles): string | null {
  if (href.startsWith("/") || href.startsWith("#")) return null;
  const from = files.from ? `${files.from.replace(/\/*$/, "").split("/").map(encodeURIComponent).join("/")}/` : "";
  try {
    const path = decodeURIComponent(new URL(href, `file:///${from}`).pathname.slice(1));
    return files.paths.includes(path) ? path : null;
  } catch { return null; }
}

/** Markdown from a run, as safe HTML: parsed by marked, then sanitized (no scripts, no handlers, no foreign frames).
 *  A link with no scheme (a relative path, a path from the root, a fragment, //host) would be read against the console's
 *  own address and take its tab away (a fragment changes its route), so it is never a link here: one that names a run
 *  file in `files` becomes a button carrying `data-run-file` (the page opens the file on its click), any other reads as
 *  its text. A link to a page (http:, https:, ftp:) opens in a new tab, with no opener and no referrer; one that hands off
 *  to another app (mailto:, tel:) is as marked and the sanitizer leave it. */
export function markdown(text: string, files?: LinkedFiles): string {
  const body = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { RETURN_DOM: true }) as HTMLElement;
  for (const a of [...body.querySelectorAll("a[href]")]) {
    const href = a.getAttribute("href")!.trim();
    if (/^(https?|ftps?):/i.test(href)) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); continue; }
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
    const path = files && runFile(href, files);
    if (path) {
      const open = a.ownerDocument.createElement("button");
      open.type = "button";
      open.title = `Open ${path}`;
      open.dataset.runFile = path;
      open.append(...a.childNodes);
      a.replaceWith(open);
    } else a.replaceWith(...a.childNodes);
  }
  return body.innerHTML;
}

/** A click handler for rendered Markdown: a click on a run file's button (`data-run-file`, from `markdown`) opens it. */
export const openLinkedFile = (onOpen: (path: string) => void) => (e: MouseEvent<HTMLElement>) => {
  const path = (e.target as Element).closest?.("[data-run-file]")?.getAttribute("data-run-file");
  if (path) { e.preventDefault(); onOpen(path); }
};
