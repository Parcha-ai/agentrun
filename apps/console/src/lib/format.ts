import DOMPurify from "dompurify";
import { marked } from "marked";
import type { MouseEvent } from "react";
import { PLAN_NO_DOLLARS } from "./chatgpt";
import { LOGIN_NO_DOLLARS } from "./claudeLogin";
import { chipRedactions } from "./redaction";
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
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Whether a cost is an estimate, by its basis. The label's "est." and the run page's billing disclaimer both read it. */
export const isEstimate = (c: Cost) => c.basis === "estimate";

/** The word a figure carries for its basis: " est." for a price table's (an estimate), " reported" for the provider's or
 *  its gateway's own figure; none for a charge or a cost nothing priced. */
const basisMark = (c: Pick<Cost, "basis">): string => (c.basis === "estimate" ? " est." : c.basis === "reported" ? " reported" : "");

/** How a cost was reached, in a sentence for its hover note (the server's `basis`); undefined for a charge. */
export const basisNote = (c: Pick<Cost, "basis">): string | undefined =>
  c.basis === "estimate" ? "A local estimate, not a bill" : c.basis === "reported" ? "As the provider or gateway reported it" : c.basis === "unpriced" ? "No model request was priced" : undefined;

/** A run's tokens as its cost says them (costbasis/1 `cost.tokens`): "12.4K in · 1,250 out", the prompt cache's reads and
 *  writes when there were any, and the requests that reported no tokens. Undefined when the run says none. `in` leaves the
 *  cached input out, as the server counts it. */
export function tokensWords(c: Cost | null | undefined): string | undefined {
  const t = c?.tokens;
  if (!t) return undefined;
  const parts = [`${compact(t.input)} in`, `${compact(t.output)} out`];
  if (t.cache_read > 0) parts.push(`${compact(t.cache_read)} cache read`);
  if (t.cache_write > 0) parts.push(`${compact(t.cache_write)} cache write`);
  if (t.unmetered) parts.push(`${compact(t.unmetered)} ${t.unmetered === 1 ? "request" : "requests"} unmetered`);
  return parts.join(" · ");
}

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

/** The cost known so far, when the server can't give the whole (costsofar/1: `so_far_usd` and `unpriced` while `usd` is
 *  null); undefined when it says neither, or when `usd` is known (beside an `upper_bound` the server sends them too, and
 *  the bound is what is said). */
export const soFar = (c: Cost | null | undefined): (Cost & { so_far_usd: number; unpriced: number }) | undefined =>
  c && c.usd === null && typeof c.so_far_usd === "number" && typeof c.unpriced === "number" ? (c as Cost & { so_far_usd: number; unpriced: number }) : undefined;

/** Said beside a cost known so far: why it is not the whole cost (a charge with no price: a model request cut, stopped or
 *  still pending, a model with no price, a decision or a paid tool call whose cost is unknown). */
export const soFarNote = (c: { unpriced: number }, { ended = false }: { ended?: boolean } = {}) =>
  `The charges priced${ended ? "" : " so far"}. ${c.unpriced} ${c.unpriced === 1 ? "charge has" : "charges have"} no price, so this is not the whole cost.`;

/** A run's status once it has ended: its cost is said as its whole, never "so far" (cost's `ended`). */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
export const runEnded = (status: string | undefined | null): boolean => typeof status === "string" && ENDED_STATUSES.has(status);

/** A known $0 that is a free model's (the server's `free`, freemodel/1): every model request went to a model whose known
 *  price is $0 for every token. Said as the server's usage row says it. */
export const FREE_COST = "$0 · free model";
/** An ended run's cost the server could not read (its `unknown`, costunknown/1: `booking_unread`): unknown, and why. */
export const UNREAD_COST = "Unknown · cost not read";
const freeCost = (c: { usd: number | null; free?: boolean }) => c.usd === 0 && c.free === true;

/** A known cost that counts a request cut with no answer at what its cap held for it (the server's `upper_bound`,
 *  cutathold/1): the most the run can have cost, said "at most $0.25", never as the exact figure. */
const atMost = (c: { upper_bound?: boolean }) => (c.upper_bound === true ? "at most " : "");

/** A charge on a timeline row, in words: "$0.0018", or what is known so far ("so far $0.001, 1 not priced") when one of its
 *  charges has no price; on a run that has ended (`ended`), what is known without "so far" ("$0.001 known, 1 not priced"),
 *  as cost says the run's. */
