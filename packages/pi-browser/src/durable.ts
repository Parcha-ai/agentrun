import type { Context } from "@earendil-works/chord";
import { configure, defineDoc, defineExtension, defineTool, type Conversation, type ConversationDocToken, type ConversationId, type DocumentReader, type Extension, type Harness, type PromptSection, type SessionDocToken, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema, Usage } from "@earendil-works/pi-ai";
import { BROWSER_TOOL_NAMES, BROWSER_TOOLS, browserSection, WEB_TOOL_NAMES } from "./core/contract.js";
import { BrowserFailureError, closeDriver, currentRecord, custodyTools, newSessionRecord, notices, NAVIGATION_CAP, relaunchRefusal, SESSION_REPLACED, sessionSpec, type AttachedSession, type CustodyPort, type DriverFactory, type Overrides, type ToolOutput } from "./core/custody.js";
import { forModel } from "./durable-result.js";
import type { Decisions } from "./core/decisions.js";
import type { EvidenceSink } from "./core/evidence.js";
import { EffectObserver, effectDecider, observerFailure } from "./core/effects.js";
import { classifyBrowserError } from "./core/failures.js";
import { pageTools, type PageDriver, type ToolImpl } from "./core/tools.js";
import type { BrowserConfig, BrowserProvider, ChildRunner, InventoryRow, ObserverRow, PriceTable, ReconcileReport, ReleaseReason, SessionChange, SessionRecord, SessionRow, SessionsState, SiteInfo, SiteRunPort } from "./core/host.js";
import { useWebsite, useWebsiteContract } from "./core/sites.js";
import { leaseTag, type LeaseRef } from "./core/lease.js";
import { createRedactor, redactDeep, scrubPageUrl } from "./core/redact.js";
import { CREATE_DEADLINE_MS, DEFAULT_BROWSER_POLICY, idleTracker, keyedSerializer, providerKeyValues } from "./core/session-control.js";
import { custodyStore, now } from "./store.js";
import { resolvePrices, sessionCharge, type PriceState, type ToolUsage } from "./core/usage.js";

export type { PageDriver, ToolCall, ToolImpl } from "./core/tools.js";
export type { DriverFactory, DriverOptions } from "./core/custody.js";

export type BrowserExtensionOptions<D extends PageDriver = PageDriver> = {
  /** Default "browser"; a second plane installs a second extension under another name. */
  name?: string;
  /** Called per use: the provider for this conversation's plane. Holds the credentials in its closure; nothing it
   *  returns is committed. */
  provider: (target: { conversationId: ConversationId; plane: string; config: BrowserConfig }) => BrowserProvider | Promise<BrowserProvider>;
  driver: DriverFactory<D>;
  /** Implementations by contract name, over the package's own; a contract tool with no implementation is not listed. */
  tools?: Partial<Record<string, ToolImpl<D>>>;
  evidence: EvidenceSink;
  /** Where `browser_downloads` writes files; absent, the tool is not listed. */
  workspace?: (conversationId: ConversationId) => string;
  /** `use_website`'s sites; absent, the tool is not listed. `listing` is the port's `list()`, read once at host setup:
   *  the tool's description renders from it. Each local child runs in a conversation this call owns. */
  sites?: { port: SiteRunPort; listing: readonly SiteInfo[] };
  /** Live view and session status; a throw here never fails a call. */
  onSession?: (row: SessionRow, change: SessionChange) => void | Promise<void>;
  /** A session runs without the effect observer its policy asked for; a throw here never fails a call. */
  onObserver?: (row: ObserverRow) => void | Promise<void>;
  prices?: Partial<PriceTable>;
  /** Exact strings to scrub from every output besides the built-in shapes, read at each use. */
  redact?: { values: () => readonly string[] };
  section?: { addendum?: string };
  decisions?: Decisions;
  /** How long a create may still land at the provider after its caller stopped waiting; default 60 s. */
  createDeadlineMs?: number;
  /** How the request observer attaches (default `EffectObserver.open`); a seam for tests that have no Chrome. */
  openObserver?: typeof EffectObserver.open;
};

