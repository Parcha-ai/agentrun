import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { configure, defineDoc, defineExtension, defineTool, ToolResultEntry, type Conversation, type ConversationDocToken, type ConversationId, type DocumentReader, type EntryId, type Extension, type Harness, type PromptSection, type SessionDocToken, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema, Usage } from "@earendil-works/pi-ai";
import { BROWSER_TOOL_NAMES, BROWSER_TOOLS, browserSection, WEB_TOOL_NAMES } from "./core/contract.js";
import { BrowserFailureError, closeDriver, currentRecord, loadedNoPage, custodyTools, FIXED_SESSION_RELAUNCH, fenced, HANDED_BACK, newSessionRecord, notices, NAVIGATION_CAP, NOTHING_TO_HOLD, profileRefusal, relaunchRefusal, SESSION_REPLACED, sessionSpec, waitingForHuman, type AttachedSession, type CustodyPort, type DriverFactory, type FenceMark, type Overrides, type ToolOutput } from "./core/custody.js";
import { forModel } from "./durable-result.js";
import type { Decisions } from "./core/decisions.js";
import type { EvidenceSink } from "./core/evidence.js";
import { EffectObserver, effectDecider, observerFailure } from "./core/effects.js";
import { browserFailure, classifyBrowserError } from "./core/failures.js";
import { workspaceFiles } from "./core/files.js";
import type { RepeatGuard } from "./core/guard.js";
import { drivingGuarded } from "./core/driving-guard.js";
import { drivingGates, personOn, rearmWhenLeft, type DrivingGate } from "./core/driving.js";
import type { DrivingGates } from "./live-view/protocol.js";
import { pageTools, type BrowserToolImpls, type PageDriver, type ToolImpl } from "./core/tools.js";
import type { BrowserConfig, BrowserProvider, ChildRunner, InventoryRow, ObserverRow, PendingEffect, PriceState, PriceTable, ReconcileReport, ReleaseReason, SessionChange, SessionRecord, SessionRow, SessionsState, SiteInfo, SiteRunPort, ToolUsage, WorkspaceFiles } from "./core/host.js";
import { useWebsite, useWebsiteContract } from "./core/sites.js";
import { leaseTag, type LeaseRef } from "./core/lease.js";
import { createRedactor, redactDeep, scrubPageUrl, type Redact } from "./core/redact.js";
import { CREATE_DEADLINE_MS, DEFAULT_BROWSER_POLICY, idleTracker, keyedSerializer, oneAtATime, providerKeyValues, type IdleTracker, type KeyedSerializer } from "./core/session-control.js";
import { custodyStore, now } from "./store.js";
import { resolvePrices, sessionCharge } from "./core/usage.js";

export type { BrowserToolArgs, BrowserToolImpls, PageDriver, ToolCall, ToolImpl } from "./core/tools.js";
export type { DriverFactory, DriverOptions } from "./core/custody.js";

export type BrowserExtensionOptions<D extends PageDriver = PageDriver> = {
  /** Default "browser"; a second plane installs a second extension under another name. */
  name?: string;
  /** Called per use: the provider for this conversation's plane. Holds the credentials in its closure; nothing it
   *  returns is committed. */
  provider: (target: { conversationId: ConversationId; plane: string; config: BrowserConfig }) => BrowserProvider | Promise<BrowserProvider>;
  driver: DriverFactory<D>;
  /** Implementations by contract name, over the package's own; a contract tool with no implementation is not listed. */
  tools?: Partial<BrowserToolImpls<D>>;
  evidence: EvidenceSink;
  /** Where `browser_downloads` writes files and, without `files`, where `browser_upload` reads them; absent, neither is listed. */
  workspace?: (conversationId: ConversationId) => string;
  /** Resolves `browser_upload` paths; defaults to files under `workspace`. */
  files?: WorkspaceFiles;
  /** `use_website`'s sites; absent, the tool is not listed. `listing` is the port's `list()`, read once at host setup:
   *  the tool's description renders from it. Each local child runs in a conversation this call owns. */
  sites?: { port: SiteRunPort; listing: readonly SiteInfo[] };
  /** Live view and session status; a throw here never fails a call. */
  onSession?: (row: SessionRow, change: SessionChange) => void | Promise<void>;
  /** The person/model mutex shared with the live view (`createLiveView`'s `gates`); the default, the package's process-wide `drivingGates`, is the one the live view
   *  defaults to as well. Pass it here only together with the same registry there. */
  gates?: DrivingGates;
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
  /** Called synchronously at two moments of a page action, for a host that kills the process there to test a resume:
   *  `browser.between-actions` once a page action's answer is committed, before the next page action dispatches, and
   *  `browser.action-returned` once the driver call returned (or threw) and the action's entry is marked finished,
   *  before pi commits its answer. A throw, or a rejected promise, is a process warning (`PI_BROWSER_CROSSING`) and
   *  never changes the call. */
  crossing?: (point: Crossing) => void;
};

type Crossing = "browser.between-actions" | "browser.action-returned";

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
  /** Shutdown is release, `waitForIdle`, `drain`, close: resolves when none of this extension's release tasks is live. */
  drain(harness: Harness, context: Context, signal?: AbortSignal): Promise<void>;
  /** Drop in-memory driver attachments and idle timers (process exit); never releases. */
  close(): Promise<void>;
  /** How many conversations the extension still holds in-memory state for: a repeat guard, an idle timer or a queued call. */
  retained(): number;
};

export { createWebExtension, type WebExtensionOptions } from "./web.js";
export { CONFIRM_POLLS, RELEASE_ATTEMPTS } from "./store.js";

