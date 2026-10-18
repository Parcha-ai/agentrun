import { BrowserFailureError, FenceRefusal, loadedNoPage, passedThrough, type AttachedSession, type BrowserDriver, type CustodyPort, type ToolOutput } from "./custody.js";
import { defaultInline, type EvidenceRecord, type EvidenceSink } from "./evidence.js";
import type { Decisions, PageVerdict } from "./decisions.js";
import { fetchDownloads } from "./downloads.js";
import { browserFailure, classifyBrowserError, transportFactOf, type BrowserFailure } from "./failures.js";
import type { WorkspaceFiles } from "./host.js";
import { createRepeatGuard, type RepeatGuard } from "./guard.js";
import { regionOf, type Locate } from "./clip.js";
import { captureWithinBudget, type ScreenshotOptions } from "./images.js";
import { orderFacts, receiptFacts, sha256Hex } from "./receipts.js";
import { scrubPageUrl, type Redact } from "./redact.js";
import { UNANSWERED_CALL } from "./unanswered.js";
import { pageNotice, wallFailure, wallOf, type WebFailure } from "./web.js";
import type { Geo, PendingEffectFacts, ReleaseReason } from "./host.js";

/** One action of a run's batch, as the contract's schema admits it. */
export type RunAction =
  | { op: "click"; id: string }
  | { op: "hover"; id: string }
  | { op: "fill"; id: string; value: string }
  | { op: "type"; id: string; text: string; delay?: number }
  | { op: "press"; id: string; key: string }
  | { op: "select"; id: string; values: string | string[] };

export type PageDriver = BrowserDriver & {
  snapshot(options?: { includeIframes?: boolean }): Promise<string>;
  run(input: { code?: string; actions?: RunAction[] }): Promise<unknown>;
  /** The page's URL, cheaply: no page content is read. */
  url(): Promise<string>;
  screenshot(options: ScreenshotOptions): Promise<{ data: string; mimeType: string }>;
  /** Where an element or the viewport is now (see clip.ts); an element is scrolled into view first. Absent: no region can be placed. */
  locate?: Locate;
  page(): Promise<{ url: string; title: string; text: string; html: string }>;
  setInputFiles?(selector: string, file: { name: string; mimeType: string; buffer: Uint8Array }): Promise<void>;
};

export type ToolCall = { callId: string; conversationId: number; signal: AbortSignal | undefined; label: string; redact: Redact; evidence: EvidenceSink; classifyPage?: Decisions["classifyPage"]; workspace?: string; files?: WorkspaceFiles };
export type ToolImpl<D extends BrowserDriver = BrowserDriver, A = unknown> = (args: A, port: CustodyPort<D>, call: ToolCall) => Promise<ToolOutput>;
/** Each browser tool's arguments, as its contract's schema admits them. */
export type BrowserToolArgs = {
  snapshot: { includeIframes?: boolean };
  run: { code?: string; actions?: RunAction[] };
  screenshot: { fullPage?: boolean; type?: "png" | "jpeg"; quality?: number; ask?: string; clip?: { x: number; y: number; width: number; height: number }; id?: string; selector?: string };
  browser_read: { what?: (typeof WHATS)[number] };
  browser_release: Record<string, never>;
  browser_relaunch: { verified?: boolean; geolocation?: Geo };
  browser_downloads: Record<string, never>;
  browser_upload: { path?: string; selector?: string };
};
export type BrowserToolImpls<D extends BrowserDriver = BrowserDriver> = { [K in keyof BrowserToolArgs]: ToolImpl<D, BrowserToolArgs[K]> };

type Session = AttachedSession<PageDriver>;
type Read = { body: string; extractor?: EvidenceRecord["facts"]["extractor"]; ext: string };