export const chargeWords = (u: { usd: number | null; so_far_usd?: number; unpriced?: number; upper_bound?: boolean }, { ended = false }: { ended?: boolean } = {}): string =>
  u.usd !== null ? `${atMost(u)}${dollars(u.usd)}`
    : typeof u.so_far_usd === "number" ? (ended ? `${soFarDollars(u.so_far_usd)} known, ${u.unpriced ?? 0} not priced` : `so far ${soFarDollars(u.so_far_usd)}, ${u.unpriced ?? 0} not priced`)
    : "not priced";

/** A local estimate stays an estimate, and a cost the server does not know says so: the contract's "Null while unknown.
 *  A client shows null as unknown, never as $0" (a request cut before its answer, a cost still pending, or a model with
 *  no price). When the server says what is known so far, that is said ("so far $0.0123 · 1 not priced"), never as the
 *  whole cost; a run that has ended (`ended`) says what is known without "so far" ("$0.0123 known · 1 not priced"), as its
 *  usage row says its cost. Never a billed amount, never an invented zero. A run on the server's ChatGPT plan alone says
 *  its tokens ("41.2K tokens · Using ChatGPT plan"), never "$0.00"; one that also spent dollars says them, then "+ ChatGPT
 *  plan". A run on Claude Code's login says "on your Claude plan" in the same places. A run whose every model request went
 *  to a free model (`free`: its known price is $0 for every token) says why its cost is $0 (FREE_COST). */
export function cost(c: Cost | null | undefined, { ended = false }: { ended?: boolean } = {}): string {
  const plan = planOf(c);
  const claude = plan?.on === "claude_code";
  if (plan && c?.usd === 0) return `${compact(plan.tokens)} tokens · ${claude ? "On your Claude plan" : "Using ChatGPT plan"}`;
  const words = dollarWords(c, ended);
  return plan ? `${words} + ${claude ? "your Claude plan" : "ChatGPT plan"}` : words;
}
function dollarWords(c: Cost | null | undefined, ended: boolean): string {
  const known = soFar(c);
  const est = basisMark;
  if (known) return ended ? `${soFarDollars(known.so_far_usd)}${est(known)} known · ${known.unpriced} not priced` : `so far ${soFarDollars(known.so_far_usd)}${est(known)} · ${known.unpriced} not priced`;
  if (!c || c.usd === null) return c?.unknown === "booking_unread" ? UNREAD_COST : "Unknown";
  if (freeCost(c)) return FREE_COST;
  return `${atMost(c)}${dollars(c.usd)}${est(c)}`;
}

/** What a run used on a person's plan (chatgpt/1 `cost.plan`): its requests there, their tokens, and which plan (`on`:
 *  the ChatGPT sign-in, or Claude Code's login), which cost no dollars here; undefined for a run that made none. A run on
 *  the plan alone says its tokens, never "$0.00" (cost). */
export const planOf = (c: Cost | null | undefined): { requests: number; tokens: number; on?: "chatgpt" | "claude_code" } | undefined =>
  c?.plan && c.plan.requests > 0 ? c.plan : undefined;
/** The hover words for a run's plan requests: no dollars here, the plan's own limits. */
export const planNoDollars = (plan: { on?: string }): string => (plan.on === "claude_code" ? LOGIN_NO_DOLLARS : PLAN_NO_DOLLARS);

/** 1,284 / 12.9K / 4.2M. */
export function compact(n: number): string {
  if (n < 10_000) return n.toLocaleString("en-US");
  const [v, unit] = n < 1e6 ? [n / 1e3, "K"] : n < 1e9 ? [n / 1e6, "M"] : [n / 1e9, "B"];
  return `${v < 100 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}${unit}`;
}

/** A run's cost as its header says it, beside its spend cap when it has one (`cap`, the run's `cost.cap_usd`): "$0.0059
 *  est. of $1.00". A cost that is not one figure (unknown, or known so far with calls not priced) keeps its words, the cap
 *  after them ("Unknown · cap $1.00"). `text`: the cost already worded (a workflow run's graph totals). No cap: the cost. */
export function costOfCap(c: Cost | null | undefined, cap: number | null | undefined, { ended = false, text }: { ended?: boolean; text?: string } = {}): string {
  const shown = text ?? cost(c, { ended });
  if (typeof cap !== "number") return shown;
  // One figure ("$0.0059 est.", "<$0.0001"): "of" the cap. A partial total ("$0.0188 + 2 unknown") or a word: the cap after.
  const figure = text !== undefined ? ONE_FIGURE.test(text) : !soFar(c) && !planOf(c) && !!c && c.usd !== null && !freeCost(c);
  return figure ? `${shown} of ${capDollars(cap)}` : `${shown} · cap ${capDollars(cap)}`;
}
const ONE_FIGURE = /^<?\$[\d.,]+( est\.| reported)?$/;