const PLANE = "default";
const UNCONFIGURED: BrowserConfig = { label: "", run: "", policy: DEFAULT_BROWSER_POLICY };
const NOT_CONFIGURED = new BrowserFailureError(browserFailure("browser_unavailable", "This conversation has no browser configuration, so no browser can be launched here; use web_fetch or another source."));
const emptySessions = (): SessionsState => ({ current: {}, sessions: [], notice: null });

async function drainReleases(name: string, harness: Harness, context: Context, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const drained = (async () => {
    for (;;) {
      const live = (await harness.inspect(context)).tasks.filter((task) => task.record.kind === `${name}.release`);
      if (!live.length) return;
      await Promise.all(live.map((task) => harness.waitForTask(task.record.id, context)));
    }
  })();
  if (!signal) return drained;
  const done = new AbortController();
  try {
    await Promise.race([drained, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true, signal: done.signal }))]);
  } finally {
    done.abort();
  }
}
const open = (record: SessionRecord | null | undefined) => record?.state === "live" || record?.state === "creating";
const releasable = (record: SessionRecord | null | undefined, reason: ReleaseReason) => open(record) || (record?.state === "held" && reason !== "idle");
const waiting = (record: SessionRecord) => new BrowserFailureError(waitingForHuman(record.handoff!));
// A child gets the browser and web tools only: never use_website, so it cannot start children of its own, and never
// browser_upload or browser_downloads, since its report is all that crosses back (invariant 10) and a site run has no files.
const CHILD_TOOLS = new Set<string>([...BROWSER_TOOL_NAMES, ...WEB_TOOL_NAMES].filter((name) => name !== "browser_upload" && name !== "browser_downloads"));

type Scope = { cid: ConversationId; plane: string; context: Context; read: DocumentReader; signal: AbortSignal; commit<T>(change: (tx: Tx) => Promise<T>): Promise<T>; keep(slot: string, value: string): Promise<string> };
type Readers<D extends PageDriver> = { options: BrowserExtensionOptions<D>; redact: Redact; Config: ConversationDocToken<BrowserConfig> };
type Custody<D extends PageDriver> = Readers<D> & {
  name: string;
  Sessions: ConversationDocToken<SessionsState>;
  Children: ConversationDocToken<{ byRequest: Record<string, number> }>;
  store: ReturnType<typeof custodyStore>;
  meter(spent: SessionRecord["spent"], at: string, final?: boolean): { spent: SessionRecord["spent"]; usage: ToolUsage };
  held: Attachments<D>;
  fences: Map<string, FenceMark>;
  serial: KeyedSerializer;
  /** Children whose provider shares one browser run one at a time. */
  childTurns: <T>(run: () => Promise<T>) => Promise<T>;
  idle: IdleTracker<ConversationId>;
  /** The poll of each session an idle release kept for a person (#1098), by tag: stopped when the session is released. */
  leaving: Map<string, () => void>;
  guards: Map<number, RepeatGuard>;
  opened: { harness: Harness; context: Context } | null;
  /** This process's custody: a journal entry written by another one belongs to a resumed run. */
  incarnation: string;
};

class Attachments<D extends PageDriver> {
  private readonly drivers = new Map<string, D>();
  private readonly observers = new Map<string, EffectObserver | null>();

  driver(tag: string): D | undefined {
    return this.drivers.get(tag);
  }

  observer(tag: string): EffectObserver | null | undefined {
    return this.observers.get(tag);
  }

  attach(tag: string, driver: D, observer: EffectObserver | null): void {
    this.observers.set(tag, observer);
    this.drivers.set(tag, driver);
  }

  async detach(tag: string): Promise<void> {
    const driver = this.drivers.get(tag);
    this.drivers.delete(tag);
    this.observers.get(tag)?.close();
    this.observers.delete(tag);
    if (driver) await closeDriver(driver);
  }

  /** Let go of a dead driver connection and nothing else: a healthy observer stays attached, so a page that sends
   *  something before the next call is still held. When the observer is dead too, both go. */
  async detachDriver(tag: string): Promise<void> {
    if (this.observers.get(tag)?.closed) return this.detach(tag);
    const driver = this.drivers.get(tag);
    this.drivers.delete(tag);
    if (driver) await closeDriver(driver);
  }

  tags(): string[] {
    return [...new Set([...this.drivers.keys(), ...this.observers.keys()])];
  }
}

async function configOf<D extends PageDriver>(c: Readers<D>, read: DocumentReader, cid: ConversationId, context: Context): Promise<BrowserConfig> {
  const config = await read.snapshot(c.Config, cid, context);
  if (!config?.run) throw NOT_CONFIGURED;
  return config as BrowserConfig;
}

async function providerOf<D extends PageDriver>(c: Readers<D>, read: DocumentReader, cid: ConversationId, plane: string, context: Context): Promise<BrowserProvider> {
  return c.options.provider({ conversationId: cid, plane, config: await configOf(c, read, cid, context) });
}

const rowOf = (cid: ConversationId, record: SessionRecord): InventoryRow =>
  ({ tag: record.tag, conversationId: cid, plane: record.plane, provider: record.provider, resourceId: record.resourceId, state: record.state });

async function emitObserver<D extends PageDriver>(c: Readers<D>, row: ObserverRow): Promise<void> {
  try { await c.options.onObserver?.(row); } catch {}
}

/** The host's crossing: called synchronously; what it throws or rejects with is reported and never reaches the call. */
function cross<D extends PageDriver>(c: Readers<D>, point: Crossing): void {
  const crossing = c.options.crossing;
  if (!crossing) return;
  const warn = (error: unknown) => process.emitWarning(`pi-browser: the host's crossing threw at ${point}; the call goes on: ${error instanceof Error ? error.message : String(error)}`, { code: "PI_BROWSER_CROSSING" });
  // Promise.resolve, not instanceof: a promise from another realm (node:vm) is caught too.
  try { Promise.resolve(crossing(point) as unknown).catch(warn); } catch (error) { warn(error); }
}