const WHATS = ["markdown", "text", "html", "url", "title"] as const;
const DROPPED_RUN = "The connection to your browser session dropped; the session is still open, and your next browser call reconnects to it with its pages and cookies. This run may have acted before the drop: take a snapshot to see the page before running again.";
const DROPPED_FOR_GOOD = "The connection to your browser session dropped and could not be re-established, though the session is still open. Call browser_relaunch for a fresh session (its pages and cookies are gone), or use web_fetch.";
const HUNG_PAGE = "After a fresh connection to your browser session, the page still did not answer this call: the page itself is stuck, not the browser. Call browser_relaunch for a fresh session (its pages and cookies are gone), then open the page again.";
const text = (value: unknown, isError = false): ToolOutput =>
  ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const withNews = (news: string, body: string) => (news ? `${news}\n\n${body}` : body);
const refused = (message: string): BrowserFailure => ({ ok: false, code: "refused", retryable: false, effect: "none", message });

/** A read of a browser that has loaded no page yet: it is fresh, and the next step is to navigate, to the replaced
 *  session's last page when there is one. */
function freshBrowser(replaced: AttachedSession<unknown>["replaced"]): WebFailure {
  const why = replaced ? `it replaced the session released${replaced.at ? ` at ${replaced.at}` : ""} (${replaced.reason})` : "it was just opened";
  const go = replaced?.lastUrl ? `Navigate to the last page, ${replaced.lastUrl}, with run, then read again.` : "Navigate to the page you need with run, then read again.";
  return { ok: false, code: "not_content", retryable: true, effect: "none", message: `This browser is fresh and has loaded no page yet: ${why}. ${go}`, detail: "", next: { action: "drive_page", note: go } };
}
const pageUrl = (call: ToolCall, raw: string): string => scrubPageUrl(raw, call.redact);
type Cut = NonNullable<Session["interrupted"]>;
/** How a page tool meets custody's journal: a replay-unsafe action carries its key; a look clears a refused cut. */
type Kind = { effect: string } | "look" | "read";
/** The refusal of an identical replay-unsafe action, by tool. */
const SAME: Record<string, string> = {
  run: "This is the same code, and it may already have taken effect, so it is not run again now: look at the page with snapshot or browser_read before you run this again.",
  browser_upload: "This is the same upload, and it may already have taken effect, so it is not repeated now: look at the page with snapshot or browser_read before you upload it again.",
};

/** A cut run that was observed and sent nothing that left the browser is safe to run again. */
const harmless = (p: Cut) => p.observed === true && !(p.sent ?? []).some((r) => r.held !== "denied");

function interruptedNotice(p: Cut, now: string): string {
  const where = `Your ${p.tool ?? "run"} call ${p.callId}${p.url ? ` on ${p.url}` : ""}`;
  const sent = (p.sent ?? []).filter((r) => r.held !== "denied").map((r) => `${r.method} ${r.origin}${r.path}`);
  if (p.finished) {
    const head = `${where} ran, but the process stopped before its answer reached you`;
    if (harmless(p)) return `${head}; it sent no request that changes anything, so it is safe to run again. The page is now ${now}.`;
    if (sent.length) return `${head}, after it sent ${sent.join(", ")}; the page is now ${now}. Check on the page whether that landed before acting again, and do not send it again if it did.`;
    return `${head}, so what it did has taken effect; the page is now ${now}. Look at it with snapshot before acting again.`;
  }
  const head = `${where} was interrupted`;
  if (harmless(p)) return `${head} before it sent any request that changes anything; it is safe to run again. The page is now ${now}.`;
  if (sent.length) return `${head} after it sent ${sent.join(", ")}; the page is now ${now}. Check on the page whether that landed before acting again, and do not send it again if it did.`;
  return `${head} and may have taken effect; the page is now ${now}. Check it with snapshot before acting again.`;
}

const factsOf = (p: Cut, now: string): PendingEffectFacts => ({
  callId: p.callId, urlAtDispatch: p.url, urlNow: now, observed: p.observed === true,
  sent: p.watched ? (p.sent ?? []).map((r) => ({ method: r.method, url: `${r.origin}${r.path}`, held: r.held })) : null,
});

