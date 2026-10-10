// The pi-durable adapter: the `browser` extension. Custody lives in the run's own store: each conversation's sessions
// in `<name>.sessions`, every open session of the run in `<name>.inventory`, both moved in one commit; every session
// tool reaches its browser through a CustodyPort built on the call's own pi API. A create is committed before the
// provider is called, a release is a `<name>.release` task committed with the `releasing` state, a call rerun after a
// crash knows which session it ran on, and the run-open reconcile settles what a dead process left.
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTool, type Conversation, type ConversationDocToken, type ConversationId, type DocumentReader, type Extension, type Harness, type PromptSection, type SessionDocToken, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema, Usage } from "@earendil-works/pi-ai";
import { BROWSER_TOOLS, browserSection } from "./core/contract.js";
import { BrowserFailureError, closeDriver, currentRecord, custodyTools, newSessionRecord, notices, NAVIGATION_CAP, relaunchRefusal, SESSION_REPLACED, sessionSpec, type AttachedSession, type CustodyPort, type DriverFactory, type Overrides, type ToolOutput } from "./core/custody.js";
import type { Decisions } from "./core/decisions.js";
import type { EvidenceSink } from "./core/evidence.js";
import { EffectObserver, effectDecider, observerFailure } from "./core/effects.js";
import { classifyBrowserError } from "./core/failures.js";
import { pageTools, type PageDriver, type ToolImpl } from "./core/tools.js";
import type { BrowserConfig, BrowserProvider, InventoryRow, ObserverRow, PriceTable, ReconcileReport, ReleaseReason, SessionChange, SessionRecord, SessionRow, SessionsState } from "./core/host.js";
import { leaseTag, type LeaseRef } from "./core/lease.js";
import { createRedactor, redactDeep, scrubPageUrl } from "./core/redact.js";
import { custodyStore, now } from "./store.js";
import { resolvePrices, sessionCharge, type PriceState, type ToolUsage } from "./core/usage.js";

export type { PageDriver, ToolCall, ToolImpl } from "./core/tools.js";
export type { DriverFactory, DriverOptions } from "./core/custody.js";

export type BrowserExtensionOptions<D extends PageDriver = PageDriver> = {
  /** Default "browser"; a second plane installs a second extension under another name. */
  name?: string;
  /** Called per use, like `HarnessOptions.env`: the provider for this conversation's plane. Holds the credentials in
   *  its closure; nothing it returns is committed. */
  provider: (target: { conversationId: ConversationId; plane: string; config: BrowserConfig }) => BrowserProvider | Promise<BrowserProvider>;
  driver: DriverFactory<D>;
  /** Tool implementations by contract name, over the package's own: custody serves `browser_release` and
   *  `browser_relaunch`, the page tools `snapshot`, `run`, `screenshot` and `browser_read`. A contract tool with no
   *  implementation is not listed. */
  tools?: Partial<Record<string, ToolImpl<D>>>;
  /** Where reads, screenshots and downloads are filed. */
  evidence: EvidenceSink;
  /** Where `browser_downloads` writes files; absent, the tool is not listed. */
  workspace?: (conversationId: ConversationId) => string;
  /** The host channel: live view and session status. A throw here never fails a call. */
  onSession?: (row: SessionRow, change: SessionChange) => void | Promise<void>;
  /** The host channel for a session that runs without the effect observer its policy asked for (see `ObserverRow`). A throw here never fails a call. */
  onObserver?: (row: ObserverRow) => void | Promise<void>;
  prices?: Partial<PriceTable>;
  /** Exact strings to scrub from every output besides the built-in shapes (run tokens), read at each use. */
  redact?: { values: () => readonly string[] };
  /** Host text appended to the static `browser` section. */
  section?: { addendum?: string };
  decisions?: Decisions;
  /** How long a create may still land at the provider after its caller stopped waiting; default 60 s. */
  createDeadlineMs?: number;
  /** How the request observer attaches to a session (default `EffectObserver.open`); a seam for tests that have no Chrome. */
  openObserver?: typeof EffectObserver.open;
};