async function emit<D extends PageDriver>(c: Readers<D>, cid: ConversationId, label: string, record: SessionRecord, change: SessionChange, provider?: BrowserProvider): Promise<void> {
  if (!c.options.onSession) return;
  try {
    const ref = record.resourceId === null ? null : { id: record.resourceId, tag: record.tag };
    const view = change !== "released" && ref && provider?.liveView ? await provider.liveView(ref) : null;
    // The live view's own URLs go to the host as they are (it needs their token); a browsed page's URL and title are
    // scrubbed, since its query can carry a credential.
    const liveView = view && { ...view, pages: view.pages.map((page) => ({ ...page, url: page.url === null ? null : scrubPageUrl(page.url, c.redact), title: page.title === null ? null : c.redact(page.title) })) };
    await c.options.onSession({ conversationId: cid, label, session: record, liveView }, change);
  } catch {}
}

async function stateOf<D extends PageDriver>(c: Custody<D>, scope: Scope): Promise<SessionsState> {
  return ((await scope.read.snapshot(c.Sessions, scope.cid, scope.context)) as SessionsState | undefined) ?? emptySessions();
}

const failure = (error: unknown, scope: Scope) =>
  error instanceof BrowserFailureError ? error : new BrowserFailureError(classifyBrowserError(error, false, { aborted: scope.signal.aborted }));

async function attachLive<D extends PageDriver>(c: Custody<D>, scope: Scope, record: SessionRecord): Promise<D | null> {
  const held = c.held.driver(record.tag);
  // An observer whose socket closed holds nothing: driver and observer are attached again together.
  if (held && !c.held.observer(record.tag)?.closed) return held;
  if (held) await c.held.detach(record.tag);
  const provider = await providerOf(c, scope.read, scope.cid, scope.plane, scope.context);
  const ref: LeaseRef = { id: record.resourceId!, tag: record.tag };
  try {
    return await connect(c, scope, provider, ref);
  } catch (error) {
    if (!(await markEnded(c, scope, record, provider))) throw failure(error, scope);
    return null;
  }
}

async function connect<D extends PageDriver>(c: Custody<D>, scope: Scope, provider: BrowserProvider, ref: LeaseRef): Promise<D> {
  const config = await configOf(c, scope.read, scope.cid, scope.context);
  const { actions: policy, batchTimeoutMs } = config.policy;
  const target = await provider.attach(ref, scope.signal);
  const driver = await c.options.driver(target, scope.signal, { batchTimeoutMs });
  let unattached: unknown = null;
  // A healthy observer that outlived its driver's connection is kept, not opened a second time.
  const kept = c.held.observer(ref.tag);
  const open = c.options.openObserver ?? EffectObserver.open.bind(EffectObserver);
  const observer = kept && !kept.closed ? kept : policy ? await open(target, policy === "allow" ? null : effectDecider(policy, c.options.decisions), batchTimeoutMs).catch((error) => { unattached = error; return null; }) : null;
  // A policy that holds requests never degrades to browsing without the hold.
  if (policy && policy !== "allow" && !observer) {
    await closeDriver(driver);
    throw new BrowserFailureError(browserFailure("browser_unavailable", "The browser's request observer could not attach, and this run's action policy needs it to hold requests; the browser is not used without it.", { retryable: true }));
  }
  c.held.attach(ref.tag, driver, observer);
  if (policy === "allow" && !observer) await emitObserver(c, { conversationId: scope.cid, label: config.label, tag: ref.tag, session_id: ref.id, policy, code: observerFailure(unattached) });
  return driver;
}

async function markEnded<D extends PageDriver>(c: Custody<D>, scope: Scope, record: SessionRecord, provider: BrowserProvider): Promise<boolean> {
  const status = await provider.status({ id: record.resourceId!, tag: record.tag }, scope.signal).catch(() => "running" as const);
  if (status !== "gone" && status !== "stopped") return false;
  await scope.commit((tx) => c.store.move(tx, rowOf(scope.cid, record), { state: "released", reason: "ended", at: now() }));
  await c.held.detach(record.tag);
  await c.store.emitReleased(scope.cid, record.tag, scope.read, scope.context);
  return true;
}

async function refuseHeld<D extends PageDriver>(c: Custody<D>, scope: Scope, record: SessionRecord | null | undefined): Promise<void> {
  if (record?.state === "held" && !(await markEnded(c, scope, record, await providerOf(c, scope.read, scope.cid, scope.plane, scope.context)))) throw waiting(record);
}

async function settleCreating<D extends PageDriver>(c: Custody<D>, scope: Scope, record: SessionRecord): Promise<void> {
  const provider = await providerOf(c, scope.read, scope.cid, scope.plane, scope.context);
  try { await c.store.bindByTag(provider, rowOf(scope.cid, record), scope.commit, scope.signal); } catch (error) { throw failure(error, scope); }
}