export type BrowserExtensionHandle = {
  /** Install once per Harness, before `resume()`; select per conversation. */
  extension: Extension;
  /** `Children`: the conversation each `use_website` request ran its child in, by `<site>:<request_id>`. */
  docs: { Config: ConversationDocToken<BrowserConfig>; Sessions: ConversationDocToken<SessionsState>; Inventory: SessionDocToken<{ rows: Record<string, InventoryRow> }>; Children: ConversationDocToken<{ byRequest: Record<string, number> }> };
  tools: readonly ToolRegistration[];
  /** Shutdown path (pi has no conversation-end event): commits `releasing` and a release task; it does not wait. */
  release(conversation: Conversation, reason: ReleaseReason, context: Context): Promise<void>;
  /** At run open, after install and before resume: every open lease is reconciled with its provider. */
  reconcile(harness: Harness, isActive: (conversationId: ConversationId) => boolean, context: Context): Promise<ReconcileReport>;
  /** Drop in-memory driver attachments and idle timers (process exit); never releases. */
  close(): Promise<void>;
};

export { createWebExtension, type WebExtensionOptions } from "./web.js";
export { CONFIRM_POLLS, RELEASE_ATTEMPTS } from "./store.js";

const PLANE = "default";
const UNCONFIGURED: BrowserConfig = { label: "", run: "", policy: DEFAULT_BROWSER_POLICY };
const NOT_CONFIGURED = new BrowserFailureError({ ok: false, code: "browser_unavailable", retryable: false, effect: "none", message: "This conversation has no browser configuration, so no browser can be launched here; use web_fetch or another source." });
const open = (record: SessionRecord | null | undefined) => record?.state === "live" || record?.state === "creating";
// A child gets the browser and web tools only, never use_website, so it cannot start children of its own.
const CHILD_TOOLS = new Set<string>([...BROWSER_TOOL_NAMES, ...WEB_TOOL_NAMES]);

type Scope = { cid: ConversationId; plane: string; context: Context; read: DocumentReader; signal: AbortSignal; commit<T>(change: (tx: Tx) => Promise<T>): Promise<T>; keep(slot: string, value: string): Promise<string> };