/** A spend cap in dollars as it was set: two places at least ($1.00, $2.50), more when the cap has them ($0.013), so a
 *  raise finer than a cent still reads as a change. */
export function capDollars(usd: number): string {
  for (let places = 2; places < 8; places++) if (Number(usd.toFixed(places)) === usd) return `$${usd.toFixed(places)}`;
  return `$${usd.toFixed(8)}`;
}

/** The run files a run's Markdown may link to: their paths as GET /v2/runs/{id}/files lists them, and `from`, the folder
 *  of the file the Markdown is in ("" for the run's answer), which its relative links are read from. `images: false`: a
 *  share's Markdown, whose bundle carries no image: each image reads as its alt text, so no source is ever loaded. */
export type LinkedFiles = { paths: readonly string[]; from?: string; images?: false };

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

/** With images off (a shared run's page): no element or attribute the sanitizer would keep that loads a URL. An <img>
 *  stays, its source gone, to be drawn as its alt text; an SVG image, a video's poster, an image button, a picture's
 *  sources, audio, a table's background and an inline style are dropped. */
const NO_IMAGES = {
  FORBID_TAGS: ["svg", "image", "video", "audio", "picture", "source", "track", "input"],
  FORBID_ATTR: ["src", "srcset", "poster", "background", "style", "xlink:href"],
};

/** Markdown from a run, as safe HTML: parsed by marked, then sanitized (no scripts, no handlers, no foreign frames).
 *  A link with no scheme (a relative path, a path from the root, a fragment, //host) would be read against the console's
 *  own address and take its tab away (a fragment changes its route), so it is never a link here: one that names a run
 *  file in `files` becomes a button carrying `data-run-file` (the page opens the file on its click), any other reads as
 *  its text. A link to a page (http:, https:, ftp:) opens in a new tab, with no opener and no referrer; one that hands off
 *  to another app (mailto:, tel:) is as marked and the sanitizer leave it. */
export function markdown(text: string, files?: LinkedFiles): string {
  const body = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { RETURN_DOM: true, ...(files?.images === false ? NO_IMAGES : {}) }) as HTMLElement;
  if (files?.images === false) for (const img of [...body.querySelectorAll("img")]) img.replaceWith(img.getAttribute("alt") ?? "");
  // A code block wraps inside its box (a long line breaks, never runs past the page's edge).
  for (const pre of [...body.querySelectorAll("pre")]) pre.classList.add("whitespace-pre-wrap", "break-words", "[overflow-wrap:anywhere]");
  // A cut value's marker (the scrubber's `[redacted:<rule>]`) reads as a chip, its words kept.
  chipRedactions(body);
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

/** A trigger's payload's words, for a run with no input of its own before it: by the wrapper's scheme (a GitHub delivery
 *  comes in as the webhook source with scheme github, serve's triggers.ts), else its source. */
const payloadWords = (tag: string): string => {
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  return attr("scheme") === "github" || attr("source") === "github" ? "A GitHub event" : attr("source") === "webhook" ? "A webhook request" : "A trigger's request";
};

/** A run's title as the console shows it. A webhook or GitHub trigger's run (one with a `trigger`) has the trigger's input
 *  and then the request's payload inside `<trigger-payload source="…" … untrusted>` (serve's triggers.ts); its title is the
 *  input's line alone, the payload left to the Timeline. The server clips a title to 80 characters with an ellipsis
 *  (runs.ts), so the wrapper may be cut anywhere, its tag name included: everything from its opening goes. With no input
 *  before the payload, its source's words. A run no trigger started keeps its title as served. */
export function runTitle(run: { title: string; trigger?: unknown }): string {
  const { title } = run;
  if (!run.trigger) return title;
  let at = title.search(/<trigger-payload\b/);
  if (at < 0) {
    // Cut inside the tag name: a "<", "<trig", … just before the clip's ellipsis.
    const cut = /<([a-z-]*)…$/.exec(title);
    if (!cut || !"trigger-payload".startsWith(cut[1]!)) return title;
    at = cut.index;
  }
  const own = title.slice(0, at).trim();
  return own || payloadWords(title.slice(at));
}
