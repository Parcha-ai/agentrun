// The page tools: snapshot, run, screenshot and browser_read, each over the custody port. Custody decides which
// browser a call gets; these decide what the call does on its page and what the model is told. Every call first tells
// custody's news (a session kept or lost, a run an interruption cut); a run identical to the one that was cut is
// refused once; failures come back as the typed envelope, and the third identical failure is refused.
import { BrowserFailureError, type AttachedSession, type BrowserDriver, type CustodyPort, type ToolOutput } from "./custody.js";
import { defaultInline, type EvidenceRecord, type EvidenceSink } from "./evidence.js";
import type { Decisions, PageVerdict } from "./decisions.js";
import { classifyBrowserError, type BrowserFailure } from "./failures.js";
import { createRepeatGuard, type RepeatGuard } from "./guard.js";
import { captureWithinBudget, type ScreenshotOptions } from "./images.js";
import { orderFacts, receiptFacts, sha256Hex } from "./receipts.js";
import { scrubPageUrl, type Redact } from "./redact.js";
import { pageNotice, wallFailure, wallOf } from "./web.js";

/** What the page tools need of a driver, besides custody's `close`. */
export type PageDriver = BrowserDriver & {
  snapshot(options?: { includeIframes?: boolean }): Promise<string>;
  run(input: { code?: string; actions?: unknown[] }): Promise<unknown>;
  /** The page's URL, cheaply: no page content is read. */
  url(): Promise<string>;
  screenshot(options: ScreenshotOptions): Promise<{ data: string; mimeType: string }>;
  page(): Promise<{ url: string; title: string; text: string; html: string }>;
};

/** What one call carries besides its arguments: where its reads are filed, under which label, the scrubber every
 *  filed body and every result passes, and the host's page judge. */
export type ToolCall = { callId: string; conversationId: number; signal: AbortSignal | undefined; label: string; redact: Redact; evidence: EvidenceSink; classifyPage?: Decisions["classifyPage"] };
export type ToolImpl<D extends BrowserDriver = BrowserDriver> = (args: any, port: CustodyPort<D>, call: ToolCall) => Promise<ToolOutput>;

type Session = AttachedSession<PageDriver>;
type Read = { body: string; extractor?: EvidenceRecord["facts"]["extractor"]; ext: string };

const WHATS = ["markdown", "text", "html", "url", "title"] as const;
const text = (value: unknown, isError = false): ToolOutput =>
  ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const withNews = (news: string, body: string) => (news ? `${news}\n\n${body}` : body);
/** A cut run that was observed and sent nothing that left the browser is safe to run again. */
const harmless = (p: NonNullable<Session["interrupted"]>) => p.observed === true && !(p.sent ?? []).some((r) => r.held !== "denied");

/** What the model is told about a run an interruption cut: what its journal says it sent, or that it is unknown. */
function interruptedNotice(p: NonNullable<Session["interrupted"]>, now: string): string {
  const head = `Your run call ${p.callId}${p.url ? ` on ${p.url}` : ""} was interrupted`;
  if (harmless(p)) return `${head} before it sent any request that changes anything; it is safe to run again. The page is now ${now}.`;
  const sent = (p.sent ?? []).filter((r) => r.held !== "denied").map((r) => `${r.method} ${r.origin}${r.path}`);
  if (sent.length) return `${head} after it sent ${sent.join(", ")}; the page is now ${now}. Check on the page whether that landed before acting again, and do not send it again if it did.`;
  return `${head} and may have taken effect; the page is now ${now}. Check it with snapshot before acting again.`;
}

/** The page's main content (article, else main, else body) as markdown; its text when that is empty or fails. */
async function markdown(html: string, fallback: string): Promise<Read> {
  try {
    const [{ parse }, { NodeHtmlMarkdown }] = await Promise.all([import("node-html-parser"), import("node-html-markdown")]);
    const root = parse(html);
    const main = root.querySelector("article") ?? root.querySelector("main") ?? root.querySelector("body") ?? root;
    const md = NodeHtmlMarkdown.translate(main.toString(), { keepDataImages: false });
    if (md.trim()) return { body: md, extractor: "readability-md", ext: "md" };
  } catch { /* the text below is the page as rendered */ }
  return { body: fallback, extractor: "inner-text", ext: "txt" };
}