export function createBrowserExtension<D extends PageDriver>(options: BrowserExtensionOptions<D>): BrowserExtensionHandle {
  const name = options.name ?? "browser";
  const redact = createRedactor(() => providerKeyValues(process.env, options.redact?.values));
  const Config = defineDoc<BrowserConfig>({ kind: `${name}.config`, version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => structuredClone(UNCONFIGURED) });
  // A fork starts with no sessions: it never shares a live browser.
  const Children = defineDoc<{ byRequest: Record<string, number> }>({ kind: `${name}.children`, version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ byRequest: {} }) });
  const Sessions = defineDoc<SessionsState>({ kind: `${name}.sessions`, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ current: {}, sessions: [], notice: null }) });

  const attachments = new Map<string, D>();
  const observers = new Map<string, EffectObserver | null>();
  const { run: serialize } = keyedSerializer();
  const idle = idleTracker<ConversationId>({ idleMs: DEFAULT_BROWSER_POLICY.idleReleaseS * 1000, onIdle: (cid, fired, idleMs) => void releaseIdle(cid, fired, idleMs).catch(() => undefined) });
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
    try { await options.onObserver?.(row); } catch {}
  }

  async function emit(cid: ConversationId, label: string, record: SessionRecord, change: SessionChange, provider?: BrowserProvider): Promise<void> {
    if (!options.onSession) return;
    try {
      const ref = record.resourceId === null ? null : { id: record.resourceId, tag: record.tag };
      const view = change !== "released" && ref && provider?.liveView ? await provider.liveView(ref) : null;
      // The live view's own URLs go to the host as they are (it needs their token); a browsed page's URL and title are
      // scrubbed, since its query can carry a credential.
      const liveView = view && { ...view, pages: view.pages.map((page) => ({ ...page, url: page.url === null ? null : scrubPageUrl(page.url, redact), title: page.title === null ? null : redact(page.title) })) };
      await options.onSession({ conversationId: cid, label, session: record, liveView }, change);
    } catch {}
  }

  /** Class name and redacted message only: a vendor SDK's error text can repeat the request's credentials. */
  const scrubbed = (error: unknown) => Object.assign(new Error(redact(error instanceof Error ? error.message : String(error))), { name: error instanceof Error ? error.name : "Error" });
  const prices = resolvePrices(options.prices);
  const priceState: PriceState = prices.sessionUsdPerHour === null ? "unpriced" : "priced";
  const meter = (spent: SessionRecord["spent"], at: string, final = false) => {
    const charged = sessionCharge(spent, at, prices, priceState, final);
    return { spent: { ...charged.spent, state: charged.usage.state }, usage: charged.usage };
  };
  const { Inventory, move, addNotice, begin, requestRelease, bindByTag, emitReleased, ReleaseTask, reconcileAll } = custodyStore({ name, Config, Sessions, providerOf, emit, meter, scrubbed, createDeadlineMs: options.createDeadlineMs ?? CREATE_DEADLINE_MS });

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

  /** Let go of a dead driver connection and nothing else: a healthy observer stays attached, so a page that sends
   *  something before the next call is still held. When the observer is dead too, both go. */
  async function detachDriver(tag: string): Promise<void> {
    if (observers.get(tag)?.closed) return detach(tag);
    const driver = attachments.get(tag);
    attachments.delete(tag);
    if (driver) await closeDriver(driver);
  }

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

  async function markEnded(scope: Scope, record: SessionRecord, provider: BrowserProvider): Promise<boolean> {
    const status = await provider.status({ id: record.resourceId!, tag: record.tag }, scope.signal).catch(() => "running" as const);
    if (status !== "gone" && status !== "stopped") return false;
    await scope.commit((tx) => move(tx, rowOf(scope.cid, record), { state: "released", reason: "ended", at: now() }));
    await detach(record.tag);
    await emitReleased(scope.cid, record.tag, scope.read, scope.context);
    return true;
  }

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

  /** Custody's notice is kept in the call's memo before it is cleared, so a call rerun after a crash still tells it. */
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
        // The relaunch's session is chosen in a memo before its create commits: a rerun runs on it or says
        // session_replaced, never a second launch; a memo with no record yet is an uncommitted create and goes ahead.
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
        // A page URL can carry a credential in any query value, its fragment or its userinfo: scrubbed before it is
        // committed or reported.
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

  /** A plane nobody calls for its idle window is released, never mid-call. A dead process's timers die with it, and the
   *  provider's own idle bound takes over. */
  async function releaseIdle(cid: ConversationId, fired: NodeJS.Timeout, idleMs: number): Promise<void> {
    const conversation = opened && await opened.harness.conversation(cid, opened.context);
    if (!conversation) return;
    // Only the still-current timer releases, checked inside the commit: a call since, even one that ran while the
    // lookup above waited, replaced it.
    await releasePlane(conversation, "idle", opened!.context, () => idle.isCurrent(cid, fired), Math.round(idleMs / 1000));
  }

  /** A release the model did not ask for (idle, close) commits its notice with it, so whichever call next attaches a
   *  session tells it, even when the call that opened the replacement failed or died. */
  async function releasePlane(conversation: Pick<Conversation, "id" | "commit">, reason: ReleaseReason, context: Context, still: () => boolean = () => true, idleS = 0): Promise<void> {
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
    if (released) idle.cancel(conversation.id);
  }

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
        idle.activity(api.conversationId, +1, (config?.policy.idleReleaseS ?? 0) * 1000);
        try {
          const call = { callId: api.callId, conversationId: api.conversationId, signal: context.abortSignal, label: config?.label ?? "", redact, evidence: options.evidence, classifyPage: options.decisions?.classifyPage };
          // Inside an async function, so a host tool that throws before it returns a promise is caught too.
          const out = await (async () => impls[contract.name]!(args, portFor(api, context), call))().catch((error): ToolOutput => {
            // A throw would reach pi's diagnostic unscrubbed: every failure comes back as the typed envelope, redacted.
            const typed = error instanceof BrowserFailureError ? error.failure : classifyBrowserError(error, contract.effect === "effect", { aborted: context.abortSignal?.aborted === true });
            return { content: [{ type: "text", text: JSON.stringify(typed) }], isError: true };
          });
          // A charge that cannot be committed now is carried by the next one.
          const usage = withSessionTime(out.usage, await chargeCall(api, context).catch(() => null));
          return {
            ...forModel(out.content.map((item) => item.type === "text" ? { ...item, text: redact(item.text) } : item)),
            ...(out.isError ? { isError: true } : {}),
            ...(out.details ? { details: redactDeep(out.details, redact) as JsonValue } : {}),
            ...(usage ? { usage: usage as unknown as Usage } : {}),
          };
        } finally {
          idle.activity(api.conversationId, -1);
        }
      },
    }));
  const names = new Set(tools.map((tool) => tool.name));

  const childConversation = (api: ToolExecutionApi, context: Context): ChildRunner => async (task) => {
    const config = await api.snapshot(Config, api.conversationId, context);
    const childTools = (await api.agent(context)).tools.filter((tool) => CHILD_TOOLS.has(tool.name));
    // One child per request, recorded in the commit that creates it: a replay or a repeated call finds it again, and
    // its submission is deduplicated by request_id.
    const id = await api.commit(async (tx) => {
      const children = await tx.doc(Children, api.conversationId);
      const key = `${task.site}:${task.requestId}`;
      const known = children.byRequest[key];
      if (known !== undefined) return known as ConversationId;
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      await configure(tx, child.id, { tools: childTools, instructions: null });
      Object.assign(await tx.doc(Config, child.id), config ?? UNCONFIGURED);
      children.byRequest[key] = child.id as number;
      return child.id;
    }, context);
    const child = await api.conversation(id, context);
    if (!child) throw new Error("the child conversation is gone");
    try {
      const settled = await (await child.submit({ type: "input", content: task.prompt, requestId: task.requestId }, context)).wait(context);
      const report = await api.commit(async (tx) => {
        for (const entry of (await tx.scanEntries({ conversationId: id, order: "descending" }, 50)).items) {
          for (const message of [...(entry.model ?? [])].reverse()) {
            if (message.role !== "assistant") continue;
            const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
            if (text) return text;
          }
        }
        return "";
      }, context);
      if (settled.status !== "done" || !report) throw new Error("the child finished without a report");
      return report;
    } finally {
      await releasePlane({ id, commit: (change, ctx) => api.commit(change, ctx) }, "close", context).catch(() => undefined);
    }
  };
  const siteTools = options.sites ? [((sites) => {
    const contract = useWebsiteContract(sites.listing);
    return defineTool({
      name: contract.name,
      description: contract.description,
      parameters: contract.parameters as unknown as TSchema,
      replay: contract.replay,
      executionMode: contract.executionMode,
      execute: async (args, api, context) => {
        const out = await useWebsite(args as Record<string, unknown>, sites.port, sites.listing, { signal: context.abortSignal ?? new AbortController().signal, runChild: childConversation(api, context) });
        return { ...forModel(out.content.map((item) => item.type === "text" ? { ...item, text: redact(item.text) } : item)), ...(out.isError ? { isError: true } : {}) };
      },
    });
  })(options.sites)] : [];

  const section: PromptSection = {
    key: name,
    async render(input, context) {
      if (!input.agent.tools.some((tool) => names.has(tool.name))) return undefined;
      const config = await input.read.snapshot(Config, input.conversationId, context);
      return [browserSection({ idleReleaseS: config?.policy.idleReleaseS ?? UNCONFIGURED.policy.idleReleaseS }), options.section?.addendum].filter(Boolean).join("\n\n");
    },
  };

  return {
    extension: defineExtension({ name, tools: [...tools, ...siteTools], sections: [section], tasks: [ReleaseTask] }),
    docs: { Config, Sessions, Inventory, Children },
    tools: [...tools, ...siteTools],
    release: (conversation, reason, context) => releasePlane(conversation, reason, context),
    async reconcile(harness, isActive, context) {
      opened = { harness, context };
      return reconcileAll(harness, isActive, context);
    },
    async close() {
      idle.clear();
      // A session whose driver was let go and not yet replaced still has its observer attached: close both kinds.
      await Promise.all([...new Set([...attachments.keys(), ...observers.keys()])].map(detach));
    },
  };
}
