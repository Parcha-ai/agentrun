// Observed effects: a second, read-only CDP client per browser session that sees every request the browser sends,
// journals the ones that can change something (any method but GET, HEAD and OPTIONS) and, unless the policy
// pre-allows them, holds each one until a decision. Nothing about a request leaves this module but its method, origin,
// path, and the names of its query keys and form fields: never a body, a header or a value.
import type { Decisions, EffectRequest, EffectVerdict } from "./decisions.js";
import type { AttachTarget, ObserverFailure, SentEffect } from "./host.js";

/** What a request the judge calls irreversible (or cannot judge) meets: sent, refused, or the host's answer. */
export type ActionPolicy = "allow" | "deny" | "ask";
/** One journaled request. `held` is the decision when the observer held it (`pending` while it is decided), null when
 *  it went out unheld. */
export type EffectRow = SentEffect;
export type EffectDecision = { allow: boolean; verdict: EffectVerdict | null };
export type EffectDecider = (request: EffectRequest) => Promise<EffectDecision>;

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSIONS = new Set(["page", "iframe", "worker", "service_worker", "shared_worker"]);
/** A judged request goes out at once when it is unlikely to be irreversible and likely telemetry or a query. */
const HARMLESS = { irreversibleBelow: 0.5, atLeast: 0.7 };
const REFUSED: EffectDecision = { allow: false, verdict: null };

/** The policy over the host's judgment. Judgments are memoized per method, origin, path and the names of its query
 *  keys and form fields (everything the judge sees), so a page that beacons every second costs one question; an
 *  approval under `ask` is asked every time. No judge, or a judge that answers
 *  null or fails, leaves the request judged irreversible. */
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

/** A request as the decider sees it. The form fields are the names in a form-encoded or JSON object body. */
export function describeRequest(method: string, url: string, postData?: string, headers: Record<string, string> = {}): EffectRequest {
  const u = new URL(url);
  const type = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  let formFields: string[] = [];
  if (postData && type.includes("application/x-www-form-urlencoded")) formFields = [...new URLSearchParams(postData).keys()];
  else if (postData && type.includes("json")) try { const body = JSON.parse(postData); if (body && typeof body === "object" && !Array.isArray(body)) formFields = Object.keys(body); } catch { /* not an object */ }
  return { method, origin: u.origin, path: u.pathname, queryKeys: [...new Set(u.searchParams.keys())], formFields, pageTitle: null, trigger: null, task: null };
}

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

