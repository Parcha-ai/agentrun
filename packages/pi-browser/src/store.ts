// Custody in the run's own store: the open-session inventory, a session's state moves (its record and the inventory in
// one commit), the release task, and the run-open reconcile that settles what a dead process left. The extension in
// durable.ts wires it to its documents, its provider and its host channel; nothing here holds a browser.
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineTask, type ConversationDocToken, type ConversationId, type DocumentReader, type Harness, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { moveRecord, notices } from "./core/custody.js";
import type { BrowserConfig, BrowserProvider, InventoryRow, ReconcileReport, ReleaseReason, SessionChange, SessionRecord, SessionsState } from "./core/host.js";
import type { LeaseRef, LeaseState } from "./core/lease.js";

export const now = () => new Date().toISOString();
const iso = (ms: number) => new Date(ms).toISOString();
const cidOf = (row: InventoryRow) => row.conversationId as ConversationId;

/** Release attempts before custody is given up as `lost`, and status polls before a release is sent again. */
export const RELEASE_ATTEMPTS = 6;
export const CONFIRM_POLLS = 5;
const backoffMs = (n: number) => Math.min(30_000, 500 * 2 ** n);

type Move = { state: LeaseState; resourceId?: string; reason?: ReleaseReason; at: string; notice?: "kept" | "lost" };
type ReleaseInput = { row: InventoryRow; notBefore?: number };
type ReleaseState = { phase: "release"; attempt: number } | { phase: "confirm"; attempt: number; ids: string[]; polls: number };
type ReleaseRuntime = TaskRuntime<ReleaseInput, ReleaseState, { released: number }, object>;

/** What the store needs from the extension: its name (which names the inventory and the release task), its documents,
 *  the provider of a conversation's plane, the host channel, the error scrubber, and how long a create may still land. */
export type StoreDeps = {
  name: string;
  Config: ConversationDocToken<BrowserConfig>;
  Sessions: ConversationDocToken<SessionsState>;
  providerOf(read: DocumentReader, cid: ConversationId, plane: string, context: Context): Promise<BrowserProvider>;
  emit(cid: ConversationId, label: string, record: SessionRecord, change: SessionChange): Promise<void>;
  /** The session meter at the host's price: the charge for a session's time up to `at` (`final` at its release). */
  meter(spent: SessionRecord["spent"], at: string, final?: boolean): { spent: SessionRecord["spent"] };
  scrubbed(error: unknown): Error;
  createDeadlineMs: number;
};

