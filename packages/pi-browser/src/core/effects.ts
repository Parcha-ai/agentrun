// Nothing about a request leaves this module but its method, origin, path, query-key and form-field names: never a
// body, a header or a value.
import { openDial } from "./dial.js";
import type { Decisions, EffectRequest, EffectVerdict } from "./decisions.js";
import type { AttachTarget, ObserverFailure, SentEffect } from "./host.js";

/** What a request judged irreversible (or not judged) meets: sent, refused, or the host's answer. */
export type ActionPolicy = "allow" | "deny" | "ask";
/** `held` is the decision when the observer held it (`pending` while deciding), null when it went out unheld. */
export type EffectRow = SentEffect;
export type EffectDecision = { allow: boolean; verdict: EffectVerdict | null };
export type EffectDecider = (request: EffectRequest) => Promise<EffectDecision>;
/** A request the browser lost before it was sent: the same fields a journal row holds, never a body, header or query. */
export type LostEffect = { requestId: string; method: string; origin: string; path: string };

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSIONS = new Set(["page", "iframe", "worker", "service_worker", "shared_worker"]);
const HARMLESS = { irreversibleBelow: 0.5, atLeast: 0.7 };
const REFUSED: EffectDecision = { allow: false, verdict: null };
const EXTENSION = "chrome-extension://";
/** The run code's own words in `trigger`, so a host asked about the request knows where it came from. */
const RUN_CODE = "run code";
/** How often the network service's pid is asked for while a request waits for its pause. */
const SERVICE_POLL_MS = 250;
/** How long a browser that never named a network service may go on naming none before it is taken to have none of its own. */
const NO_SERVICE_MS = 2_000;
/** How long a known network service may be missing, its successor not yet shown, before what it carried is told lost. */
const SERVICE_GONE_MS = 10_000;
/** How long one question about the network service may go unanswered: a timeout is no answer, never a restart. */
const ASK_MS = 1_000;
/** Unanswered questions in a row after which the watch waits for a new held request before it asks again. */
const UNANSWERED_STALL = 3;
/** The least time between two questions: requests announced meanwhile share the next one. */
const ASK_GAP_MS = 50;
/** `frameId`: a Document request's frame, so a form lost by its intent and by its request is told once. */
/** `sent`: a redirect hop, whose first hop went out, so it is never told "not sent". */
type Announced = { sessionId: string; seq: number; method: string; url: string; frameId?: string; sent?: boolean };

/** A journal row's id: the request's own for its first hop, and one per redirect hop after it, so a hop never replaces the row before it. */
const rowId = (id: string, hop: number): string => (hop > 1 ? `${id}#${hop}` : id);

/** An extension's pages (its offscreen document, its wake page) send nothing a model chose; its service worker is where
 *  run code executes, and is watched like a page. */
const ownsExtensionPage = (type: string, url: string): boolean => url.startsWith(EXTENSION) && type !== "service_worker";
/** A request to an extension's own files goes nowhere a model chose. */
const isOwnTraffic = (url: string): boolean => url.startsWith(EXTENSION);

/** Judgments are memoized per request shape, so a page that beacons every second costs one question; `ask` approvals
 *  are not. No judge, a null answer or a failure leaves the request judged irreversible. */
export function effectDecider(policy: ActionPolicy, decisions: Pick<Decisions, "judgeEffect" | "approveEffect"> = {}): EffectDecider {
  const judged = new Map<string, Promise<EffectVerdict | null>>();
  return async (request) => {
    const key = JSON.stringify([request.method, request.origin, request.path, [...request.queryKeys].sort(), [...request.formFields].sort()]);
    if (!judged.has(key)) judged.set(key, decisions.judgeEffect ? decisions.judgeEffect(request).catch(() => null) : Promise.resolve(null));
    const verdict = await judged.get(key)!;
    const harmless = verdict !== null && verdict.irreversible < HARMLESS.irreversibleBelow && (verdict.telemetry >= HARMLESS.atLeast || verdict.queryOnly >= HARMLESS.atLeast);
    if (harmless || policy === "allow") return { allow: true, verdict };
    if (policy === "deny" || !decisions.approveEffect) return { allow: false, verdict };
    return { allow: await decisions.approveEffect(request, verdict).catch(() => false), verdict };
  };
}