/** An observer error tagged with why it failed, so a host can be told the code and none of the text. */
const failed = (code: ObserverFailure, message: string): Error => Object.assign(new Error(message), { observerCode: code });
const CODES: readonly ObserverFailure[] = ["attach_refused", "cdp_closed", "cdp_error", "attach_failed"];
/** The code of an observer failure; an error the observer did not tag is `attach_failed`. Never reads the message. */
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
  /** Handlers still deciding or journaling; `flush` waits for them. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Effect requests a holding session has announced (`Network.requestWillBeSent`, which comes from the page's own process, in
   *  order with its commands) and whose pause (`Fetch.requestPaused`, which comes from the network side and can lag) has not
   *  arrived: request id to its session and the order it was announced in. A holding session journals a request only at its pause, so `flush` waits for these. */
  private readonly announced = new Map<string, { sessionId: string; seq: number }>();
  private announceSeq = 0;
  private announcedWaiters: Array<() => void> = [];
  /** Set when the socket closes: the observer then sees and holds nothing. */
  closed = false;
  /** Resolves when a call is cut, refusing every decision open then and every one taken after, until the next call
   *  records: what a cut run's page sends after the cut never leaves. */
  private cutoff!: Promise<EffectDecision>;
  private cut!: () => void;
  private isCut = false;

  private constructor(private readonly ws: WebSocket, private readonly decide: EffectDecider | null, private readonly decideMs: number) {
    this.arm();
  }

  /** Whether every effect waits for its journal row to be committed before it can leave: true when holding. */
  get holding(): boolean { return this.decide !== null && !this.closed; }

  /** Open on the session's own CDP endpoint, beside the driver. `decide` null observes without holding; a decision that
   *  has not come within `decideMs` is a refusal. */
  static async open(target: AttachTarget, decide: EffectDecider | null, decideMs = 60_000): Promise<EffectObserver> {
    const init = target.dial?.headers ? { headers: target.dial.headers } : undefined;
    const ws = new (WebSocket as unknown as new (url: string, init?: object) => WebSocket)(target.dial?.url ?? target.sdkCdpUrl, init);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(failed("attach_refused", "the effect observer could not reach the browser")); });
    const observer = new EffectObserver(ws, decide, decideMs);
    ws.onmessage = (event) => observer.receive(JSON.parse(String(event.data)));
    ws.onclose = () => { observer.closed = true; for (const p of observer.pending.values()) p.reject(failed("cdp_closed", "the effect observer's socket closed")); observer.pending.clear(); };
    // New targets start paused, so nothing they send escapes before their Network and Fetch domains are on.
    await observer.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await new Promise((r) => setTimeout(r, 150));
    const attached = new Set([...observer.sessions.values()].map((s) => s.targetId));
    for (const t of (await observer.send("Target.getTargets")).targetInfos) {
      if (t.type === "page" && !attached.has(t.targetId)) await observer.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    }
    return observer;
  }

  /** Journal every effect from now on to `listener` (a held one before it is sent); returns the stop. A new call: a
   *  cut before it no longer refuses decisions. */
  record(listener: (row: EffectRow) => unknown): () => void {
    if (this.isCut) this.arm();
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = null; };
  }

  /** A command round trip on every session, then the effects a holding session has announced (a request, or a form submission
   *  the page has asked its browser for) and not yet seen paused: what the page started before this returns is journaled. */
  async flush(signal?: AbortSignal, timeoutMs = 1000): Promise<void> {
    await Promise.all([...this.sessions].filter(([, s]) => SESSIONS.has(s.type)).map(([id]) =>
      Promise.race([this.send("Runtime.evaluate", { expression: "0" }, id).catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))])));
    // Then every request seen so far is decided and journaled (a decision under `ask` waits for the host, at most
    // `decideMs`); a cut call refuses the ones still open at once, and the ones its page sends after.
    const cut = () => { this.isCut = true; this.cut(); };
    if (signal?.aborted) cut(); else signal?.addEventListener("abort", cut, { once: true });
    try {
      // A holding session journals a request when it is paused, which can come after the round trip above: wait for the
      // effects the page has announced, then for the handlers they started.
      await this.announcedSettled(timeoutMs);
      while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    } finally { signal?.removeEventListener("abort", cut); }
  }

  close(): void { try { this.ws.close(); } catch { /* already closed */ } }

  private arm(): void { this.isCut = false; this.cutoff = new Promise((resolve) => { this.cut = () => resolve(REFUSED); }); }

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
    if (m.method === "Target.attachedToTarget") void this.setup(m.params);
    else if (m.method === "Target.detachedFromTarget") { this.sessions.delete(m.params.sessionId); for (const [id, entry] of [...this.announced]) if (entry.sessionId === m.params.sessionId) this.unannounce(id); }
    else if (m.method === "Network.requestWillBeSent") { this.announce(m.sessionId!, m.params); this.track(this.sent(m.sessionId!, m.params)); }
    else if (m.method === "Fetch.requestPaused") {
      this.track(this.paused(m.sessionId!, m.params));
      // A preflight (OPTIONS) is paused first and says nothing about the request it precedes.
      if (!SAFE.has(m.params.request.method)) {
        this.unannounce(m.params.networkId ?? m.params.requestId);
        if (m.params.resourceType === "Document") this.unannounce(`navigation:${m.params.frameId}`);
      }
    }
    else if (m.method === "Network.loadingFailed" || m.method === "Network.loadingFinished") this.unannounce(m.params.requestId);
    else if (m.method === "Page.frameRequestedNavigation" && m.params.reason === "formSubmissionPost" && this.sessions.get(m.sessionId!)?.holds) this.announced.set(`navigation:${m.params.frameId}`, { sessionId: m.sessionId!, seq: (this.announceSeq += 1) });
  }

  private announce(sessionId: string, p: { requestId: string; request: { method: string } }): void {
    if (this.sessions.get(sessionId)?.holds && !SAFE.has(p.request.method)) this.announced.set(p.requestId, { sessionId, seq: (this.announceSeq += 1) });
  }

  private unannounce(requestId: string): void {
    if (this.announced.delete(requestId) && this.announced.size === 0) for (const wake of this.announcedWaiters.splice(0)) wake();
  }

  /** Resolves once no announced effect is waiting for its pause, or after `ms`: a request the browser never pauses (it
   *  ended some other way) must not hold a flush for ever. */
  private announcedSettled(ms: number): Promise<void> {
    if (this.announced.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.announcedWaiters = this.announcedWaiters.filter((w) => w !== done); resolve(); };
      // Past the bound an entry that was already outstanding when the wait began is stale (its request ended some other way):
      // dropped, so it cannot delay the next flush too. One announced while this wait ran is newer than anything it covered, and stays.
      const covered = this.announceSeq;
      const timer = setTimeout(() => { for (const [id, entry] of [...this.announced]) if (entry.seq <= covered) this.unannounce(id); done(); }, ms);
      this.announcedWaiters.push(done);
    });
  }

  /** Every command is sent before any answer is awaited, and the resume goes last: a target that started paused answers
   *  renderer-side commands only after it resumes. */
  private async setup({ sessionId, targetInfo, waitingForDebugger }: { sessionId: string; targetInfo: { targetId: string; type: string; url: string }; waitingForDebugger: boolean }): Promise<void> {
    const { targetId, type, url } = targetInfo;
    const holds = this.decide !== null && SESSIONS.has(type) && type !== "worker" && !url.startsWith("chrome-extension://");
    this.sessions.set(sessionId, { targetId, type, url, holds });
    const steps: Array<Promise<unknown>> = [];
    if (SESSIONS.has(type)) steps.push(this.send("Network.enable", {}, sessionId));
    if (holds) steps.push(this.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId));
    // A form submission starts in the browser process, so its request is announced late; the page announces the intent first.
    // A frame in another process (a widget on another origin) is a target of its own and announces its forms' intent on its own
    // session, so it needs the Page domain too.
    if (holds && (type === "page" || type === "iframe")) steps.push(this.send("Page.enable", {}, sessionId));
    if (SESSIONS.has(type) || type === "tab") steps.push(this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId));
    if (waitingForDebugger) steps.push(this.send("Runtime.runIfWaitingForDebugger", {}, sessionId));
    await Promise.allSettled(steps);
  }

  private track(work: Promise<unknown>): void {
    const done = work.catch(() => undefined).finally(() => this.inflight.delete(done));
    this.inflight.add(done);
  }

  /** Journal a row; false when its write failed (the listener threw). */
  private async journal(requestId: string, request: EffectRequest, held: EffectRow["held"], verdict: EffectVerdict | null): Promise<boolean> {
    const prior = this.rows.get(requestId);
    if (prior && (held === null || prior.held === held)) return true;
    const row: EffectRow = { requestId, method: request.method, origin: request.origin, path: request.path, at: prior?.at ?? new Date().toISOString(), held, irreversible: verdict?.irreversible ?? prior?.irreversible ?? null };
    this.rows.set(requestId, row);
    try { await this.listener?.(row); return true; } catch { return false; }
  }

  private async sent(sessionId: string, p: { requestId: string; request: { method: string; url: string } }): Promise<void> {
    const session = this.sessions.get(sessionId);
    // A request a holding session will pause is journaled with its decision when it pauses.
    if (SAFE.has(p.request.method) || !session || session.url.startsWith("chrome-extension://") || session.holds) return;
    await this.journal(p.requestId, describeRequest(p.request.method, p.request.url), null, null);
  }

  private async paused(sessionId: string, p: { requestId: string; networkId?: string; request: { method: string; url: string; postData?: string; headers?: Record<string, string> } }): Promise<void> {
    const { method, url, postData, headers } = p.request;
    if (SAFE.has(method) || !this.decide) return this.send("Fetch.continueRequest", { requestId: p.requestId }, sessionId);
    const request = describeRequest(method, url, postData, headers);
    const cutoff = this.cutoff;
    // Journaled `pending`, and committed, before the decision: a process that dies while deciding loses the hold (the
    // browser lets the request go), so the journal already names it. A request whose row could not be saved never leaves.
    const id = p.networkId ?? p.requestId;
    const saved = await this.journal(id, request, "pending", null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<EffectDecision>((resolve) => { timer = setTimeout(() => resolve(REFUSED), this.decideMs); });
    const { allow, verdict } = saved ? await Promise.race([this.decide(request), cutoff, limit]).finally(() => clearTimeout(timer)) : REFUSED;
    const recorded = await this.journal(id, request, allow ? "allowed" : "denied", verdict);
    if (allow && !recorded) return this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId);
    await this.send(allow ? "Fetch.continueRequest" : "Fetch.failRequest", allow ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId);
  }
}