export function pageTools(): Record<"snapshot" | "run" | "screenshot" | "browser_read", ToolImpl<PageDriver>> {
  const guards = new Map<number, RepeatGuard>();
  const guardOf = (conversationId: number) => guards.get(conversationId) ?? guards.set(conversationId, createRepeatGuard()).get(conversationId)!;

  async function failureOf(error: unknown, effectful: boolean, port: CustodyPort<PageDriver>, call: ToolCall): Promise<BrowserFailure> {
    if (error instanceof BrowserFailureError) return error.failure;
    const facts = { aborted: call.signal?.aborted === true };
    const first = classifyBrowserError(error, effectful, facts);
    if (first.code === "aborted" || first.code === "auth" || !(await port.ended().catch(() => false))) return first;
    return classifyBrowserError(error, effectful, { ...facts, sessionEnded: true });
  }

  /** One call: the repeat guard, the session, custody's news (a cut run is told once, then settled), the body. */
  async function perform(tool: string, args: unknown, port: CustodyPort<PageDriver>, call: ToolCall, effectful: boolean, body: (s: Session, news: string) => Promise<ToolOutput>): Promise<ToolOutput> {
    const guard = guardOf(call.conversationId);
    const refused = guard.check(tool, args);
    if (refused) return text(refused, true);
    // Custody's news is told on this call whatever it ends in: a cut run is settled once it has been told.
    let news = "";
    try {
      const s = await port.session();
      news = s.notice ?? "";
      if (s.interrupted) {
        const now = call.redact(await s.driver.url().catch(() => "gone"));
        news = [news, interruptedNotice(s.interrupted, now)].filter(Boolean).join(" ");
        await port.settle();
      }
      const out = await body(s, news);
      guard.note(tool, args, null);
      return out;
    } catch (error) {
      const failure = await failureOf(error, effectful, port, call);
      guard.note(tool, args, failure);
      return text(news ? { ...failure, notice: news } : failure, true);
    }
  }

  /** File `read` as evidence and return its receipt path and the facts it was filed with. */
  async function file(s: Session, call: ToolCall, record: Omit<EvidenceRecord, "facts"> & { facts: Omit<EvidenceRecord["facts"], "sha256"> }) {
    const facts = orderFacts({ ...record.facts, ...receiptFacts({ body: record.body, session: s.record, recorded: s.recorded }) });
    const filed = await call.evidence.file(call.label, { ...record, facts });
    return { path: filed?.path ?? null, bodyLine: filed?.bodyLine ?? null, sha256: facts.sha256 };
  }

  return {
    snapshot: (args, port, call) => perform("snapshot", args ?? {}, port, call, false, async (s, news) => text(withNews(news, await s.driver.snapshot(args ?? {})))),

    run: async (args, port, call) => {
      if ((args?.code === undefined) === (args?.actions === undefined)) {
        return text({ ok: false, code: "refused", retryable: false, effect: "none", message: "run requires exactly one of code or actions" }, true);
      }
      const codeSha = sha256Hex(JSON.stringify(args.code ?? args.actions));
      return perform("run", args, port, call, true, async (s, news) => {
        if (s.interrupted?.codeSha === codeSha && !harmless(s.interrupted)) {
          return text({ ok: false, code: "effect_unknown", retryable: true, effect: "possibly_effected", message: `${news} This is the same code, so it is not run again now: check whether it landed, then call run again only if it did not.` }, true);
        }
        await port.dispatching({ callId: call.callId, codeSha, url: s.record.lastUrl, observed: s.effects?.holding === true });
        // What the run sends is committed as the observer sees it, so an interruption leaves a journal behind.
        const sent: Array<{ method: string; url: string; held: string | null }> = [];
        const stop = s.effects?.record((row) => { sent.push({ method: row.method, url: call.redact(`${row.origin}${row.path}`), held: row.held }); return port.journal(row); });
        let value: unknown;
        try {
          value = await s.driver.run(args.code !== undefined ? { code: args.code } : { actions: args.actions });
        } finally {
          await s.effects?.flush(call.signal).catch(() => undefined);
          stop?.();
          await port.settle();
        }
        const url = await s.driver.url().catch(() => null);
        // Compared as custody keeps it: a page with a query value never looks new on every run.
        if (url && scrubPageUrl(url, call.redact) !== s.record.lastUrl) await port.navigated(url);
        const shown = typeof value === "string" ? value : value === undefined ? "(run completed; no return value)" : JSON.stringify(value, null, 2) ?? String(value);
        return { ...text(withNews(news, shown)), ...(sent.length ? { details: { sent } } : {}) };
      });
    },

    screenshot: (args, port, call) => {
      const { ask: _ask, ...requested } = args ?? {};
      return perform("screenshot", args ?? {}, port, call, false, async (s, news) => {
        const shot = await captureWithinBudget((options) => s.driver.screenshot(options), requested);
        const url = call.redact(await s.driver.url());
        const receipt = await file(s, call, { tool: "screenshot", args: requested, status: "ok", facts: { final_url: url }, body: Buffer.from(shot.data, "base64"), ext: shot.size.type === "png" ? "png" : "jpg" });
        const first = shot.adjusted?.first;
        const adjusted = shot.adjusted && `adjusted: the first capture${first ? ` (${first.width}x${first.height})` : ""} was over the ${shot.adjusted.why === "long_edge" ? "2,000 px long edge" : "size"} budget; this is the viewport at ${shot.size.width}x${shot.size.height}`;
        const lines = [news, `url: ${url}`, `evidence: ${receipt.path ?? "(not filed)"}`, adjusted].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: lines }, { type: "image", data: shot.data, mimeType: shot.mimeType }], details: { evidence: receipt.path, sha256: receipt.sha256 } };
      });
    },

    browser_read: (args, port, call) => {
      const what = WHATS.includes(args?.what) ? args.what as (typeof WHATS)[number] : "markdown";
      return perform("browser_read", { what }, port, call, false, async (s, news) => {
        const page = await s.driver.page();
        const read: Read = what === "markdown" ? await markdown(page.html, page.text)
          : what === "html" ? { body: page.html, extractor: "raw", ext: "html" }
          : what === "text" ? { body: page.text, extractor: "inner-text", ext: "txt" }
          : { body: what === "url" ? page.url : page.title, ext: "txt" };
        const body = call.redact(read.body);
        const [url, title] = [call.redact(page.url), call.redact(page.title)];
        // The same judge as web_fetch, on the text a visitor sees: a wall is filed `failed`, never cited, and the
        // model gets its class and the way out.
        const verdict = call.classifyPage ? await call.classifyPage({ url: page.url, status: null, contentType: "text/html", text: page.text }).catch((): PageVerdict => ({ wall: "unjudged", injection: null, confidence: null })) : null;
        const wall = wallOf(verdict);
        const facts = { final_url: url, title, ...(read.extractor ? { extractor: read.extractor } : {}), via: "browser", ...(verdict?.guard ? { page_guard: call.redact(verdict.guard) } : {}) };
        const receipt = await file(s, call, { tool: "browser_read", args: { what }, status: wall ? "failed" : "ok", facts, body, ext: read.ext });
        // A wall is a failure like any other: the repeat guard counts it.
        if (wall) throw new BrowserFailureError({ ...wallFailure(`The browser is on ${url}`, wall, call.redact(page.text)), evidence: receipt.path } as BrowserFailure);
        const prefix = `${news ? `${news}\n\n` : ""}url: ${url}\ntitle: ${title}\n${pageNotice(verdict)}evidence: ${receipt.path ?? "(not filed)"}\n---\n`;
        const shown = call.evidence.inline ? call.evidence.inline(body, { path: receipt.path, bodyLine: receipt.bodyLine, prefix, filed: body }) : defaultInline(body, { path: receipt.path, prefix });
        return { content: [{ type: "text", text: shown }], details: { evidence: receipt.path, sha256: receipt.sha256 } };
      });
    },
  };
}