export function describeRequest(method: string, url: string, postData?: string, headers: Record<string, string> = {}): EffectRequest {
  const u = new URL(url);
  const type = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  let formFields: string[] = [];
  if (postData && type.includes("application/x-www-form-urlencoded")) formFields = [...new URLSearchParams(postData).keys()];
  else if (postData && type.includes("json")) try { const body = JSON.parse(postData); if (body && typeof body === "object" && !Array.isArray(body)) formFields = Object.keys(body); } catch {}
  return { method, origin: u.origin, path: u.pathname, queryKeys: [...new Set(u.searchParams.keys())], formFields, pageTitle: null, trigger: null, task: null };
}

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

const failed = (code: ObserverFailure, message: string): Error => Object.assign(new Error(message), { observerCode: code });
const CODES: readonly ObserverFailure[] = ["attach_refused", "cdp_closed", "cdp_error", "attach_failed"];
/** The code of an observer failure (`attach_failed` when untagged). Never reads the message. */
export const observerFailure = (error: unknown): ObserverFailure => {
  const code = (error as { observerCode?: unknown } | null)?.observerCode;
  return CODES.find((c) => c === code) ?? "attach_failed";
};

export class EffectObserver {
  private next = 1;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private readonly sessions = new Map<string, { targetId: string; type: string; url: string; holds: boolean }>();
  private readonly rows = new Map<string, EffectRow>();
  private listener: ((row: EffectRow) => unknown) | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  /** Announced by `Network.requestWillBeSent` (in order with page commands) but not yet paused by `Fetch.requestPaused`
   *  (which can lag). A holding session journals only at the pause, so `flush` waits for these. */
  private readonly announced = new Map<string, Announced>();
  /** By network id, how many times a holding session paused a non-GET request (once per redirect hop), so a late
   *  announcement of a hop already paused is never taken for a request still on its way. */
  private readonly pauses = new Map<string, number>();
  /** By network id, how many hops of a non-GET request were announced: a redirect announces the same id again. */
  private readonly hops = new Map<string, number>();
  /** Allowed requests, continued and not yet answered: until the response's head says whether the request redirects (its
   *  next hop is then announced) or ends, a flush waits for them, so a redirect's next hop is decided under the same call. */
  private readonly responding = new Map<string, { sessionId: string; seq: number; hop: number }>();
  private respondSeq = 0;
  private lastAskAt = 0;
  /** Chrome's network service runs in a process of its own. When it dies, Chrome starts another, and a request the dead one
   *  carried before its pause is gone: it was never sent (a holding session sends nothing it has not paused), and the page
   *  may never hear of it. While an announced request waits for its pause, the service's pid is asked for (never when
   *  nothing waits); a new pid means the requests announced before the old one was last seen, and still unpaused, were lost
   *  with it. `confirmedSeq`: how far `announceSeq` had got when the old pid was last asked for. */
  private servicePid: number | null = null;
  private confirmedSeq = 0;
  /** How far `announceSeq` had got when the service was last asked, whatever it answered. */
  private askedSeq = 0;
  private watching = false;
  /** Questions in a row left unanswered; `UNANSWERED_STALL` of them stall the watch until a new held request. */
  private unanswered = 0;
  private stalled = false;
  /** The browser refused `SystemInfo.getProcessInfo` (a provider's endpoint may), or kept answering without a network
   *  service of its own (one in-process) for `NO_SERVICE_MS`: it is not asked again. */
  private noService = false;
  /** Since when the answers have named no network service. In a browser that never named one, `NO_SERVICE_MS` of that
   *  means it has none of its own (in-process). After a known one, it is a restart whose new service is slow to show:
   *  `SERVICE_GONE_MS` of that and the old one's waiting requests are told lost. */
  private missingSince: number | null = null;
  /** A network service was named at least once in this observer's life. */
  private seenService = false;
  /** Ends the watch's wait between questions early: a request just announced is asked about at once, so a service that dies
   *  a moment after it is found to have died with it. */
  private nudge: (() => void) | null = null;
  private checking: Promise<"same" | "restarted" | "unknown"> = Promise.resolve("unknown");
  /** Requests that ended unpaused (`loadingFailed`) since the service was last asked for: one that failed because the
   *  service died is lost too. */
  private readonly endedUnpaused = new Map<string, Announced>();
  /** Lost requests the call was told were not sent: a pause of one that comes after all is refused, never sent. */
  private readonly lost = new Set<string>();
  private lostListener: ((request: LostEffect) => unknown) | null = null;
  private announceSeq = 0;
  private announcedWaiters: Array<() => void> = [];
  closed = false;
  /** Resolves when a call is cut; decisions open then or taken later are refused until the next `record`, so a cut
   *  run's page sends nothing. */
  private cutoff!: Promise<EffectDecision>;
  private cut!: () => void;
  private isCut = false;