export type BrowserExtensionHandle = {
  /** Install once per Harness, before `resume()`; select per conversation. */
  extension: Extension;
  docs: { Config: ConversationDocToken<BrowserConfig>; Sessions: ConversationDocToken<SessionsState>; Inventory: SessionDocToken<{ rows: Record<string, InventoryRow> }> };
  /** For `wrapTool` and a conversation's tool filter. */
  tools: readonly ToolRegistration[];
  /** The host's shutdown path for one conversation (pi has no conversation-end event): commits `releasing` and a
   *  release task for each of its open sessions, in one commit. */
  release(conversation: Conversation, reason: ReleaseReason, context: Context): Promise<void>;
  /** At run open, after install and before resume: every open lease is reconciled with its provider. `isActive` says
   *  whether a conversation will continue in this run. */
  reconcile(harness: Harness, isActive: (conversationId: ConversationId) => boolean, context: Context): Promise<ReconcileReport>;
  /** Drop in-memory driver attachments and idle timers (process exit); never releases. */
  close(): Promise<void>;
};

export { createWebExtension, type WebExtensionOptions } from "./web.js";
export { CONFIRM_POLLS, RELEASE_ATTEMPTS } from "./store.js";

const PLANE = "default";
/** A conversation the host never configured: `run` is empty, and its browser is unavailable. */
const UNCONFIGURED: BrowserConfig = {
  label: "", run: "",
  policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000 },
};
const NOT_CONFIGURED = new BrowserFailureError({ ok: false, code: "browser_unavailable", retryable: false, effect: "none", message: "This conversation has no browser configuration, so no browser can be launched here; use web_fetch or another source." });
const open = (record: SessionRecord | null | undefined) => record?.state === "live" || record?.state === "creating";

/** One custody operation's reach: whose session, how it reads and commits, the call's signal, and a durable memo
 *  that survives a rerun of the call. */
type Scope = { cid: ConversationId; plane: string; context: Context; read: DocumentReader; signal: AbortSignal; commit<T>(change: (tx: Tx) => Promise<T>): Promise<T>; keep(slot: string, value: string): Promise<string> };