async function markdown(html: string, fallback: string): Promise<Read> {
  try {
    const [{ parse }, { NodeHtmlMarkdown }] = await Promise.all([import("node-html-parser"), import("node-html-markdown")]);
    const root = parse(html);
    const main = root.querySelector("article") ?? root.querySelector("main") ?? root.querySelector("body") ?? root;
    const md = NodeHtmlMarkdown.translate(main.toString(), { keepDataImages: false });
    if (md.trim()) return { body: md, extractor: "readability-md", ext: "md" };
  } catch {}
  return { body: fallback, extractor: "inner-text", ext: "txt" };
}

/** `guards` holds each conversation's repeat guard; a host that owns the conversation's lifecycle passes it to evict one. */
export function pageTools({ guards = new Map<number, RepeatGuard>() }: { guards?: Map<number, RepeatGuard> } = {}): Pick<BrowserToolImpls<PageDriver>, "snapshot" | "run" | "screenshot" | "browser_read" | "browser_upload" | "browser_downloads"> {
  const guardOf = (conversationId: number) => guards.get(conversationId) ?? guards.set(conversationId, createRepeatGuard()).get(conversationId)!;

  async function failureOf(error: unknown, effectful: boolean, port: CustodyPort<PageDriver>, call: ToolCall, action?: string): Promise<BrowserFailure> {
    if (error instanceof BrowserFailureError) return error.failure;
    const facts = { aborted: call.signal?.aborted === true, action };
    const first = classifyBrowserError(error, effectful, facts);
    if (first.code === "aborted" || first.code === "auth" || !(await port.ended().catch(() => false))) return first;
    return classifyBrowserError(error, effectful, { ...facts, sessionEnded: true });
  }

  /** A replay-unsafe action is journaled before it acts and marked finished after; the entry stays until a later call
   *  settles it, so a process that dies before pi commits the answer leaves a cut for the resumed run. One that a hold
   *  fenced before any of its driver calls got through never reached the page: its entry is settled at once, as not sent,
   *  so no look is owed for it in this process or a resumed one. */
  async function dispatched(tool: string, port: CustodyPort<PageDriver>, call: ToolCall, s: Session, key: string, action: () => Promise<ToolOutput>): Promise<ToolOutput> {
    await port.dispatching({ callId: call.callId, ...(tool === "browser_upload" ? { tool } : {}), codeSha: key, url: s.record.lastUrl, observed: s.effects?.holding === true, watched: s.effects != null });
    const before = passedThrough(s.driver);
    let notSent = false;
    try { return await action(); } catch (error) {
      notSent = error instanceof FenceRefusal && before !== null && passedThrough(s.driver) === before;
      throw error;
    } finally { await (notSent ? port.settle(call.callId) : port.mark("finished", call.callId)).catch(() => undefined); }
  }

  async function perform(tool: string, args: unknown, port: CustodyPort<PageDriver>, call: ToolCall, kind: Kind, body: (s: Session, news: string) => Promise<ToolOutput>): Promise<ToolOutput> {
    const effect = typeof kind === "object" ? kind.effect : null;
    const effectful = effect !== null;
    const action = effectful && tool !== "run" ? `Your ${tool} call` : undefined;
    const guard = guardOf(call.conversationId);
    const refused = guard.check(tool, args);
    if (refused) return text(refused, true);
    // A cut is told once, on the call after it, whatever that call ends in. An identical action is refused until a look
    // that follows the refusal settles the cut.
    let news = "";
    let cut: Cut | null = null;
    let facts: PendingEffectFacts | null = null;
    // The first call after a release the model did not ask for: by what and when, beside the notice that says it.
    let previous: { released: true; reason: ReleaseReason; at: string | null } | null = null;
    const tell = (out: ToolOutput): ToolOutput => (facts || previous ? { ...out, details: { ...(out.details as object | undefined), ...(facts ? { pendingEffect: facts } : {}), ...(previous ? { previous_session: previous } : {}) } } : out);
    const done = (out: ToolOutput) => { guard.note(tool, args, null); return tell(out); };
    // The notice leads a failure, never after its own keys: a call told nothing else first reads it.
    const fail = (failure: BrowserFailure) => { guard.note(tool, args, failure); return tell(text(news ? { notice: news, ...(previous ? { previous_session: previous } : {}), ...failure } : failure, true)); };
    const looked = async (out: ToolOutput) => { if (kind === "look" && cut?.refused) await port.settle(cut.callId); return done(out); };
    try {
      const s = await port.session();
      news = s.notice ?? "";
      if (s.notice && s.replaced) previous = { released: true, reason: s.replaced.reason, at: s.replaced.at };
      cut = s.interrupted;
      const same = cut !== null && effect === cut.codeSha && !harmless(cut);
      if (cut && (!cut.told || same)) facts = factsOf(cut, pageUrl(call, await s.driver.url().catch(() => "gone")));
      if (cut && !cut.told) {
        news = [news, interruptedNotice(cut, facts!.urlNow)].filter(Boolean).join(" ");
        await (harmless(cut) ? port.settle(cut.callId) : port.mark("told", cut.callId));
      }
      if (cut && same) {
        await port.mark("refused", cut.callId);
        return done(text(browserFailure("effect_unknown", `${news ? `${news} ` : ""}${SAME[tool] ?? SAME.run}`, { retryable: true, effect: "possibly_effected" }), true));
      }
      return await looked(effect === null ? await body(s, news) : await dispatched(tool, port, call, s, effect, () => body(s, news)));
    } catch (error) {
      const failure = await failureOf(error, effectful, port, call, action);
      if (failure.code !== "browser_unavailable" || error instanceof BrowserFailureError) return fail(failure);
      // A dropped CDP connection to a session the provider still runs: a read reconnects and runs once more; a run, which
      // may have acted, is not repeated.
      await port.dropped().catch(() => undefined);
      if (effectful) return fail({ ...failure, retryable: true, message: DROPPED_RUN });
      let again: Session;
      try { again = await port.session(); } catch (reconnect) {
        const refused = await failureOf(reconnect, effectful, port, call, action);
        return fail(refused.code === "aborted" || refused.code === "auth" ? refused : { ...refused, code: "browser_unavailable", retryable: false, message: DROPPED_FOR_GOOD });
      }
      try { return await looked(await body(again, news)); } catch (retried) {
        const failure = await failureOf(retried, effectful, port, call, action);
        // The browser answered the reconnect, so a call it leaves unanswered again is the page's, not an unreachable browser.
        return fail(failure.code === "browser_unavailable" && transportFactOf(retried).errorName === UNANSWERED_CALL ? { ...failure, retryable: false, message: HUNG_PAGE } : failure);
      }
    }
  }

  async function file(s: Session, call: ToolCall, record: Omit<EvidenceRecord, "facts"> & { facts: Omit<EvidenceRecord["facts"], "sha256"> }) {
    const facts = orderFacts({ ...record.facts, ...receiptFacts({ body: record.body, session: s.record, recorded: s.recorded }) });
    const filed = await call.evidence.file(call.label, { ...record, facts });
    return { path: filed?.path ?? null, bodyLine: filed?.bodyLine ?? null, bodyPath: filed?.bodyPath ?? null, sha256: facts.sha256 };
  }

  return {
    snapshot: (args, port, call) => perform("snapshot", args ?? {}, port, call, "look", async (s, news) => text(withNews(news, await s.driver.snapshot(args ?? {})))),

    run: async (args, port, call) => {
      if ((args?.code === undefined) === (args?.actions === undefined)) {
        return text(browserFailure("refused", "run requires exactly one of code or actions"), true);
      }
      const codeSha = sha256Hex(JSON.stringify(args.code ?? args.actions));
      return perform("run", args, port, call, { effect: codeSha }, async (s, news) => {
        const sent: Array<{ method: string; url: string; held: string | null }> = [];
        const stop = s.effects?.record((row) => { sent.push({ method: row.method, url: call.redact(`${row.origin}${row.path}`), held: row.held }); return port.journal(row); });
        let value: unknown;
        try {
          value = await s.driver.run(args.code !== undefined ? { code: args.code } : { actions: args.actions });
        } finally {
          await s.effects?.flush(call.signal).catch(() => undefined);
          stop?.();
        }
        const url = await s.driver.url().catch(() => null);
        // Compared as custody keeps it, so a page with a query value never looks new on every run.
        if (url && scrubPageUrl(url, call.redact) !== s.record.lastUrl) await port.navigated(url);
        const reported = args.actions !== undefined && value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string" ? { ...(value as object), url: pageUrl(call, (value as { url: string }).url) } : value;
        const shown = typeof reported === "string" ? reported : reported === undefined ? "(run completed; no return value)" : JSON.stringify(reported, null, 2) ?? String(reported);
        return { ...text(withNews(news, shown)), ...(sent.length ? { details: { sent } } : {}) };
      });
    },

    screenshot: (args, port, call) => {
      const { ask: asked, clip: wantedClip, id: wantedId, selector: wantedSelector, ...requested } = args ?? {};
      const ask = typeof asked === "string" && asked.trim() ? asked.trim() : undefined;
      return perform("screenshot", args ?? {}, port, call, "read", async (s, news) => {
        // A region goes through the same capture as the whole page, so whatever guards a capture guards a clipped one.
        const region = await regionOf({ clip: wantedClip, id: wantedId, selector: wantedSelector, fullPage: requested.fullPage }, s.driver.locate?.bind(s.driver));
        const shot = await captureWithinBudget((options) => s.driver.screenshot(options), region ? { ...requested, fullPage: false, clip: region.clip } : requested);
        const url = pageUrl(call, await s.driver.url());
        const receipt = await file(s, call, { tool: "screenshot", args: region ? { ...requested, clip: region.clip, ...region.of } : requested, status: "ok", facts: { final_url: url }, body: Buffer.from(shot.data, "base64"), ext: shot.size.type === "png" ? "png" : "jpg" });
        const first = shot.adjusted?.first;
        const adjusted = shot.adjusted && `adjusted: the first capture${first ? ` (${first.width}x${first.height})` : ""} was over the ${shot.adjusted.why === "long_edge" ? "2,000 px long edge" : "size"} budget; this is ${region ? "the clip" : "the viewport"} at ${shot.size.width}x${shot.size.height}`;
        const lines = [news, `url: ${url}`, `evidence: ${receipt.path ?? "(not filed)"}`, adjusted].filter(Boolean).join("\n");
        const media = { kind: "screenshot", path: receipt.bodyPath, mime: shot.mimeType, bytes: Buffer.from(shot.data, "base64").byteLength, width: shot.size.width, height: shot.size.height, ...(region ? { clip: region.clip, ...region.of } : {}), ...(ask ? { ask } : {}) };
        return { content: [{ type: "text", text: lines }, { type: "image", data: shot.data, mimeType: shot.mimeType }], details: { evidence: receipt.path, sha256: receipt.sha256, media } };
      });
    },

    browser_read: (args, port, call) => {
      const what = args?.what && WHATS.includes(args.what) ? args.what : "markdown";
      return perform("browser_read", { what }, port, call, "look", async (s, news) => {
        const page = await s.driver.page();
        // A browser that has loaded no page yet, on an about:blank nothing has written into, is fresh, not walled: it says
        // so, and where to go. A script that wrote a title or text into about:blank made a page, which is read.
        if (page.url === "about:blank" && loadedNoPage(s.record) && !page.title.trim() && !page.text.trim()) throw new BrowserFailureError(freshBrowser(s.replaced ?? null));
        const read: Read = what === "markdown" ? await markdown(page.html, page.text)
          : what === "html" ? { body: page.html, extractor: "raw", ext: "html" }
          : what === "text" ? { body: page.text, extractor: "inner-text", ext: "txt" }
          : { body: what === "url" ? pageUrl(call, page.url) : page.title, ext: "txt" };
        const body = call.redact(read.body);
        const [url, title] = [pageUrl(call, page.url), call.redact(page.title)];
        const verdict = call.classifyPage ? await call.classifyPage({ url, status: null, contentType: "text/html", text: page.text }).catch((): PageVerdict => ({ wall: "unjudged", injection: null, confidence: null })) : null;
        const wall = wallOf(verdict);
        const facts = { final_url: url, title, ...(read.extractor ? { extractor: read.extractor } : {}), via: "browser", ...(verdict?.guard ? { page_guard: call.redact(verdict.guard) } : {}) };
        const receipt = await file(s, call, { tool: "browser_read", args: { what }, status: wall ? "failed" : "ok", facts, body, ext: read.ext });
        if (wall) throw new BrowserFailureError({ ...wallFailure(`The browser is on ${url}`, wall, call.redact(page.text)), evidence: receipt.path } as BrowserFailure);
        const prefix = `${news ? `${news}\n\n` : ""}url: ${url}\ntitle: ${title}\n${pageNotice(verdict)}evidence: ${receipt.path ?? "(not filed)"}\n---\n`;
        const shown = call.evidence.inline ? call.evidence.inline(body, { path: receipt.path, bodyLine: receipt.bodyLine, prefix, filed: body }) : defaultInline(body, { path: receipt.path, prefix });
        return { content: [{ type: "text", text: shown }], details: { evidence: receipt.path, sha256: receipt.sha256, url } };
      });
    },

    browser_upload: async (args, port, call) => {
      const asked = typeof args?.path === "string" ? args.path : "";
      const selector = typeof args?.selector === "string" ? args.selector.trim() : "";
      if (!call.files) return text(refused("This host gives the browser no workspace to upload from."), true);
      if (!selector) return text(refused("selector must name the page's file input."), true);
      // The host resolves the path before any browser call, so a refused file never reaches the page.
      const file = await call.files.resolve(asked);
      if ("refused" in file) return text(refused(`browser_upload refused the file: ${file.refused}.`), true);
      const uploaded = { name: file.name, bytes: file.bytes.byteLength, sha256: sha256Hex(file.bytes) };
      const codeSha = sha256Hex(JSON.stringify({ upload: selector, sha256: uploaded.sha256 }));
      // A page can send the file once its input changes: an upload is journaled like a run and never repeated.
      return perform("browser_upload", { path: asked, selector }, port, call, { effect: codeSha }, async (s, news) => {
        if (!s.driver.setInputFiles) throw new BrowserFailureError(refused("This browser driver cannot set a file input."));
        const sent: Array<{ method: string; url: string; held: string | null }> = [];
        const stop = s.effects?.record((row) => { sent.push({ method: row.method, url: call.redact(`${row.origin}${row.path}`), held: row.held }); return port.journal(row); });
        try {
          await s.driver.setInputFiles(selector, { name: file.name, mimeType: file.mime, buffer: file.bytes });
        } finally {
          await s.effects?.flush(call.signal).catch(() => undefined);
          stop?.();
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, uploaded, selector, ...(news ? { notice: news } : {}) }) }], details: { uploaded, ...(sent.length ? { sent } : {}) } };
      });
    },

    browser_downloads: (args, port, call) => perform("browser_downloads", {}, port, call, "read", async (s, news) => {
      if (!call.workspace) throw new BrowserFailureError(refused("This host gives the browser no workspace to copy downloads into."));
      if (!s.downloads) throw new BrowserFailureError(refused("This browser provider cannot list the files its sessions download."));
      const result = await fetchDownloads({ provider: { downloads: s.downloads }, ref: { id: s.sessionId, tag: s.tag }, session: s.sessionId, workspace: call.workspace });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...result, ...(news ? { notice: news } : {}) }) }], details: { downloads: result } };
    }),
  };
}