  private constructor(private readonly ws: WebSocket, private readonly decide: EffectDecider | null, private readonly decideMs: number, private readonly endpoints: string[]) {
    this.arm();
  }

  /** True when every effect waits for its journal row to be committed before it may leave. */
  get holding(): boolean { return this.decide !== null && !this.closed; }

  /** `decide` null observes without holding; a decision not made within `decideMs` is a refusal. */
  static async open(target: AttachTarget, decide: EffectDecider | null, decideMs = 60_000): Promise<EffectObserver> {
    const ws = openDial(target);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(failed("attach_refused", "the effect observer could not reach the browser")); });
    // Where the browser's own DevTools endpoint is: the extension's connection to it is not a socket anyone chose.
    const endpoints = [target.sdkCdpUrl, target.dial?.url].flatMap((u) => { try { return [new URL(u!).href]; } catch { return []; } });
    const observer = new EffectObserver(ws, decide, decideMs, endpoints);
    // A throw in a socket listener is an uncaught exception that ends the process: a frame the observer cannot read is dropped.
    ws.onmessage = (event) => { try { observer.receive(JSON.parse(String(event.data))); } catch {} };
    ws.onclose = () => { observer.closed = true; for (const p of observer.pending.values()) p.reject(failed("cdp_closed", "the effect observer's socket closed")); observer.pending.clear(); };
    try {
      // New targets start paused, so nothing they send escapes before their Network and Fetch domains are on.
      await observer.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await new Promise((r) => setTimeout(r, 150));
      const attached = new Set([...observer.sessions.values()].map((s) => s.targetId));
      for (const t of (await observer.send("Target.getTargets")).targetInfos) {
        if (t.type === "page" && !attached.has(t.targetId)) await observer.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      }
      return observer;
    } catch (error) {
      // An observer that failed its setup is never returned, so nothing else would close its socket.
      observer.close();
      throw error;
    }
  }

  /** Journal every effect from now on (a held one before it is sent); returns the stop. Lifts the previous call's cut.
   *  `lost` hears of each request the browser lost before it was sent (see `servicePid`), while this call records. */
  record(listener: (row: EffectRow) => unknown, lost?: (request: LostEffect) => unknown): () => void {
    if (this.isCut) this.arm();
    this.listener = listener;
    this.lostListener = lost ?? null;
    return () => { if (this.listener === listener) { this.listener = null; this.lostListener = null; } };
  }

  /** Resolves once everything the page started before this call is journaled. */
  async flush(signal?: AbortSignal, timeoutMs = 1000): Promise<void> {
    await Promise.all([...this.sessions].filter(([, s]) => SESSIONS.has(s.type)).map(([id]) =>
      Promise.race([this.send("Runtime.evaluate", { expression: "0" }, id).catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))])));
    const cut = () => { this.isCut = true; this.cut(); };
    if (signal?.aborted) cut(); else signal?.addEventListener("abort", cut, { once: true });
    try {
      await this.announcedSettled(timeoutMs, signal);
      // A request that ended unpaused during the call may be one a dead network service took: asked now, while the call can be told.
      if (this.endedUnpaused.size) await this.conclusiveCheck(timeoutMs, signal);
      while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    } finally { signal?.removeEventListener("abort", cut); }
  }

  close(): void { try { this.ws.close(); } catch {} }

  private arm(): void { this.isCut = false; this.cutoff = new Promise((resolve) => { this.cut = () => resolve(REFUSED); }); }

  /** `send`, whose question is forgotten when it goes unanswered for `ms`: "late", and nothing kept pending for it. */
  private sendWithin(method: string, ms: number): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve("late"); }, ms);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try { this.ws.send(JSON.stringify({ id, method, params: {} })); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  private send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (error) { this.pending.delete(id); reject(error as Error); }
    });
  }

  private receive(m: Message): void {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(failed("cdp_error", m.error.message)); else p?.resolve(m.result);
      return;
    }
    if (m.method === "Target.attachedToTarget") this.setup(m.params).catch(() => {});
    else if (m.method === "Target.detachedFromTarget") {
      this.sessions.delete(m.params.sessionId);
      for (const [id, entry] of [...this.announced]) if (entry.sessionId === m.params.sessionId) this.unannounce(id);
      for (const [id, entry] of [...this.responding]) if (entry.sessionId === m.params.sessionId) this.answered(id);
    }
    else if (m.method === "Network.requestWillBeSent") {
      const hop = this.hopOf(m.params);
      this.announce(m.sessionId!, m.params, hop);
      // A redirect is the previous hop's answer; its next hop, just announced, is waited for in its place. A next hop
      // already paused (its pause came before this announcement) stays waited for.
      if (m.params.redirectResponse && (this.responding.get(m.params.requestId)?.hop ?? 0) < hop) this.answered(m.params.requestId);
      this.track(this.sent(m.sessionId!, m.params, hop));
    }
    else if (m.method === "Network.responseReceived") this.answered(m.params.requestId);
    else if (m.method === "Fetch.requestPaused") {
      // A preflight (OPTIONS) is paused first and says nothing about the request it precedes.
      const id = m.params.networkId ?? m.params.requestId;
      const hop = SAFE.has(m.params.request.method) ? 0 : (this.pauses.get(id) ?? 0) + 1;
      // A held request is waited for from its pause, through its decision, to its answer (paused() lets it go when it is
      // refused): it is covered before it stops being announced, so a flush never sees a gap between the two.
      if (hop && this.decide && !isOwnTraffic(m.params.request.url)) this.responding.set(id, { sessionId: m.sessionId!, seq: (this.respondSeq += 1), hop });
      this.track(this.paused(m.sessionId!, m.params, hop));
      if (hop) {
        this.pauses.set(id, hop);
        this.unannounce(id);
        if (m.params.resourceType === "Document") this.unannounce(`navigation:${m.params.frameId}`);
      }
    }
    else if (m.method === "Network.loadingFailed") {
      const entry = this.announced.get(m.params.requestId);
      if (entry) { this.endedUnpaused.set(m.params.requestId, entry); this.watch(); }
      this.unannounce(m.params.requestId);
      this.answered(m.params.requestId);
    }
    else if (m.method === "Network.loadingFinished") { this.unannounce(m.params.requestId); this.answered(m.params.requestId); }
    else if (m.method === "Network.webSocketCreated") this.track(this.socket(m.sessionId!, m.params));
    else if (m.method === "Page.frameRequestedNavigation" && m.params.reason === "formSubmissionPost" && this.sessions.get(m.sessionId!)?.holds) {
      // A new intent in the frame is a new form: an earlier one told lost no longer refuses it, and it is asked about.
      this.lost.delete(`navigation:${m.params.frameId}`);
      this.stalled = false;
      this.announced.set(`navigation:${m.params.frameId}`, { sessionId: m.sessionId!, seq: (this.announceSeq += 1), method: "POST", url: m.params.url });
      this.watch();
    }
  }

  /** Which hop of its request a non-GET announcement is: 1, then one more for each redirect; 0 for a GET. */
  private hopOf(p: { requestId: string; redirectResponse?: unknown; request: { method: string } }): number {
    if (SAFE.has(p.request.method)) return 0;
    const hop = p.redirectResponse ? (this.hops.get(p.requestId) ?? 1) + 1 : 1;
    this.hops.set(p.requestId, hop);
    return hop;
  }

  /** A redirect announces its next hop under the same id; it is waited for as the first was, unless already paused. */
  private announce(sessionId: string, p: { requestId: string; type?: string; frameId?: string; request: { method: string; url: string } }, hop: number): void {
    if (!hop || !this.sessions.get(sessionId)?.holds || (this.pauses.get(p.requestId) ?? 0) >= hop) return;
    // A new held request is asked about even after a browser left questions unanswered.
    this.stalled = false;
    this.announced.set(p.requestId, { sessionId, seq: (this.announceSeq += 1), method: p.request.method, url: p.request.url, ...(p.type === "Document" && p.frameId ? { frameId: p.frameId } : {}), ...(hop > 1 ? { sent: true } : {}) });
    this.watch();
  }

  /** Asks for the network service's pid while a request waits for its pause or one ended unpaused, and never otherwise:
   *  at once for a request just announced, then every `SERVICE_POLL_MS` while it waits. */
  private watch(): void {
    if (this.watching) { this.nudge?.(); return; }
    if (this.closed || !this.decide || this.noService || this.stalled) return;
    this.watching = true;
    void (async () => {
      try {
        while (!this.closed && !this.noService && !this.stalled && (this.announced.size || this.endedUnpaused.size)) {
          if ((await this.checkService()) !== "unknown" && this.announceSeq > this.askedSeq) continue;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { this.nudge = null; resolve(); }, SERVICE_POLL_MS);
            this.nudge = () => { clearTimeout(timer); this.nudge = null; resolve(); };
          });
        }
      } finally { this.watching = false; this.nudge = null; }
    })().catch(() => undefined);
  }

  /** One question about the network service at a time, so one restart is found once. */
  private checkService(): Promise<"same" | "restarted" | "unknown"> {
    this.checking = this.checking.then(() => this.askService(), () => this.askService());
    return this.checking;
  }

  /** Asks until the answer says whether the service restarted, within `ms`, or the call's `signal` ends. A browser that
   *  never named a network service (one in-process, or a refused question) is asked once. While a known service is missing
   *  the wait runs to the end of its window (`SERVICE_GONE_MS`), so a successor slow to show still has the call told what
   *  the old one took; the call's own end ends it sooner. */
  private async conclusiveCheck(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.noService || !this.decide) return;
    const end = Date.now() + ms;
    for (;;) {
      if ((await this.checkService()) !== "unknown" || this.servicePid === null || this.noService || this.stalled || this.closed || signal?.aborted) return;
      const until = this.seenService && this.missingSince !== null ? Math.max(end, this.missingSince + SERVICE_GONE_MS + SERVICE_POLL_MS) : end;
      if (Date.now() >= until) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, Math.min(SERVICE_POLL_MS, 100));
        function finish() { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); }
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }

  private async askService(): Promise<"same" | "restarted" | "unknown"> {
    // At most one question per `ASK_GAP_MS`; what is announced before it goes is covered by its answer.
    const wait = this.lastAskAt + ASK_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAskAt = Date.now();
    const covered = this.announceSeq;
    // An unanswered question, one answered with no result, or one that failed is no answer. A browser that gives no answer
    // three times in a row is not asked again until a new held request is announced: what waits now is left to the
    // flush's own bound, never called lost.
    const noAnswer = (): "unknown" => {
      this.unanswered += 1;
      if (this.unanswered >= UNANSWERED_STALL) { this.stalled = true; this.endedUnpaused.clear(); }
      return "unknown";
    };
    let pid: number | null = null;
    try {
      const answer = await this.sendWithin("SystemInfo.getProcessInfo", ASK_MS) as { processInfo?: Array<{ type?: unknown; id?: unknown }> } | "late" | undefined;
      if (answer === "late" || answer === null || typeof answer !== "object") return noAnswer();
      const service = Array.isArray(answer.processInfo) ? answer.processInfo.find((p) => typeof p?.type === "string" && p.type.includes("NetworkService")) : undefined;
      pid = typeof service?.id === "number" ? service.id : null;
      this.unanswered = 0;
    } catch (error) {
      if (observerFailure(error) === "cdp_error") { this.noService = true; return "unknown"; }
      return noAnswer();
    }
    this.askedSeq = Math.max(this.askedSeq, covered);
    // No pid: Chrome has not started the new service yet, or runs none of its own (see `missingSince`).
    if (pid === null) {
      this.missingSince ??= Date.now();
      const missing = Date.now() - this.missingSince;
      if (!this.seenService) {
        if (missing >= NO_SERVICE_MS) { this.noService = true; this.endedUnpaused.clear(); }
        return "unknown";
      }
      if (this.servicePid === null || missing < SERVICE_GONE_MS) return "unknown";
      // The known service has been gone too long to wait for its successor: what it carried is lost, and the next pid
      // named is learned afresh.
      this.missingSince = null;
      await this.lose(covered, null);
      return "restarted";
    }
    this.missingSince = null;
    this.seenService = true;
    if (this.servicePid === null || pid === this.servicePid) {
      this.servicePid = pid;
      this.confirmedSeq = covered;
      this.endedUnpaused.clear();
      return "same";
    }
    await this.lose(covered, pid);
    return "restarted";
  }

  /** The service last seen died: the requests seen waiting while it was alive, and still unpaused, are lost and told; one
   *  announced since may be the new service's, on its way. Not paused means never sent, and a later pause of one is refused. */
  private async lose(covered: number, pid: number | null): Promise<void> {
    const gone: Array<[string, Announced]> = [...this.announced, ...this.endedUnpaused].filter(([id, entry]) => entry.seq <= this.confirmedSeq && !entry.sent && !this.pauses.has(id));
    this.servicePid = pid;
    this.confirmedSeq = covered;
    this.endedUnpaused.clear();
    // Both keys of a form refuse a late pause, but the call is told of the form once: by its Document request when that was seen.
    const forms = new Set(gone.flatMap(([, entry]) => (entry.frameId ? [`navigation:${entry.frameId}`] : [])));
    const told = gone.filter(([id]) => !forms.has(id));
    // The call is told of every loss before a flush that was waiting for these requests returns: the telling is in flight
    // before they stop being waited for, and to the call recording when they were found.
    const listener = this.lostListener;
    const telling = (async () => {
      for (const [id, entry] of told) {
        let request: EffectRequest;
        try { request = describeRequest(entry.method, entry.url); } catch { continue; }
        try { await listener?.({ requestId: id, method: request.method, origin: request.origin, path: request.path }); } catch { /* a listener's failure is its own */ }
      }
    })();
    this.track(telling);
    for (const [id] of gone) { this.lost.add(id); this.unannounce(id); }
    await telling;
  }

  private unannounce(requestId: string): void {
    if (this.announced.delete(requestId)) this.wakeIfSettled();
  }

  private answered(requestId: string): void {
    if (this.responding.delete(requestId)) this.wakeIfSettled();
  }

  private wakeIfSettled(): void {
    if (this.announced.size === 0 && this.responding.size === 0) for (const wake of this.announcedWaiters.splice(0)) wake();
  }

  /** Bounded: a request the browser never pauses (it ended some other way) must not hold a flush forever. One still waiting
   *  when the wait ends may be one a dead network service took: the service is asked about it, while the call can be told,
   *  before it is given up. */
  private announcedSettled(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.announced.size === 0 && this.responding.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.announcedWaiters = this.announcedWaiters.filter((w) => w !== done); resolve(); };
      const covered = this.announceSeq;
      const coveredResponses = this.respondSeq;
      const timer = setTimeout(() => {
        void (async () => {
          try {
            if ([...this.announced.values()].some((entry) => entry.seq <= covered)) await this.conclusiveCheck(ms, signal);
          } finally {
            for (const [id, entry] of [...this.announced]) if (entry.seq <= covered) this.unannounce(id);
            for (const [id, entry] of [...this.responding]) if (entry.seq <= coveredResponses) this.answered(id);
            done();
          }
        })().catch(() => undefined);
      }, ms);
      this.announcedWaiters.push(done);
    });
  }

  /** Every command is sent before any answer is awaited, and the resume goes last: a paused target answers
   *  renderer-side commands only after it resumes. */
  private async setup({ sessionId, targetInfo, waitingForDebugger }: { sessionId: string; targetInfo: { targetId: string; type: string; url: string }; waitingForDebugger: boolean }): Promise<void> {
    const { targetId, type, url } = targetInfo;
    const holds = this.decide !== null && SESSIONS.has(type) && type !== "worker" && !ownsExtensionPage(type, url);
    this.sessions.set(sessionId, { targetId, type, url, holds });
    const steps: Array<Promise<unknown>> = [];
    if (SESSIONS.has(type)) steps.push(this.send("Network.enable", {}, sessionId));
    if (holds) steps.push(this.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId));
    // A form's request is announced late (it starts in the browser process); the page announces the intent first. An
    // out-of-process frame announces its own forms, so it needs the Page domain too.
    if (holds && (type === "page" || type === "iframe")) steps.push(this.send("Page.enable", {}, sessionId));
    if (SESSIONS.has(type) || type === "tab") steps.push(this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId));
    if (waitingForDebugger) steps.push(this.send("Runtime.runIfWaitingForDebugger", {}, sessionId));
    await Promise.allSettled(steps);
  }

  private track(work: Promise<unknown>): void {
    const done = work.catch(() => undefined).finally(() => this.inflight.delete(done));
    this.inflight.add(done);
  }

  private async journal(requestId: string, request: EffectRequest, held: EffectRow["held"], verdict: EffectVerdict | null): Promise<boolean> {
    const prior = this.rows.get(requestId);
    if (prior && (held === null || prior.held === held)) return true;
    const row: EffectRow = { requestId, method: request.method, origin: request.origin, path: request.path, at: prior?.at ?? new Date().toISOString(), held, irreversible: verdict?.irreversible ?? prior?.irreversible ?? null };
    this.rows.set(requestId, row);
    try { await this.listener?.(row); return true; } catch { return false; }
  }

  private async sent(sessionId: string, p: { requestId: string; request: { method: string; url: string } }, hop: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (SAFE.has(p.request.method) || !session || ownsExtensionPage(session.type, session.url) || isOwnTraffic(p.request.url) || session.holds) return;
    await this.journal(rowId(p.requestId, hop), describeRequest(p.request.method, p.request.url), null, null);
  }

  /** A socket cannot be held (Fetch does not see it), so it is journaled when it is created and never decided, whoever opens
   *  it. The browser's own DevTools endpoint is the extension's connection to its host, not a request out. */
  private async socket(sessionId: string, p: { requestId: string; url: string }): Promise<void> {
    if (!this.sessions.has(sessionId) || this.isOwnEndpoint(p.url)) return;
    let request: EffectRequest;
    try { request = describeRequest("WEBSOCKET", p.url); } catch { return; }
    await this.journal(p.requestId, request, null, null);
  }

  private isOwnEndpoint(url: string): boolean {
    // The whole URL, query included: a provider's connection URL carries the session in its query, so a different query is a different socket.
    try { return this.endpoints.includes(new URL(url).href); } catch { return false; }
  }

  /** A held request stays in `responding` (set at its pause) only once it is let go: refused, or not decided at all, it
   *  is not waited for. */
  private async paused(sessionId: string, p: { requestId: string; networkId?: string; frameId?: string; resourceType?: string; request: { method: string; url: string; postData?: string; headers?: Record<string, string> } }, hop: number): Promise<void> {
    const id = p.networkId ?? p.requestId;
    let continued = false;
    try {
      continued = await this.decidePaused(sessionId, p, hop, id);
    } finally {
      if (!continued) this.answered(id);
    }
  }

  /** True when the held request was continued (allowed and recorded). */
  private async decidePaused(sessionId: string, p: { requestId: string; networkId?: string; frameId?: string; resourceType?: string; request: { method: string; url: string; postData?: string; headers?: Record<string, string> } }, hop: number, id: string): Promise<boolean> {
    const { method, url, postData, headers } = p.request;
    if (SAFE.has(method) || !this.decide || isOwnTraffic(url)) { await this.send("Fetch.continueRequest", { requestId: p.requestId }, sessionId); return false; }
    let request: EffectRequest;
    // A request the observer cannot describe cannot be judged or journaled, and a held request nobody answers waits forever: refuse it.
    try { request = describeRequest(method, url, postData, headers); } catch { await this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId); return false; }
    // Only the extension's own worker runs the model's code: a website's worker sends what the website sent.
    const session = this.sessions.get(sessionId);
    if (session?.type === "service_worker" && session.url.startsWith(EXTENSION)) request = { ...request, trigger: RUN_CODE };
    const cutoff = this.cutoff;
    // Journaled `pending` and committed before deciding: a process that dies mid-decision loses the hold and the
    // request goes, so the journal must already name it. A request whose row could not be saved never leaves.
    const row = rowId(id, hop);
    const saved = await this.journal(row, request, "pending", null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<EffectDecision>((resolve) => { timer = setTimeout(() => resolve(REFUSED), this.decideMs); });
    // A request the call was told the browser lost, and so was not sent, stays not sent: by its own id, or for a form's
    // Document by its frame's intent, which is what the call was told of when the form's request did not exist yet.
    const intent = p.resourceType === "Document" && p.frameId ? `navigation:${p.frameId}` : null;
    // The intent is used up whether or not the id matched too, so it never refuses a later Document in the frame.
    const intentLost = intent !== null && this.lost.delete(intent);
    const told = this.lost.has(id) || intentLost;
    const { allow, verdict } = saved && !told ? await Promise.race([this.decide(request), cutoff, limit]).finally(() => clearTimeout(timer)) : REFUSED;
    clearTimeout(timer);
    const recorded = await this.journal(row, request, allow ? "allowed" : "denied", verdict);
    if (allow && !recorded) { await this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId); return false; }
    await this.send(allow ? "Fetch.continueRequest" : "Fetch.failRequest", allow ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId);
    return allow;
  }
}