export function createBrowserExtension<D extends PageDriver>(options: BrowserExtensionOptions<D>): BrowserExtensionHandle {
  const name = options.name ?? "browser";
  const redact = createRedactor(options.redact?.values);
  const Config = defineDoc<BrowserConfig>({ kind: `${name}.config`, version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => structuredClone(UNCONFIGURED) });
  // A fork starts with no sessions: it never shares a live browser.
  const Sessions = defineDoc<SessionsState>({ kind: `${name}.sessions`, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ current: {}, sessions: [], notice: null }) });

  const attachments = new Map<string, D>();
  const observers = new Map<string, EffectObserver | null>();
  const locks = new Map<string, Promise<unknown>>();
  const idle = new Map<string, { inFlight: number; idleMs: number; timer?: NodeJS.Timeout }>();
  let opened: { harness: Harness; context: Context } | null = null;

  const configOf = async (read: DocumentReader, cid: ConversationId, context: Context): Promise<BrowserConfig> => {
    const config = await read.snapshot(Config, cid, context);
    if (!config?.run) throw NOT_CONFIGURED;
    return config as BrowserConfig;
  };
  const providerOf = async (read: DocumentReader, cid: ConversationId, plane: string, context: Context) =>
    options.provider({ conversationId: cid, plane, config: await configOf(read, cid, context) });
  const rowOf = (cid: ConversationId, record: SessionRecord): InventoryRow =>
    ({ tag: record.tag, conversationId: cid, plane: record.plane, provider: record.provider, resourceId: record.resourceId, state: record.state });

  async function emitObserver(row: ObserverRow): Promise<void> {
    try { await options.onObserver?.(row); } catch { /* the host channel never fails custody */ }
  }

  async function emit(cid: ConversationId, label: string, record: SessionRecord, change: SessionChange, provider?: BrowserProvider): Promise<void> {
    if (!options.onSession) return;
    try {
      const ref = record.resourceId === null ? null : { id: record.resourceId, tag: record.tag };
      const view = change !== "released" && ref && provider?.liveView ? await provider.liveView(ref) : null;
      // The live view's own URLs go to the host as they are (it needs their token); the pages' URLs and titles are the
      // browsed pages', which can carry a credential in their query.
      const liveView = view && { ...view, pages: view.pages.map((page) => ({ ...page, url: page.url === null ? null : scrubPageUrl(page.url, redact), title: page.title === null ? null : redact(page.title) })) };
      await options.onSession({ conversationId: cid, label, session: record, liveView }, change);
    } catch { /* the host channel never fails custody */ }
  }

  /** An error as the host's report channel may see it: its class name and its message through the redactor (a vendor
   *  SDK's error text can repeat the request's credentials). */
  const scrubbed = (error: unknown) => Object.assign(new Error(redact(error instanceof Error ? error.message : String(error))), { name: error instanceof Error ? error.name : "Error" });
  // List prices under the host's; a session price of null is the host saying it has none: seconds, no dollars.
  const prices = resolvePrices(options.prices);
  const priceState: PriceState = prices.sessionUsdPerHour === null ? "unpriced" : "priced";
  // Each charge records its price state on the record, so a cost view can tell an unpriced minute from a free one.
  const meter = (spent: SessionRecord["spent"], at: string, final = false) => {
    const charged = sessionCharge(spent, at, prices, priceState, final);
    return { spent: { ...charged.spent, state: charged.usage.state }, usage: charged.usage };
  };
  const { Inventory, move, addNotice, begin, requestRelease, bindByTag, emitReleased, ReleaseTask, reconcileAll } = custodyStore({ name, Config, Sessions, providerOf, emit, meter, scrubbed, createDeadlineMs: options.createDeadlineMs ?? 60_000 });

  const serialize = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const turn = (locks.get(key) ?? Promise.resolve()).then(run, run);
    locks.set(key, turn.catch(() => undefined));
    return turn;
  };
  const stateOf = async (scope: Scope): Promise<SessionsState> =>
    ((await scope.read.snapshot(Sessions, scope.cid, scope.context)) as SessionsState | undefined) ?? { current: {}, sessions: [], notice: null };
  const failure = (error: unknown, scope: Scope) =>
    error instanceof BrowserFailureError ? error : new BrowserFailureError(classifyBrowserError(error, false, { aborted: scope.signal.aborted }));

  async function detach(tag: string): Promise<void> {
    const driver = attachments.get(tag);
    attachments.delete(tag);
    observers.get(tag)?.close();
    observers.delete(tag);
    if (driver) await closeDriver(driver);
  }

  /** Let go of a dead driver connection and nothing else. The request observer is a separate connection that holds what the
   *  action policy does not pre-allow; a healthy one stays attached, so a page that sends something before the next call is
   *  still held. When the observer is dead too, both go. */
  async function detachDriver(tag: string): Promise<void> {
    if (observers.get(tag)?.closed) return detach(tag);
    const driver = attachments.get(tag);
    attachments.delete(tag);
    if (driver) await closeDriver(driver);
  }

  /** The live session's driver; null when the provider reports it ended (then it is recorded released). */
  async function attachLive(scope: Scope, record: SessionRecord): Promise<D | null> {
    const held = attachments.get(record.tag);
    // An observer whose socket closed holds nothing: driver and observer are attached again together.
    if (held && !observers.get(record.tag)?.closed) return held;
    if (held) await detach(record.tag);
    const provider = await providerOf(scope.read, scope.cid, scope.plane, scope.context);
    const ref: LeaseRef = { id: record.resourceId!, tag: record.tag };
    try {
      return await connect(scope, provider, ref);
    } catch (error) {
      if (!(await markEnded(scope, record, provider))) throw failure(error, scope);
      return null;
    }
  }

  /** The driver, with the run batch's limit from the conversation's policy, and, when that policy names an action
   *  policy, the effect observer on the same endpoint, which holds what the policy does not pre-allow. Without one, or
   *  when it cannot reach the browser, the session runs unobserved and a cut run's effect is unknown. */
  async function connect(scope: Scope, provider: BrowserProvider, ref: LeaseRef): Promise<D> {
    const config = await configOf(scope.read, scope.cid, scope.context);
    const { actions: policy, batchTimeoutMs } = config.policy;
    const target = await provider.attach(ref, scope.signal);
    const driver = await options.driver(target, scope.signal, { batchTimeoutMs });
    let unattached: unknown = null;
    // A healthy observer that outlived its driver's connection is kept, not opened a second time.
    const kept = observers.get(ref.tag);
    const open = options.openObserver ?? EffectObserver.open.bind(EffectObserver);
    const observer = kept && !kept.closed ? kept : policy ? await open(target, policy === "allow" ? null : effectDecider(policy, options.decisions), batchTimeoutMs).catch((error) => { unattached = error; return null; }) : null;
    // A policy that holds requests never degrades to browsing without the hold.
    if (policy && policy !== "allow" && !observer) {
      await closeDriver(driver);
      throw new BrowserFailureError({ ok: false, code: "browser_unavailable", retryable: true, effect: "none", message: "The browser's request observer could not attach, and this run's action policy needs it to hold requests; the browser is not used without it." });
    }
    observers.set(ref.tag, observer);
    attachments.set(ref.tag, driver);
    if (policy === "allow" && !observer) await emitObserver({ conversationId: scope.cid, label: config.label, tag: ref.tag, session_id: ref.id, policy, code: observerFailure(unattached) });
    return driver;
  }

  /** When the provider reports `record`'s session gone or stopped, record it released (reason ended) and say so. */
  async function markEnded(scope: Scope, record: SessionRecord, provider: BrowserProvider): Promise<boolean> {
    const status = await provider.status({ id: record.resourceId!, tag: record.tag }, scope.signal).catch(() => "running" as const);
    if (status !== "gone" && status !== "stopped") return false;
    await scope.commit((tx) => move(tx, rowOf(scope.cid, record), { state: "released", reason: "ended", at: now() }));
    await detach(record.tag);
    await emitReleased(scope.cid, record.tag, scope.read, scope.context);
    return true;
  }

  /** A create a crash left unanswered: bound to the session its tag finds, or closed when there is none. */
  async function settleCreating(scope: Scope, record: SessionRecord): Promise<void> {
    const provider = await providerOf(scope.read, scope.cid, scope.plane, scope.context);
    try { await bindByTag(provider, rowOf(scope.cid, record), scope.commit, scope.signal); } catch (error) { throw failure(error, scope); }
  }

  async function create(scope: Scope, overrides: Overrides, presetTag?: string): Promise<{ record: SessionRecord; driver: D }> {
    const config = await configOf(scope.read, scope.cid, scope.context);
    const provider = await options.provider({ conversationId: scope.cid, plane: scope.plane, config });
    const tag = presetTag ?? leaseTag("ar", config.run, scope.cid, (await stateOf(scope)).sessions.length + 1);
    const spec = sessionSpec(config, tag, overrides);
    const record = newSessionRecord({ plane: scope.plane, tag, provider: provider.name, spec, at: now() });
    const row = rowOf(scope.cid, record);
    await scope.commit(async (tx) => {
      const state = await tx.doc(Sessions, scope.cid);
      state.sessions.push(record);
      state.current[scope.plane] = state.sessions.length - 1;
      await begin(tx, row);
    });
    // An answer lost on the way back is not a session that never started: it is settled by its tag.
    const ref = await provider.create(spec, scope.signal).then(
      async (made) => { await scope.commit((tx) => move(tx, row, { state: "live", resourceId: made.id, at: now() })); return made; },
      async (error) => (await bindByTag(provider, row, scope.commit, scope.signal, await provider.findByTag(tag, scope.signal).catch(() => []))) ?? Promise.reject(failure(error, scope)));
    const live: SessionRecord = { ...record, state: "live", resourceId: ref.id };
    try {
      const driver = await connect(scope, provider, ref);
      await emit(scope.cid, config.label, live, "launched", provider);
      return { record: live, driver };
    } catch (error) { throw failure(error, scope); }
  }

  /** The current session, attached; one is launched when there is none to attach. */
  async function acquire(scope: Scope): Promise<{ record: SessionRecord; driver: D; note: string | null }> {
    let note: string | null = null;
    for (let turn = 0; turn < 4; turn += 1) {
      const record = currentRecord(await stateOf(scope), scope.plane);
      if (record?.state === "live") {
        const driver = await attachLive(scope, record);
        if (driver) return { record, driver, note };
        note = notices.ended(record.lastUrl);
      } else if (record?.state === "creating") {
        await settleCreating(scope, record);
      } else {
        return { ...(await create(scope, {})), note };
      }
    }
    throw new Error(`browser custody for conversation ${scope.cid} did not settle`);
  }

  /** The session as a tool gets it. Custody's notice is kept in the call's memo before it is cleared, so a call rerun
   *  after a crash still tells it. */
  async function attached(scope: Scope, record: SessionRecord, driver: D, note: string | null): Promise<AttachedSession<D>> {
    const state = await stateOf(scope);
    const notice = await scope.keep("notice", [note, state.notice].filter(Boolean).join(" "));
    if (state.notice !== null) await scope.commit(async (tx) => { (await tx.doc(Sessions, scope.cid)).notice = null; });
    const fresh = state.sessions.find((r) => r.tag === record.tag) ?? record;
    const interrupted = [...state.sessions].reverse().find((r) => r.plane === scope.plane && r.pendingEffect !== null)?.pendingEffect ?? null;
    const recorded = Boolean((await providerOf(scope.read, scope.cid, scope.plane, scope.context)).recordings);
    return { driver, tag: record.tag, sessionId: fresh.resourceId!, record: fresh, notice: notice || null, interrupted, recorded, effects: observers.get(record.tag) ?? null };
  }

  async function releaseRecord(scope: Scope, record: SessionRecord, reason: ReleaseReason): Promise<void> {
    await scope.commit((tx) => requestRelease(tx, rowOf(scope.cid, record), reason, now()));
    await detach(record.tag);
  }

  /** Mutate the plane's records in one commit. */
  const editRecords = (scope: Scope, edit: (records: SessionRecord[], state: SessionsState) => void) =>
    scope.commit(async (tx) => { const state = await tx.doc(Sessions, scope.cid); edit(state.sessions.filter((r) => r.plane === scope.plane), state); });

  function portFor(api: ToolExecutionApi, context: Context): CustodyPort<D> {
    const memo = (slot: string) => `${name}:${slot}:${PLANE}`;
    const scope: Scope = { cid: api.conversationId, plane: PLANE, context, read: api, signal: context.abortSignal ?? new AbortController().signal, commit: (change) => api.commit(change, context), keep: async (slot, value) => {
      // An earlier attempt's text comes first; an empty one is never memoized, so it cannot shadow a later notice.
      const prior = await api.memo<string>(memo(slot), context);
      if (prior !== undefined) return [prior, value].filter(Boolean).join(" ");
      return value ? api.memo(memo(slot), value, context) : "";
    } };
    const key = `${scope.cid}:${scope.plane}`;
    return {
      session: () => serialize(key, async () => {
        // A call rerun after a crash: the session it first ran on, or nothing.
        const ran = await api.memo<string>(memo("ran"), context);
        if (ran !== undefined) {
          const record = (await stateOf(scope)).sessions.find((r) => r.tag === ran);
          const driver = record?.state === "live" ? await attachLive(scope, record) : null;
          if (!record || !driver) throw new BrowserFailureError(SESSION_REPLACED);
          return attached(scope, record, driver, null);
        }
        const { record, driver, note } = await acquire(scope);
        await api.memo(memo("ran"), record.tag, context);
        return attached(scope, record, driver, note);
      }),
      relaunch: (overrides) => serialize(key, async () => {
        const config = await configOf(scope.read, scope.cid, scope.context);
        const refusal = relaunchRefusal(config.policy, overrides);
        if (refusal) throw new BrowserFailureError(refusal);
        // The relaunch's session is chosen in a memo before its create is committed. A rerun runs on that session, or
        // says session_replaced when it has ended (as a page tool's rerun does); it never launches a second one. A memo
        // with no record yet is a create never committed: it goes ahead under the memoized tag.
        const find = async (tag: string | undefined) => (await stateOf(scope)).sessions.find((r) => r.tag === tag);
        const launched = await api.memo<string>(memo("relaunch"), context);
        let mine = await find(launched);
        if (mine) {
          if (mine.state === "creating") { await settleCreating(scope, mine); mine = await find(launched); }
          const driver = mine?.state === "live" ? await attachLive(scope, mine) : null;
          if (!mine || !driver) throw new BrowserFailureError(SESSION_REPLACED);
          return attached(scope, mine, driver, null);
        }
        const state = await stateOf(scope);
        const tag = launched ?? await api.memo(memo("relaunch"), leaseTag("ar", config.run, scope.cid, state.sessions.length + 1), context);
        const old = currentRecord(state, scope.plane);
        if (old && open(old) && old.tag !== tag) await releaseRecord(scope, old, "relaunch");
        const made = await create(scope, overrides, tag);
        return attached(scope, made.record, made.driver, null);
      }),
      release: () => serialize(key, async () => {
        const record = currentRecord(await stateOf(scope), scope.plane);
        if (!record || !open(record)) return { released: record?.state === "releasing", sessionId: record?.resourceId ?? null };
        await releaseRecord(scope, record, "tool");
        return { released: true, sessionId: record.resourceId };
      }),
      dispatching: (effect) => editRecords(scope, (records, state) => {
        const record = currentRecord(state, scope.plane);
        if (record) record.pendingEffect = { ...effect, url: effect.url === null ? null : scrubPageUrl(effect.url, redact), at: now(), sent: [] };
      }),
      journal: (row) => editRecords(scope, (records, state) => {
        const pending = currentRecord(state, scope.plane)?.pendingEffect;
        if (!pending) return;
        const sent = pending.sent ?? (pending.sent = []);
        const scrubbed = { ...row, origin: redact(row.origin), path: redact(row.path) };
        const at = sent.findIndex((r) => r.requestId === row.requestId);
        if (at === -1) sent.push(scrubbed); else sent[at] = scrubbed;
      }),
      settle: async () => {
        if (!(await stateOf(scope)).sessions.some((r) => r.plane === scope.plane && r.pendingEffect !== null)) return;
        await editRecords(scope, (records) => { for (const record of records) record.pendingEffect = null; });
      },
      navigated: async (page) => {
        // A page URL can carry a credential in any query value, its fragment or its userinfo: it is scrubbed before it
        // is committed or reported.
        const url = scrubPageUrl(page, redact);
        await editRecords(scope, (records, state) => {
          const record = currentRecord(state, scope.plane);
          if (!record) return;
          record.navigation.push({ at: now(), url });
          if (record.navigation.length > NAVIGATION_CAP) record.navigation.splice(0, record.navigation.length - NAVIGATION_CAP);
          record.lastUrl = url;
        });
        const record = currentRecord(await stateOf(scope), scope.plane);
        if (record) await emit(scope.cid, (await configOf(scope.read, scope.cid, scope.context)).label, record, "updated", await providerOf(scope.read, scope.cid, scope.plane, scope.context));
      },
      dropped: () => serialize(key, async () => {
        const record = currentRecord(await stateOf(scope), scope.plane);
        if (record) await detachDriver(record.tag);
      }),
      ended: async () => {
        const record = currentRecord(await stateOf(scope), scope.plane);
        if (record?.state !== "live") return false;
        return markEnded(scope, record, await providerOf(scope.read, scope.cid, scope.plane, scope.context));
      },
    };
  }

  /** Idle release: a plane nobody calls for its idle window is released, never mid-call. It needs the Harness the
   *  host handed to `reconcile`; a process dies with its timers, and the provider's own idle bound takes over. */
  function activity(cid: ConversationId, delta: number, idleMs?: number): void {
    const key = `${cid}:${PLANE}`;
    const entry = idle.get(key) ?? { inFlight: 0, idleMs: idleMs ?? UNCONFIGURED.policy.idleReleaseS * 1000 };
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.inFlight += delta;
    if (idleMs !== undefined) entry.idleMs = idleMs;
    idle.set(key, entry);
    if (entry.inFlight > 0 || !opened || !(entry.idleMs > 0)) return;
    const timer: NodeJS.Timeout = setTimeout(() => void releaseIdle(cid, timer).catch(() => undefined), entry.idleMs);
    entry.timer = timer;
    timer.unref?.();
  }

  async function releaseIdle(cid: ConversationId, fired: NodeJS.Timeout): Promise<void> {
    const conversation = opened && await opened.harness.conversation(cid, opened.context);
    if (!conversation) return;
    const entry = idle.get(`${cid}:${PLANE}`);
    // Only the timer that is still current releases, checked inside the commit: a call since, even one that ran while
    // the lookup above waited, replaced it.
    await releasePlane(conversation, "idle", opened!.context, () => entry?.timer === fired && entry.inFlight === 0, Math.round((entry?.idleMs ?? 0) / 1000));
  }

  /** In turn with the plane's calls, commit `releasing` and a release task for its open session, detach it and stop the
   *  idle timer when it released one. A release the model did not ask for (idle, close) commits its notice with it, so
   *  whichever call next attaches a session tells it, even when the call that opened the replacement failed or died. */
  async function releasePlane(conversation: Conversation, reason: ReleaseReason, context: Context, still: () => boolean = () => true, idleS = 0): Promise<void> {
    const key = `${conversation.id}:${PLANE}`;
    const released = await serialize(key, async () => {
      const tags = await conversation.commit(async (tx) => {
        const state = await tx.doc(Sessions, conversation.id);
        const record = still() ? currentRecord(state, PLANE) : null;
        if (!record || !open(record)) return [];
        await requestRelease(tx, rowOf(conversation.id, record), reason, now());
        if (reason === "idle" || reason === "close") addNotice(state, notices.released(reason, record.lastUrl, idleS));
        return [record.tag];
      }, context);
      for (const tag of tags) await detach(tag);
      return tags.length > 0;
    });
    const timer = released ? idle.get(key)?.timer : undefined;
    if (timer) clearTimeout(timer);
  }

  /** The current session's time since its last charge, committed on its record: the usage of the call that used it. */
  async function chargeCall(api: ToolExecutionApi, context: Context): Promise<ToolUsage | null> {
    if (currentRecord(await api.snapshot(Sessions, api.conversationId, context), PLANE)?.state !== "live") return null;
    return api.commit(async (tx) => {
      const record = currentRecord(await tx.doc(Sessions, api.conversationId), PLANE);
      if (record?.state !== "live") return null;
      const { spent, usage } = meter(record.spent, now());
      record.spent = spent;
      return usage;
    }, context);
  }
  /** A call's own usage (a host tool may price itself) with the session time it carries added to its cost. */
  const withSessionTime = (own: ToolOutput["usage"], charged: ToolUsage | null): ToolOutput["usage"] => {
    if (!charged) return own;
    const ownCost = (own?.cost ?? {}) as { total?: number };
    return { ...charged.usage, ...own, cost: { ...charged.usage.cost, ...ownCost, total: charged.usage.cost.total + (ownCost.total ?? 0) } };
  };

  const impls = { ...custodyTools, ...pageTools(), ...options.tools } as unknown as Record<string, ToolImpl<D> | undefined>;
  const tools = BROWSER_TOOLS
    .filter((contract) => impls[contract.name] && (contract.listedWhen !== "downloads" || options.workspace))
    .map((contract) => defineTool({
      name: contract.name,
      description: contract.description,
      parameters: contract.parameters as unknown as TSchema,
      replay: contract.replay,
      executionMode: contract.executionMode,
      execute: async (args, api, context) => {
        const config = await api.snapshot(Config, api.conversationId, context);
        activity(api.conversationId, +1, (config?.policy.idleReleaseS ?? 0) * 1000);
        try {
          const call = { callId: api.callId, conversationId: api.conversationId, signal: context.abortSignal, label: config?.label ?? "", redact, evidence: options.evidence, classifyPage: options.decisions?.classifyPage };
          // Called inside an async function, so a host tool that throws before it returns a promise is caught too.
          const out = await (async () => impls[contract.name]!(args, portFor(api, context), call))().catch((error): ToolOutput => {
            // A throw would reach pi's diagnostic unscrubbed: every failure comes back as the typed envelope, redacted.
            const typed = error instanceof BrowserFailureError ? error.failure : classifyBrowserError(error, contract.effect === "effect", { aborted: context.abortSignal?.aborted === true });
            return { content: [{ type: "text", text: JSON.stringify(typed) }], isError: true };
          });
          // The session's time since its last charge rides on the call, whatever it ended in; a charge that cannot be
          // committed now is carried by the next one.
          const usage = withSessionTime(out.usage, await chargeCall(api, context).catch(() => null));
          return {
            content: out.content.map((item) => item.type === "text" ? { ...item, text: redact(item.text) } : item),
            ...(out.isError ? { isError: true } : {}),
            ...(out.details ? { details: redactDeep(out.details, redact) as JsonValue } : {}),
            ...(usage ? { usage: usage as unknown as Usage } : {}),
          };
        } finally {
          activity(api.conversationId, -1);
        }
      },
    }));
  const names = new Set(tools.map((tool) => tool.name));

  // Rendered only for a conversation offered one of the browser's tools; its text depends on the configuration alone.
  const section: PromptSection = {
    key: name,
    async render(input, context) {
      if (!input.agent.tools.some((tool) => names.has(tool.name))) return undefined;
      const config = await input.read.snapshot(Config, input.conversationId, context);
      return [browserSection({ idleReleaseS: config?.policy.idleReleaseS ?? UNCONFIGURED.policy.idleReleaseS }), options.section?.addendum].filter(Boolean).join("\n\n");
    },
  };

  return {
    extension: defineExtension({ name, tools, sections: [section], tasks: [ReleaseTask] }),
    docs: { Config, Sessions, Inventory },
    tools,
    release: (conversation, reason, context) => releasePlane(conversation, reason, context),
    async reconcile(harness, isActive, context) {
      opened = { harness, context };
      return reconcileAll(harness, isActive, context);
    },
    async close() {
      for (const entry of idle.values()) if (entry.timer) clearTimeout(entry.timer);
      idle.clear();
      // A session whose driver was let go and not yet replaced still has its observer attached: close both kinds.
      await Promise.all([...new Set([...attachments.keys(), ...observers.keys()])].map(detach));
    },
  };
}