async function create<D extends PageDriver>(c: Custody<D>, scope: Scope, overrides: Overrides, presetTag?: string): Promise<{ record: SessionRecord; driver: D }> {
  const config = await configOf(c, scope.read, scope.cid, scope.context);
  const provider = await c.options.provider({ conversationId: scope.cid, plane: scope.plane, config });
  const tag = presetTag ?? leaseTag("ar", config.run, scope.cid, (await stateOf(c, scope)).sessions.length + 1);
  const spec = sessionSpec(config, tag, overrides);
  const unsupported = profileRefusal(spec, provider.caps);
  if (unsupported) throw new BrowserFailureError(unsupported);
  const record = newSessionRecord({ plane: scope.plane, tag, provider: provider.name, spec, at: now(), honours: provider.caps.settings });
  const row = rowOf(scope.cid, record);
  await scope.commit(async (tx) => {
    const state = await tx.doc(c.Sessions, scope.cid);
    state.sessions.push(record);
    state.current[scope.plane] = state.sessions.length - 1;
    await c.store.begin(tx, row);
  });
  // An answer lost on the way back is not a session that never started: it is settled by its tag.
  const ref = await provider.create(spec, scope.signal).then(
    async (made) => { await scope.commit((tx) => c.store.move(tx, row, { state: "live", resourceId: made.id, at: now() })); return made; },
    async (error) => (await c.store.bindByTag(provider, row, scope.commit, scope.signal, await provider.findByTag(tag, scope.signal).catch(() => []))) ?? Promise.reject(failure(error, scope)));
  const live: SessionRecord = { ...record, state: "live", resourceId: ref.id };
  try {
    const driver = await connect(c, scope, provider, ref);
    await emit(c, scope.cid, config.label, live, "launched", provider);
    return { record: live, driver };
  } catch (error) { throw failure(error, scope); }
}

async function acquire<D extends PageDriver>(c: Custody<D>, scope: Scope): Promise<{ record: SessionRecord; driver: D; note: string | null }> {
  let note: string | null = null;
  for (let turn = 0; turn < 4; turn += 1) {
    const record = currentRecord(await stateOf(c, scope), scope.plane);
    if (record?.state === "held") {
      await refuseHeld(c, scope, record);
      note = notices.ended(record.lastUrl);
    } else if (record?.state === "live") {
      const driver = await attachLive(c, scope, record);
      if (driver) return { record, driver, note };
      note = notices.ended(record.lastUrl);
    } else if (record?.state === "creating") {
      await settleCreating(c, scope, record);
    } else {
      return { ...(await create(c, scope, {})), note };
    }
  }
  throw new Error(`browser custody for conversation ${scope.cid} did not settle`);
}

/** Custody's notice is kept in the call's memo before it is cleared, so a call rerun after a crash still tells it. */
async function attached<D extends PageDriver>(c: Custody<D>, scope: Scope, record: SessionRecord, driver: D, note: string | null): Promise<AttachedSession<D>> {
  const state = await stateOf(c, scope);
  const notice = await scope.keep("notice", [note, state.notice].filter(Boolean).join(" "));
  if (state.notice !== null) await scope.commit(async (tx) => { (await tx.doc(c.Sessions, scope.cid)).notice = null; });
  const fresh = state.sessions.find((r) => r.tag === record.tag) ?? record;
  const interrupted = await cutOf(c, scope, journalOf(state, scope.plane));
  const provider = await providerOf(c, scope.read, scope.cid, scope.plane, scope.context);
  const fence = fresh.fence ?? 0;
  return { driver: fenced(driver, fence, () => c.fences.get(record.tag)), tag: record.tag, sessionId: fresh.resourceId!, record: fresh, notice: notice || null, interrupted, recorded: Boolean(provider.recordings), effects: c.held.observer(record.tag) ?? null, fence, downloads: provider.downloads ?? null, replaced: replacedOf(state, scope.plane, fresh) };
}

/** The session the current one replaced after a release the model did not ask for, while the current one has loaded no
 *  page: the plane's last record before it that went live (a launch that failed in between never replaces it), released
 *  (or being released) for idle or close. */
function replacedOf(state: SessionsState, plane: string, current: SessionRecord): AttachedSession<PageDriver>["replaced"] {
  if (!loadedNoPage(current)) return null;
  const on = state.sessions.filter((r) => r.plane === plane);
  const before = on.slice(0, on.findIndex((r) => r.tag === current.tag)).reverse().find((r) => r.releaseReason !== "create_failed");
  if (!before || (before.state !== "releasing" && before.state !== "released")) return null;
  return before.releaseReason === "idle" || before.releaseReason === "close" ? { reason: before.releaseReason, at: before.endedAt, lastUrl: before.lastUrl } : null;
}

async function releaseRecord<D extends PageDriver>(c: Custody<D>, scope: Scope, record: SessionRecord, reason: ReleaseReason): Promise<void> {
  await scope.commit((tx) => c.store.requestRelease(tx, rowOf(scope.cid, record), reason, now()));
  await c.held.detach(record.tag);
}

const editState = <D extends PageDriver>(c: Custody<D>, scope: Scope, edit: (state: SessionsState) => void) =>
  scope.commit(async (tx) => edit(await tx.doc(c.Sessions, scope.cid)));
const journalOf = (state: SessionsState, plane: string) => [...state.sessions].reverse().find((r) => r.plane === plane && r.pendingEffect !== null)?.pendingEffect ?? null;
const clearJournal = <D extends PageDriver>(c: Custody<D>, scope: Scope, callId: string) =>
  editState(c, scope, (state) => { for (const record of state.sessions) if (record.plane === scope.plane && record.pendingEffect?.callId === callId) record.pendingEffect = null; });

/** A journaled action's own answer as pi committed it, found by pi's typed tool-result entry: true for a success, false
 *  for an error, null for none yet. The scan covers only the entry's conversation from where it was journaled on, never
 *  the whole history. */