export function custodyStore({ name, Config, Sessions, providerOf, emit, meter, scrubbed, createDeadlineMs }: StoreDeps) {
  // ---- custody state in the store: the open-session inventory, state moves, the release task ----------------------
  const Inventory = defineDoc<{ rows: Record<string, InventoryRow> }>({ kind: `${name}.inventory`, version: 1, scope: "session", initial: () => ({ rows: {} }) });

  /** One state change of a session: its record and the open-session inventory move in the same commit. */
  async function move(tx: Tx, row: InventoryRow, next: Move): Promise<void> {
    const inventory = await tx.doc(Inventory);
    // A lost one stays: custody gave up releasing it, not looking for it (reconcile releases it again at run open).
    if (next.state === "released") delete inventory.rows[row.tag];
    else inventory.rows[row.tag] = { ...row, state: next.state, resourceId: next.resourceId ?? row.resourceId };
    const state = await tx.doc(Sessions, cidOf(row));
    const record = state.sessions.find((r) => r.tag === row.tag);
    if (!record) return;
    moveRecord(record, next);
    // A session that ran is billed to its release: the remainder, topped up to the provider's minimum, on its record.
    if (next.state === "released" && record.resourceId !== null) record.spent = meter(record.spent, next.at, true).spent;
    if (next.notice) {
      // A session's later status replaces its earlier one (kept by one restart, gone by the next); a release notice stays.
      for (const stale of [notices.kept(record.lastUrl), notices.lost(record.lastUrl)]) state.notice = state.notice?.replace(stale, "").replace(/\s+/g, " ").trim() || null;
      addNotice(state, notices[next.notice](record.lastUrl));
    }
  }
  /** Custody's notices wait for the next call side by side: a later one never erases one not yet told, and the same one
   *  is never added twice (a second restart before any call). */
  const addNotice = (state: SessionsState, text: string) => { if (!state.notice?.includes(text)) state.notice = [state.notice, text].filter(Boolean).join(" "); };
  const begin = async (tx: Tx, row: InventoryRow) => { (await tx.doc(Inventory)).rows[row.tag] = { ...row, state: "creating", resourceId: null }; };

  /** `releasing` and its release task, in one commit; `notBefore` delays the task's first look. */
  async function requestRelease(tx: Tx, row: InventoryRow, reason: ReleaseReason, at: string, notBefore?: number): Promise<void> {
    await move(tx, row, { state: "releasing", reason, at });
    await tx.createTask(ReleaseTask, { row: { ...row, state: "releasing" as const }, ...(notBefore ? { notBefore } : {}) }, { ownership: { kind: "conversation" }, conversationId: cidOf(row), background: true });
  }
  /** A create with no session found by its tag may still land (a crashed or fenced holder's call in flight): the
   *  release task looks again by the tag after the create deadline and releases whatever landed. */
  const unknownCreate = (tx: Tx, row: InventoryRow, at: string) => requestRelease(tx, row, "create_failed", at, Date.now() + createDeadlineMs);

  /** Release every session the row names or its tag finds; one already gone counts as released. */
  async function releaseAll(row: InventoryRow, provider: BrowserProvider, signal?: AbortSignal): Promise<string[]> {
    const ids = [...new Set([row.resourceId, ...(await provider.findByTag(row.tag, signal)).map((ref) => ref.id)].filter((id): id is string => id !== null))];
    for (const id of ids) await provider.release({ id, tag: row.tag }, signal);
    return ids;
  }
  const anyRunning = async (provider: BrowserProvider, row: InventoryRow, ids: string[], signal?: AbortSignal) => {
    for (const id of ids) if (["pending", "running"].includes(await provider.status({ id, tag: row.tag }, signal))) return true;
    return false;
  };
  /** Release everything the row names or its tag finds, then look once: true when none of it still runs. */
  const releasedAll = async (provider: BrowserProvider, row: InventoryRow, signal?: AbortSignal) => !(await anyRunning(provider, row, await releaseAll(row, provider, signal), signal));
  /** A provider step of the release task: its error goes to the host's report, scrubbed, and `fallback` stands in; an
   *  abort is rethrown. */
  async function step<T>(runtime: ReleaseRuntime, run: () => Promise<T>, fallback: T): Promise<T> {
    try { return await run(); } catch (error) {
      if (runtime.signal.aborted) throw error;
      runtime.report(scrubbed(error));
      return fallback;
    }
  }
  /** A create whose answer never came, settled by its tag: the first session the tag finds is kept and committed `live`
   *  (extras, a create retried behind the provider's API, are released); with none, it is an unknown create the
   *  release task looks for again. `found` is the lookup when the caller made it. Returns the kept session, or null. */
  async function bindByTag(provider: BrowserProvider, row: InventoryRow, commit: (change: (tx: Tx) => Promise<void>) => Promise<unknown>, signal?: AbortSignal, found?: LeaseRef[]): Promise<LeaseRef | null> {
    const refs = found ?? await provider.findByTag(row.tag, signal);
    for (const extra of refs.slice(1)) await provider.release(extra, signal).catch(() => undefined);
    const kept = refs[0] ?? null;
    await commit((tx) => kept ? move(tx, row, { state: "live", resourceId: kept.id, at: now() }) : unknownCreate(tx, row, now()));
    return kept;
  }
  /** The host hears a session released, under its conversation's label (before the release task's own last commit). */
  async function emitReleased(cid: ConversationId, tag: string, read: DocumentReader, context: Context, at = now()): Promise<void> {
    const [state, config] = await Promise.all([read.snapshot(Sessions, cid, context), read.snapshot(Config, cid, context)]);
    const record = state?.sessions.find((r) => r.tag === tag);
    // With the final bill the release commits at the same instant (a bill already final stays as it is).
    const spent = record && record.resourceId !== null ? meter(record.spent, at, true).spent : record?.spent;
    if (record && spent) await emit(cid, config?.label ?? "", { ...record, state: "released", endedAt: record.endedAt ?? at, spent }, "released");
  }
  /** Another release attempt after a backoff, or custody given up as `lost` once the attempts are spent; the row stays
   *  in the inventory until a run open's reconcile sees nothing under its tag running. */
  async function retry(runtime: ReleaseRuntime, row: InventoryRow, attempt: number, context: Context): Promise<void> {
    if (attempt + 1 >= RELEASE_ATTEMPTS) {
      await runtime.commit(async (tx) => {
        await move(tx, row, { state: "lost", reason: "lost", at: iso(runtime.now()) });
        return { status: "terminal", outcome: { status: "failed", error: { code: "release_failed", message: `${row.tag}: not released after ${RELEASE_ATTEMPTS} attempts` } } };
      }, context);
      return;
    }
    await runtime.sleep(runtime.now() + backoffMs(attempt), context);
    await runtime.commit(() => ({ status: "running", checkpoint: { phase: "release", attempt: attempt + 1 } }), context);
  }

  const ReleaseTask = defineTask<ReleaseInput, ReleaseState, { released: number }, object>({
    name: `${name}.release`,
    version: 1,
    initial: () => ({ phase: "release", attempt: 0 }),
    phases: {
      release: async (task, runtime, context) => {
        const { row, notBefore } = task.input;
        const { attempt } = task.state.checkpoint;
        if (attempt === 0 && notBefore && runtime.now() < notBefore) await runtime.sleep(notBefore, context);
        const ids = await step(runtime, async () => releaseAll(row, await providerOf(runtime, cidOf(row), row.plane, context), runtime.signal), null);
        if (!ids) return retry(runtime, row, attempt, context);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "confirm", attempt, ids, polls: 0 } }), context);
      },
      confirm: async (task, runtime, context) => {
        const { row } = task.input;
        const { attempt, ids, polls } = task.state.checkpoint;
        const running = await step(runtime, async () => anyRunning(await providerOf(runtime, cidOf(row), row.plane, context), row, ids, runtime.signal), true);
        if (running && polls + 1 < CONFIRM_POLLS) {
          await runtime.sleep(runtime.now() + backoffMs(polls), context);
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "confirm", attempt, ids, polls: polls + 1 } }), context);
          return;
        }
        // Still running after the polls: send the release again, within the attempt limit.
        if (running) return retry(runtime, row, attempt, context);
        // The host hears the release before the task's last commit (at least once), with the bill that commit records.
        const at = iso(runtime.now());
        await emitReleased(cidOf(row), row.tag, runtime, context, at);
        await runtime.commit(async (tx) => {
          await move(tx, row, { state: "released", at });
          return { status: "terminal", outcome: { status: "completed", result: { released: ids.length } } };
        }, context);
      },
    },
    // A fresh invocation after the abort mark: it releases and checks once, and ends. It cannot wait or retry, so a
    // release it cannot confirm is handed to a successor task in the same commit.
    abort: async (task, runtime, context) => {
      const { row, notBefore } = task.input;
      let stopped = false;
      // Before the create deadline nothing found is proof of nothing: the successor keeps the delayed lookup.
      // Any failure here, the provider's lookup included, leaves the release to the successor.
      if (!(notBefore && runtime.now() < notBefore)) stopped = await providerOf(runtime, cidOf(row), row.plane, context).then((provider) => releasedAll(provider, row, context.abortSignal)).catch(() => false);
      await runtime.commit(async (tx) => {
        if (stopped) await move(tx, row, { state: "released", at: iso(runtime.now()) });
        else await tx.createTask(ReleaseTask, task.input, { ownership: { kind: "conversation" }, conversationId: cidOf(row), background: true });
        return { status: "terminal", outcome: { status: "aborted", reason: stopped ? "released by the abort handler" : "release handed to a successor task" } };
      }, context);
    },
  });

  /** At run open, before resume: every open session is checked with its provider. A creating one is bound by its tag
   *  or handed to a delayed release; a live one is kept for a conversation that continues, released for one that is
   *  done, closed when the provider ended it; a releasing one is left to its task; a lost one is released again and
   *  dropped once nothing under its tag runs. */
  async function reconcileAll(harness: Harness, isActive: (conversationId: ConversationId) => boolean, context: Context): Promise<ReconcileReport> {
    const report: ReconcileReport = { released: [], kept: [], lost: [], unreachable: [] };
    for (const row of Object.values((await harness.snapshot(Inventory, context))?.rows ?? {})) {
      if (row.state === "releasing") continue;
      const at = now();
      const commit = (change: (tx: Tx) => Promise<void>) => harness.commit(change, context);
      // Each row ends in one outcome: committed, when there is anything to commit, and filed in the report.
      const outcome = async (kind: keyof ReconcileReport, change?: (tx: Tx) => Promise<void>) => { if (change) await commit(change); report[kind].push(row.tag); };
      try {
        const provider = await providerOf(harness, cidOf(row), row.plane, context);
        if (row.state === "lost") {
          // Confirmed released at last: the row goes and the bill closes; the record stays lost, as custody gave it up.
          await ((await releasedAll(provider, row)) ? outcome("released", async (tx) => {
            delete (await tx.doc(Inventory)).rows[row.tag];
            const record = (await tx.doc(Sessions, cidOf(row))).sessions.find((r) => r.tag === row.tag);
            if (record && record.resourceId !== null) record.spent = meter(record.spent, at, true).spent;
          }) : outcome("lost"));
          continue;
        }
        let live = row;
        if (row.state === "creating") {
          const kept = await bindByTag(provider, row, commit);
          if (!kept) { await outcome("lost"); continue; }
          live = { ...row, state: "live", resourceId: kept.id };
        }
        const status = await provider.status({ id: live.resourceId!, tag: live.tag });
        if (status === "gone" || status === "stopped") await outcome("lost", (tx) => move(tx, live, { state: "released", reason: "ended", at, notice: "lost" }));
        else if (isActive(cidOf(row))) await outcome("kept", (tx) => move(tx, live, { state: "live", at, notice: "kept" }));
        else await outcome("released", (tx) => requestRelease(tx, live, "lost", at));
      } catch {
        report.unreachable.push(row.tag);
      }
    }
    return report;
  }

  return { Inventory, move, addNotice, begin, requestRelease, bindByTag, emitReleased, ReleaseTask, reconcileAll };
}