async function answerOf(scope: Scope, pending: PendingEffect): Promise<boolean | null> {
  const after = pending.after;
  if (after === undefined) return null;
  return scope.commit(async (tx) => {
    let cursor: Parameters<Tx["scanEntries"]>[2];
    do {
      const page = await tx.scanEntries({ conversationId: scope.cid, minEntryId: after as EntryId, order: "ascending" }, 100, cursor);
      for (const entry of page.items) {
        const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;
        if (message?.role === "toolResult" && message.toolCallId === pending.callId) return message.isError !== true;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return null;
  });
}

/** Whether a journaled action's own answer was committed as a success. */
const answered = async (scope: Scope, pending: PendingEffect) => (await answerOf(scope, pending)) === true;

/** The cut a call answers for. In this process an entry is in flight or answered, never cut; one an earlier process
 *  wrote is a cut unless its action finished and pi committed its answer, which only then is looked up. */
async function cutOf<D extends PageDriver>(c: Custody<D>, scope: Scope, pending: PendingEffect | null): Promise<PendingEffect | null> {
  if (!pending || pending.incarnation === c.incarnation) return null;
  if (!pending.finished || pending.told || !(await answered(scope, pending))) return pending;
  await clearJournal(c, scope, pending.callId);
  return null;
}

async function relaunchOn<D extends PageDriver>(c: Custody<D>, scope: Scope, api: ToolExecutionApi, slot: string, overrides: Overrides): Promise<AttachedSession<D>> {
  const config = await configOf(c, scope.read, scope.cid, scope.context);
  const refusal = relaunchRefusal(config.policy, overrides);
  if (refusal) throw new BrowserFailureError(refusal);
  await refuseHeld(c, scope, currentRecord(await stateOf(c, scope), scope.plane));
  // A session the host assigned is the only one: refused before anything is released.
  if ((await providerOf(c, scope.read, scope.cid, scope.plane, scope.context)).caps.fixedSession) throw new BrowserFailureError(FIXED_SESSION_RELAUNCH);
  // The relaunch's session is chosen in a memo before its create commits: a rerun runs on it or says
  // session_replaced, never a second launch; a memo with no record yet is an uncommitted create and goes ahead.
  const find = async (tag: string | undefined) => (await stateOf(c, scope)).sessions.find((r) => r.tag === tag);
  const launched = await api.memo<string>(slot, scope.context);
  let mine = await find(launched);
  if (mine) {
    if (mine.state === "creating") { await settleCreating(c, scope, mine); mine = await find(launched); }
    const driver = mine?.state === "live" ? await attachLive(c, scope, mine) : null;
    if (!mine || !driver) throw new BrowserFailureError(SESSION_REPLACED);
    return attached(c, scope, mine, driver, null);
  }
  const state = await stateOf(c, scope);
  const tag = launched ?? await api.memo(slot, leaseTag("ar", config.run, scope.cid, state.sessions.length + 1), scope.context);
  const old = currentRecord(state, scope.plane);
  if (old && open(old) && old.tag !== tag) await releaseRecord(c, scope, old, "relaunch");
  const made = await create(c, scope, overrides, tag);
  return attached(c, scope, made.record, made.driver, null);
}

function portFor<D extends PageDriver>(c: Custody<D>, api: ToolExecutionApi, context: Context): CustodyPort<D> {
  const memo = (slot: string) => `${c.name}:${slot}:${PLANE}`;
  const scope: Scope = { cid: api.conversationId, plane: PLANE, context, read: api, signal: context.abortSignal ?? new AbortController().signal, commit: (change) => api.commit(change, context), keep: async (slot, value) => {
    // An earlier attempt's text comes first; an empty one is never memoized, so it cannot shadow a later notice.
    const prior = await api.memo<string>(memo(slot), context);
    if (prior !== undefined) return [prior, value].filter(Boolean).join(" ");
    return value ? api.memo(memo(slot), value, context) : "";
  } };
  const key = `${scope.cid}:${scope.plane}`;
  return {
    session: () => c.serial.run(key, async () => {
      const ran = await api.memo<string>(memo("ran"), context);
      if (ran !== undefined) {
        const record = (await stateOf(c, scope)).sessions.find((r) => r.tag === ran);
        await refuseHeld(c, scope, record);
        const driver = record?.state === "live" ? await attachLive(c, scope, record) : null;
        if (!record || !driver) throw new BrowserFailureError(SESSION_REPLACED);
        return attached(c, scope, record, driver, null);
      }
      const { record, driver, note } = await acquire(c, scope);
      await api.memo(memo("ran"), record.tag, context);
      return attached(c, scope, record, driver, note);
    }),
    relaunch: (overrides) => c.serial.run(key, () => relaunchOn(c, scope, api, memo("relaunch"), overrides)),
    // A held session is still the attached one (a person's): the live view's gate checks a release against it.
    current: async () => { const record = currentRecord(await stateOf(c, scope), scope.plane); return record && (open(record) || record.state === "held") ? record.tag : null; },
    release: () => c.serial.run(key, async () => {
      const record = currentRecord(await stateOf(c, scope), scope.plane);
      if (!record || !releasable(record, "tool")) {
        // Only a release under way or done says so: a lost record is custody giving up, and its browser may still run.
        const ended = (record?.state === "releasing" || record?.state === "released") && record.releaseReason ? { ended: { reason: record.releaseReason, at: record.endedAt } } : {};
        return { released: record?.state === "releasing", sessionId: record?.resourceId ?? null, ...ended };
      }
      await releaseRecord(c, scope, record, "tool");
      return { released: true, sessionId: record.resourceId };
    }),
    dispatching: async (effect) => {
      // The host's mid-browse crossing: the page action before this one finished and pi committed its answer.
      if (c.options.crossing) {
        const previous = journalOf(await stateOf(c, scope), scope.plane);
        if (previous?.finished && (await answerOf(scope, previous)) !== null) cross(c, "browser.between-actions");
      }
      await scope.commit(async (tx) => {
        const record = currentRecord(await tx.doc(c.Sessions, scope.cid), scope.plane);
        if (!record) return;
        const newest = (await tx.scanEntries({ conversationId: scope.cid, order: "descending" }, 1)).items[0]?.id;
        record.pendingEffect = { ...effect, url: effect.url === null ? null : scrubPageUrl(effect.url, c.redact), at: now(), sent: [], incarnation: c.incarnation, ...(newest === undefined ? {} : { after: newest as number }) };
      });
    },
    journal: (row) => editState(c, scope, (state) => {
      const pending = currentRecord(state, scope.plane)?.pendingEffect;
      if (!pending) return;
      const sent = pending.sent ?? (pending.sent = []);
      const scrubbed = { ...row, origin: c.redact(row.origin), path: c.redact(row.path) };
      const at = sent.findIndex((r) => r.requestId === row.requestId);
      if (at === -1) sent.push(scrubbed); else sent[at] = scrubbed;
    }),
    mark: async (step, callId) => {
      const found = { pending: false };
      await editState(c, scope, (state) => {
        const pending = state.sessions.find((r) => r.plane === scope.plane && r.pendingEffect?.callId === callId)?.pendingEffect;
        if (pending) { pending[step] = true; found.pending = true; }
      });
      // The host's double-run crossing: the action's driver call is over and its entry says so; pi has not committed
      // the answer.
      if (found.pending && step === "finished") cross(c, "browser.action-returned");
    },
    settle: (callId) => clearJournal(c, scope, callId),
    navigated: async (page) => {
      // A page URL can carry a credential in any query value, its fragment or its userinfo: scrubbed before it is
      // committed or reported.
      const url = scrubPageUrl(page, c.redact);
      await editState(c, scope, (state) => {
        const record = currentRecord(state, scope.plane);
        if (!record) return;
        record.navigation.push({ at: now(), url });
        if (record.navigation.length > NAVIGATION_CAP) record.navigation.splice(0, record.navigation.length - NAVIGATION_CAP);
        record.lastUrl = url;
      });
      const record = currentRecord(await stateOf(c, scope), scope.plane);
      if (record) await emit(c, scope.cid, (await configOf(c, scope.read, scope.cid, scope.context)).label, record, "updated", await providerOf(c, scope.read, scope.cid, scope.plane, scope.context));
    },
    dropped: () => c.serial.run(key, async () => {
      const record = currentRecord(await stateOf(c, scope), scope.plane);
      if (record) await c.held.detachDriver(record.tag);
    }),
    hold: (requestId) => c.serial.run(key, async () => {
      const record = currentRecord(await stateOf(c, scope), scope.plane);
      if (record?.state === "held" && record.handoff !== requestId) throw waiting(record);
      if (record?.state !== "live" && record?.state !== "held") throw new BrowserFailureError(NOTHING_TO_HOLD);
      if (record.state === "live") {
        await scope.commit((tx) => c.store.move(tx, rowOf(scope.cid, record), { state: "held", handoff: requestId, at: now() }));
        c.fences.set(record.tag, { fence: (record.fence ?? 0) + 1, failure: waitingForHuman(requestId) });
        await c.held.detach(record.tag);
      }
      return { tag: record.tag, sessionId: record.resourceId! };
    }),
    resume: (notice) => c.serial.run(key, async () => {
      const record = currentRecord(await stateOf(c, scope), scope.plane);
      if (record?.state !== "held") return;
      await scope.commit(async (tx) => {
        await c.store.move(tx, rowOf(scope.cid, record), { state: "live", at: now() });
        if (notice) c.store.addNotice(await tx.doc(c.Sessions, scope.cid), notice);
      });
      c.fences.set(record.tag, { fence: (record.fence ?? 0) + 1, failure: HANDED_BACK });
    }),
    ended: async () => {
      const record = currentRecord(await stateOf(c, scope), scope.plane);
      if (record?.state !== "live" && record?.state !== "held") return false;
      return markEnded(c, scope, record, await providerOf(c, scope.read, scope.cid, scope.plane, scope.context));
    },
  };
}

/** A plane nobody calls for its idle window is released, never mid-call. A dead process's timers die with it, and the
 *  provider's own idle bound takes over. */
async function releaseIdle<D extends PageDriver>(c: Custody<D>, cid: ConversationId, fired: NodeJS.Timeout, idleMs: number): Promise<void> {
  const conversation = c.opened && await c.opened.harness.conversation(cid, c.opened.context);
  if (!conversation) return;
  // Only the still-current timer releases, checked inside the commit: a call since, even one that ran while the
  // lookup above waited, replaced it.
  await releasePlane(c, conversation, "idle", c.opened!.context, () => c.idle.isCurrent(cid, fired), Math.round(idleMs / 1000));
}

/** A release the model did not ask for (idle, close) commits its notice with it, so whichever call next attaches a
 *  session tells it, even when the call that opened the replacement failed or died. */
async function releasePlane<D extends PageDriver>(c: Custody<D>, conversation: Pick<Conversation, "id" | "commit">, reason: ReleaseReason, context: Context, still: () => boolean = () => true, idleS = 0): Promise<void> {
  const key = `${conversation.id}:${PLANE}`;
  const kept: { gate: DrivingGate | null; tag: string } = { gate: null, tag: "" };
  const released = await c.serial.run(key, async () => {
    const tags = await conversation.commit(async (tx) => {
      const state = await tx.doc(c.Sessions, conversation.id);
      const record = still() ? currentRecord(state, PLANE) : null;
      if (!record || !releasable(record, reason)) return [];
      // A person driving or watching the session through the live view keeps it from an idle release (#1098); it is
      // released one idle window after they leave.
      kept.gate = reason === "idle" ? personOn(c.options.gates ?? drivingGates, record.tag) : null;
      kept.tag = record.tag;
      if (kept.gate) return [];
      await c.store.requestRelease(tx, rowOf(conversation.id, record), reason, now());
      if (reason === "idle" || reason === "close") c.store.addNotice(state, notices.released(reason, record.lastUrl, idleS));
      return [record.tag];
    }, context);
    for (const tag of tags) await c.held.detach(tag);
    return tags.length > 0;
  });
  if (reason === "close") {
    c.idle.forget(conversation.id);
    c.guards.delete(conversation.id);
  } else if (released) c.idle.cancel(conversation.id);
  else if (kept.gate) {
    const tag = kept.tag;
    c.leaving.get(tag)?.();
    c.leaving.set(tag, rearmWhenLeft(kept.gate, () => c.idle.keys().includes(conversation.id), () => { c.leaving.delete(tag); c.idle.activity(conversation.id, 0); }, idleS * 1000));
  }
}

async function chargeCall<D extends PageDriver>(c: Custody<D>, api: ToolExecutionApi, context: Context): Promise<ToolUsage | null> {
  if (currentRecord(await api.snapshot(c.Sessions, api.conversationId, context), PLANE)?.state !== "live") return null;
  return api.commit(async (tx) => {
    const record = currentRecord(await tx.doc(c.Sessions, api.conversationId), PLANE);
    if (record?.state !== "live") return null;
    const { spent, usage } = c.meter(record.spent, now());
    record.spent = spent;
    return usage;
  }, context);
}

const withSessionTime = (own: ToolOutput["usage"], charged: ToolUsage | null): ToolOutput["usage"] => {
  if (!charged) return own;
  const ownCost = (own?.cost ?? {}) as { total?: number };
  return { ...charged.usage, ...own, cost: { ...charged.usage.cost, ...ownCost, total: charged.usage.cost.total + (ownCost.total ?? 0) } };
};

function toolsFor<D extends PageDriver>(c: Custody<D>, impls: Partial<Record<string, ToolImpl<D>>>): ToolRegistration[] {
  return BROWSER_TOOLS
    .filter((contract) => impls[contract.name] && (contract.listedWhen !== "downloads" || c.options.workspace) && (contract.listedWhen !== "upload" || c.options.files || c.options.workspace))
    .map((contract) => defineTool({
      name: contract.name,
      description: contract.description,
      parameters: contract.parameters as unknown as TSchema,
      replay: contract.replay,
      executionMode: contract.executionMode,
      execute: async (args, api, context) => {
        const config = await api.snapshot(c.Config, api.conversationId, context);
        c.idle.activity(api.conversationId, +1, (config?.policy.idleReleaseS ?? 0) * 1000);
        try {
          const workspace = c.options.workspace?.(api.conversationId);
          const files = c.options.files ?? (workspace === undefined ? undefined : workspaceFiles(workspace));
          const call = { callId: api.callId, conversationId: api.conversationId, signal: context.abortSignal, label: config?.label ?? "", redact: c.redact, evidence: c.options.evidence, classifyPage: c.options.decisions?.classifyPage, workspace, files };
          // Inside an async function, so a host tool that throws before it returns a promise is caught too.
          const out = await (async () => impls[contract.name]!(args, portFor(c, api, context), call))().catch((error): ToolOutput => {
            // A throw would reach pi's diagnostic unscrubbed: every failure comes back as the typed envelope, redacted.
            const typed = error instanceof BrowserFailureError ? error.failure : classifyBrowserError(error, contract.effect === "effect", { aborted: context.abortSignal?.aborted === true });
            return { content: [{ type: "text", text: JSON.stringify(typed) }], isError: true };
          });
          // A charge that cannot be committed now is carried by the next one.
          const usage = withSessionTime(out.usage, await chargeCall(c, api, context).catch(() => null));
          return {
            ...forModel(out.content.map((item) => item.type === "text" ? { ...item, text: c.redact(item.text) } : item)),
            ...(out.isError ? { isError: true } : {}),
            ...(out.details ? { details: redactDeep(out.details, c.redact) as JsonValue } : {}),
            ...(usage ? { usage: usage as unknown as Usage } : {}),
          };
        } finally {
          c.idle.activity(api.conversationId, -1);
        }
      },
    }));
}

function sectionFor<D extends PageDriver>(c: Custody<D>, names: ReadonlySet<string>): PromptSection {
  return {
    key: c.name,
    async render(input, context) {
      if (!input.agent.tools.some((tool) => names.has(tool.name))) return undefined;
      const config = await input.read.snapshot(c.Config, input.conversationId, context);
      const offered = (tool: string) => input.agent.tools.some((t) => t.name === tool && names.has(tool));
      return [browserSection({ idleReleaseS: config?.policy.idleReleaseS ?? UNCONFIGURED.policy.idleReleaseS }, { downloads: offered("browser_downloads"), upload: offered("browser_upload") }), c.options.section?.addendum].filter(Boolean).join("\n\n");
    },
  };
}

function childConversation<D extends PageDriver>(c: Custody<D>, api: ToolExecutionApi, context: Context): ChildRunner {
  return async (task) => {
    const config = await api.snapshot(c.Config, api.conversationId, context);
    const childTools = (await api.agent(context)).tools.filter((tool) => CHILD_TOOLS.has(tool.name));
    // One child per request, recorded in the commit that creates it: a replay or a repeated call finds it again, and
    // its submission is deduplicated by request_id.
    const id = await api.commit(async (tx) => {
      const children = await tx.doc(c.Children, api.conversationId);
      const key = `${task.site}:${task.requestId}`;
      const known = children.byRequest[key];
      if (known !== undefined) return known as ConversationId;
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      await configure(tx, child.id, { tools: childTools, instructions: null });
      Object.assign(await tx.doc(c.Config, child.id), config ?? UNCONFIGURED);
      children.byRequest[key] = child.id as number;
      return child.id;
    }, context);
    const child = await api.conversation(id, context);
    if (!child) throw new Error("the child conversation is gone");
    // Children on a provider whose sessions share one browser would drive the same pages, so there they take turns. One
    // whose provider cannot be looked up waits its turn too: its own browser calls ask the factory again.
    const shared = await providerOf(c, api, id, PLANE, context).then((provider) => provider.caps.sharedBrowser === true, () => true);
    // The turn covers the report and the release too: on a shared browser the next child attaches only once this one has let go.
    const run = async (): Promise<string> => {
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
        await releasePlane(c, { id, commit: (change, ctx) => api.commit(change, ctx) }, "close", context).catch(() => undefined);
      }
    };
    return await (shared ? c.childTurns(run) : run());
  };
}

function siteTool<D extends PageDriver>(c: Custody<D>, sites: NonNullable<BrowserExtensionOptions<D>["sites"]>): ToolRegistration {
  const contract = useWebsiteContract(sites.listing);
  return defineTool({
    name: contract.name,
    description: contract.description,
    parameters: contract.parameters as unknown as TSchema,
    replay: contract.replay,
    executionMode: contract.executionMode,
    execute: async (args, api, context) => {
      const out = await useWebsite(args as Record<string, unknown>, sites.port, sites.listing, { signal: context.abortSignal ?? new AbortController().signal, runChild: childConversation(c, api, context) });
      return { ...forModel(out.content.map((item) => item.type === "text" ? { ...item, text: c.redact(item.text) } : item)), ...(out.isError ? { isError: true } : {}) };
    },
  });
}

export function createBrowserExtension<D extends PageDriver>(options: BrowserExtensionOptions<D>): BrowserExtensionHandle {
  const name = options.name ?? "browser";
  const redact = createRedactor(() => providerKeyValues(process.env, options.redact?.values));
  const Config = defineDoc<BrowserConfig>({ kind: `${name}.config`, version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => structuredClone(UNCONFIGURED) });
  const Children = defineDoc<{ byRequest: Record<string, number> }>({ kind: `${name}.children`, version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ byRequest: {} }) });
  // A fork starts with no sessions: it never shares a live browser.
  const Sessions = defineDoc<SessionsState>({ kind: `${name}.sessions`, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: emptySessions });
  const readers: Readers<D> = { options, redact, Config };

  /** Class name and redacted message only: a vendor SDK's error text can repeat the request's credentials. */
  const scrubbed = (error: unknown) => Object.assign(new Error(redact(error instanceof Error ? error.message : String(error))), { name: error instanceof Error ? error.name : "Error" });
  const prices = resolvePrices(options.prices);
  const priceState: PriceState = prices.sessionUsdPerHour === null ? "unpriced" : "priced";
  const meter = (spent: SessionRecord["spent"], at: string, final = false) => {
    const charged = sessionCharge(spent, at, prices, priceState, final);
    return { spent: { ...charged.spent, state: charged.usage.state }, usage: charged.usage };
  };
  const leaving = new Map<string, () => void>();
  const store = custodyStore({
    name, Config, Sessions, meter, scrubbed, createDeadlineMs: options.createDeadlineMs ?? CREATE_DEADLINE_MS,
    providerOf: (read, cid, plane, context) => providerOf(readers, read, cid, plane, context),
    emit: (cid, label, record, change) => {
      // A released session's poll ends with it, whatever released it.
      if (change === "released") { leaving.get(record.tag)?.(); leaving.delete(record.tag); }
      return emit(readers, cid, label, record, change);
    },
  });

  const c: Custody<D> = {
    ...readers, name, Sessions, Children, store, meter, held: new Attachments<D>(), fences: new Map(), leaving, serial: keyedSerializer(), childTurns: oneAtATime(), guards: new Map(), opened: null, incarnation: randomUUID(),
    idle: idleTracker<ConversationId>({ idleMs: DEFAULT_BROWSER_POLICY.idleReleaseS * 1000, onIdle: (cid, fired, idleMs) => void releaseIdle(c, cid, fired, idleMs).catch(() => undefined) }),
  };
  // Every browser tool is a model call on its session's driving gate: refused while a person drives the live view, and the viewer's input is held while it runs. The host's own
  // implementations (`options.tools`) are merged in first, so they are guarded too: one that calls `port.session()` could otherwise act while a person drives.
  const own = drivingGuarded({ ...custodyTools, ...pageTools({ guards: c.guards }), ...options.tools } as Partial<Record<string, ToolImpl<D>>>, options.gates) as Partial<BrowserToolImpls<D>>;
  // pi checks a call's arguments against the tool's schema before execute, so each implementation receives its own shape.
  const tools = toolsFor(c, own as Partial<Record<string, ToolImpl<D>>>);
  const names = new Set(tools.map((tool) => tool.name));
  const siteTools = options.sites ? [siteTool(c, options.sites)] : [];

  return {
    extension: defineExtension({ name, tools: [...tools, ...siteTools], sections: [sectionFor(c, names)], tasks: [store.ReleaseTask] }),
    docs: { Config, Sessions, Inventory: store.Inventory, Children },
    tools: [...tools, ...siteTools],
    release: (conversation, reason, context) => releasePlane(c, conversation, reason, context),
    async reconcile(harness, isActive, context) {
      c.opened = { harness, context };
      return store.reconcileAll(harness, isActive, context);
    },
    drain: (harness, context, signal) => drainReleases(name, harness, context, signal),
    async close() {
      c.idle.clear();
      c.fences.clear();
      for (const stop of c.leaving.values()) stop();
      c.leaving.clear();
      // A session whose driver was let go and not yet replaced still has its observer attached: close both kinds.
      await Promise.all(c.held.tags().map((tag) => c.held.detach(tag)));
    },
    retained: () => new Set<number>([...c.guards.keys(), ...c.idle.keys(), ...c.serial.keys().map((key) => Number(key.slice(0, key.indexOf(":"))))]).size,
  };
}
