import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineTask, type ConversationDocToken, type ConversationId, type Cursor, type DocumentReader, type Harness, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { backoffMs, HANDOFF_POLL_MS, moveRecord, notices } from "../core/custody.js";
import type { BrowserConfig, BrowserProvider, HandoffOutcome, HandoffPort, InventoryRow, ReconcileReport, ReleaseReason, SessionChange, SessionRecord, SessionsState } from "../core/host.js";
import type { LeaseRef, LeaseState } from "../core/lease.js";

export const now = () => new Date().toISOString();
const iso = (ms: number) => new Date(ms).toISOString();
const cidOf = (row: InventoryRow) => row.conversationId as ConversationId;
/** Waits `ms`, or until `signal` aborts. */
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

/** Release attempts before custody is given up as `lost`, and status polls before a release is sent again. */
export const RELEASE_ATTEMPTS = 6;
export const CONFIRM_POLLS = 5;

/** `owed` adds to the row's owed ids, `told` takes those told off it (InventoryRow.owed). */
type Move = { state: LeaseState; resourceId?: string; reason?: ReleaseReason; at: string; notice?: "kept" | "lost"; handoff?: string; owed?: string[]; told?: string[] };
/** `found`: the ids an earlier attempt (or a task this one succeeds) released under the row's tag, kept until the release
 *  is billed: a provider's tag lookup lists running sessions only, so a later attempt no longer finds one it stopped. */
type ReleaseInput = { row: InventoryRow; notBefore?: number; found?: string[] };
type ReleaseState = { phase: "release"; attempt: number; found?: string[] } | { phase: "confirm"; attempt: number; ids: string[]; polls: number };
type ReleaseRuntime = TaskRuntime<ReleaseInput, ReleaseState, { released: number }, object>;
export type HandoffInput = { row: InventoryRow; requestId: string; interactionId: string; completionCondition: string };
type HandoffResult = { outcome: HandoffOutcome; reason?: string };
/** When the provider made each session a tag lookup found, by id (InventoryRow.made). */
type Made = Record<string, string>;
const madeOf = (refs: readonly LeaseRef[]): Made => Object.fromEntries(refs.flatMap((ref) => (ref.madeAt ? [[ref.id, ref.madeAt]] : [])));
/** `made` without the ids `told`; undefined when none is left. */
const madeLeft = (made: Made | undefined, told: readonly string[] = []): Made | undefined => {
  const left = Object.entries(made ?? {}).filter(([id]) => !told.includes(id));
  return left.length ? Object.fromEntries(left) : undefined;
};

export type StoreDeps = {
  name: string;
  Config: ConversationDocToken<BrowserConfig>;
  Sessions: ConversationDocToken<SessionsState>;
  providerOf(read: DocumentReader, cid: ConversationId, plane: string, context: Context): Promise<BrowserProvider>;
  emit(cid: ConversationId, label: string, record: SessionRecord, change: SessionChange): Promise<void>;
  meter(spent: SessionRecord["spent"], at: string, final?: boolean): { spent: SessionRecord["spent"] };
  /** The release's charge (or a lost session's), written on `record` in the commit `tx` and told to the host (durable.ts). */
  bill(tx: Tx, conversationId: ConversationId, record: SessionRecord, at: string, final: true): Promise<unknown>;
  scrubbed(error: unknown): Error;
  createDeadlineMs: number;
  handoff?: HandoffPort;
  /** A handoff's session came back under `fence`. */
  handedBack?(tag: string, fence: number): void;
  /** A release task (an attempt, or its abort handler) had the provider release `tag`'s session, and the provider answered. */
  stopped?(tag: string): void;
  /** A release by `row`'s tag ended sessions besides the row's own (`ids`, each confirmed no longer running): a create
   *  retried behind the provider, or a create race, left them. Their time is on no record (durable.ts, onRaceReleased).
   *  `made`: when the provider made each, where a tag lookup said (InventoryRow.made). */
  raced?(row: InventoryRow, ids: string[], made: Made): Promise<void>;
};

export function custodyStore({ name, Config, Sessions, providerOf, emit, meter, bill, scrubbed, createDeadlineMs, handoff, handedBack, stopped: stoppedHook, raced }: StoreDeps) {
  const Inventory = defineDoc<{ rows: Record<string, InventoryRow> }>({ kind: `${name}.inventory`, version: 1, scope: "session", initial: () => ({ rows: {} }), checkpointWhen: () => false });

  /** One state change: the record and the open-session inventory move in the same commit. */
  async function move(tx: Tx, row: InventoryRow, next: Move): Promise<void> {
    const inventory = await tx.doc(Inventory);
    const owed = union(inventory.rows[row.tag]?.owed, next.owed).filter((id) => !next.told?.includes(id));
    const made = madeLeft(inventory.rows[row.tag]?.made, next.told);
    const { owed: _stale, made: _staleMade, ...fields } = row;
    // A lost one stays: custody gave up releasing it, not looking for it (reconcile releases it again at run open). So
    // does a released one that still owes a raced call: the reconcile confirms those sessions' stop and tells them.
    if (next.state === "released" && !owed.length) delete inventory.rows[row.tag];
    else inventory.rows[row.tag] = { ...fields, state: next.state === "released" ? "lost" : next.state, resourceId: next.resourceId ?? row.resourceId, ...(owed.length ? { owed } : {}), ...(made ? { made } : {}) };
    const state = await tx.doc(Sessions, cidOf(row));
    const record = state.sessions.find((r) => r.tag === row.tag);
    if (!record) return;
    moveRecord(record, next);
    // A session custody gave up releasing (lost) is billed in full too, what it ran and its minimum, so a host lets go of
    // what it held for it; a later release finds it billed and adds nothing.
    if ((next.state === "released" || next.state === "lost") && record.resourceId !== null) await bill(tx, cidOf(row), record, next.at, true);
    if (next.notice) {
      for (const stale of [notices.kept(record.lastUrl), notices.lost(record.lastUrl)]) state.notice = state.notice?.replace(stale, "").replace(/\s+/g, " ").trim() || null;
      addNotice(state, notices[next.notice](record.lastUrl));
    }
  }
  /** A later notice never erases one not yet told, and the same one is never added twice (a second restart before any
   *  call). */
  const addNotice = (state: SessionsState, text: string) => { if (!state.notice?.includes(text)) state.notice = [state.notice, text].filter(Boolean).join(" "); };
  const begin = async (tx: Tx, row: InventoryRow) => { (await tx.doc(Inventory)).rows[row.tag] = { ...row, state: "creating", resourceId: null }; };

  /** Saves `ids` on the row as owed, and when the provider made each (`made`), before any stop is sent to them. */
  const owe = async (tx: Tx, row: InventoryRow, ids: readonly string[], made: Made = {}) => {
    const rows = (await tx.doc(Inventory)).rows;
    const at = rows[row.tag] ?? row;
    rows[row.tag] = { ...at, owed: union(at.owed, ids), ...madeOn(at, made) };
  };
  /** The row's `made` with `made` added, as fields to spread on it. */
  const madeOn = (at: InventoryRow, made: Made) => {
    const all = madeLeft({ ...at.made, ...made });
    return all ? { made: all } : {};
  };
  /** Saves when the provider made the sessions a release found (`made`) on the row, before any stop is sent to them. */
  const noteMade = async (tx: Tx, row: InventoryRow, made: Made) => {
    const rows = (await tx.doc(Inventory)).rows;
    const at = rows[row.tag];
    if (at && Object.keys(made).length) rows[row.tag] = { ...at, ...madeOn(at, made) };
  };
  /** When the provider made the row's sessions, as its row holds it now, with `seen` (this process's lookups) over it. */
  const madeFor = async (read: DocumentReader, row: InventoryRow, context: Context, seen: Made = {}): Promise<Made> =>
    ({ ...(await read.snapshot(Inventory, context))?.rows?.[row.tag]?.made, ...seen });
  /** The release confirms the row's owed sessions with its own and tells them (they go in as `found`). A row with no id
   *  yet leaves them to the reconcile: its release takes the first id it finds as its own. */
  async function requestRelease(tx: Tx, row: InventoryRow, reason: ReleaseReason, at: string, notBefore?: number): Promise<void> {
    const owed = row.resourceId === null ? [] : (await tx.doc(Inventory)).rows[row.tag]?.owed ?? [];
    await move(tx, row, { state: "releasing", reason, at });
    const { owed: _stale, made: _staleMade, ...fields } = row;
    await tx.createTask(ReleaseTask, { row: { ...fields, state: "releasing" as const }, ...(notBefore ? { notBefore } : {}), ...(owed.length ? { found: owed } : {}) }, { ownership: { kind: "conversation" }, conversationId: cidOf(row), background: true });
  }
  /** A create no tag lookup finds may still land (a crashed or fenced holder's call in flight): the release task looks
   *  again by tag after the create deadline and releases whatever landed. */
  const unknownCreate = (tx: Tx, row: InventoryRow, at: string) => requestRelease(tx, row, "create_failed", at, Date.now() + createDeadlineMs);

  /** `found` hears the ids before any is released: a release that stops a session and then fails (its status check after
   *  the stop) leaves the session known only to its caller, since the provider's tag lookup lists running sessions only. */
  async function releaseAll(row: InventoryRow, provider: BrowserProvider, signal?: AbortSignal, found: (ids: string[], made: Made) => void | Promise<void> = () => {}): Promise<string[]> {
    const refs = await provider.findByTag(row.tag, signal);
    const ids = [...new Set([row.resourceId, ...refs.map((ref) => ref.id)].filter((id): id is string => id !== null))];
    await found(ids, madeOf(refs));
    for (const id of ids) await provider.release({ id, tag: row.tag }, signal);
    return ids;
  }
  /** The sessions among `ids` besides `row`'s own. `ids` are what its release found, every attempt's, oldest first (the
   *  task's checkpoint keeps them): its own is its id, or for a create whose answer was lost the first its tag found
   *  (foundId), whose record bills it. */
  const othersOf = (row: InventoryRow, ids: readonly string[]) => {
    const own = row.resourceId ?? ids[0];
    return ids.filter((id) => id !== own);
  };
  /** The host hears the sessions besides `row`'s own among `ids` (raced) once their stop is confirmed, `ids` every id the
   *  release found: one whose release stopped it and then failed (its status read) is found by no later lookup, so it is
   *  told from the ids its release kept, once, by the step that confirms the release. */
  const tellRaced = async (row: InventoryRow, ids: readonly string[], made: () => Promise<Made>) => {
    const extras = othersOf(row, ids);
    if (extras.length) await raced?.(row, extras, await made());
  };
  const anyRunning = async (provider: BrowserProvider, row: InventoryRow, ids: string[], signal?: AbortSignal) => {
    for (const id of ids) if (["pending", "running"].includes(await provider.status({ id, tag: row.tag }, signal))) return true;
    return false;
  };
  /** The ids released under `row`'s tag once none of them runs; null while one does. */
  const releasedIds = async (provider: BrowserProvider, row: InventoryRow, signal?: AbortSignal, found?: (ids: string[], made: Made) => void | Promise<void>) => {
    const ids = await releaseAll(row, provider, signal, found);
    return (await anyRunning(provider, row, ids, signal)) ? null : ids;
  };
  /** A session found by its tag (its create's answer lost: the record has no id) is billed at its release too: the
   *  provider ran it. A create the provider refused found nothing, and is billed nothing. */
  const foundId = (row: InventoryRow, ids: readonly string[] | null) => (row.resourceId === null && ids?.length ? { resourceId: ids[0] } : {});
  /** Its error goes to the host's report, scrubbed, and `fallback` stands in; an abort is rethrown. */
  async function step<T>(runtime: ReleaseRuntime, run: () => Promise<T>, fallback: T): Promise<T> {
    try { return await run(); } catch (error) {
      if (runtime.signal.aborted) throw error;
      runtime.report(scrubbed(error));
      return fallback;
    }
  }
  /** Releases `extras` and returns those a status read confirms stopped, read again (backoffMs) up to CONFIRM_POLLS times
   *  while a read fails or a stop that was sent is still under way; one still running after a release that failed is
   *  not read again. One not returned stays owed on the row. */
  async function stopExtras(provider: BrowserProvider, row: InventoryRow, extras: readonly LeaseRef[], signal?: AbortSignal): Promise<string[]> {
    const open = new Map<string, boolean>();
    for (const extra of extras) open.set(extra.id, await provider.release(extra, signal).then(() => true, () => false));
    const stopped = new Set<string>();
    for (let poll = 0; open.size && poll < CONFIRM_POLLS && !signal?.aborted; poll += 1) {
      if (poll) await pause(backoffMs(poll - 1), signal);
      for (const [id, sent] of [...open]) {
        const state = await provider.status({ id, tag: row.tag }, signal).catch(() => null);
        if (state === null) continue;
        if (!["pending", "running"].includes(state)) (stopped.add(id), open.delete(id));
        else if (!sent) open.delete(id);
      }
    }
    return extras.map((extra) => extra.id).filter((id) => stopped.has(id));
  }
  /** A create whose answer never came, settled by its tag: the first session found is kept and committed `live`; extras
   *  (a create retried behind the provider's API) are saved on the row as owed, then released, and told as raced once
   *  their stop is confirmed. One no read confirms here stays owed, for the session's own release or the reconcile. */
  async function bindByTag(provider: BrowserProvider, row: InventoryRow, commit: (change: (tx: Tx) => Promise<void>) => Promise<unknown>, signal?: AbortSignal, found?: LeaseRef[]): Promise<LeaseRef | null> {
    const refs = found ?? await provider.findByTag(row.tag, signal);
    const extras = refs.slice(1);
    if (extras.length) await commit((tx) => owe(tx, row, extras.map((ref) => ref.id), madeOf(extras)));
    const stopped = await stopExtras(provider, row, extras, signal);
    if (stopped.length) await raced?.(row, stopped, madeOf(extras));
    const kept = refs[0] ?? null;
    await commit((tx) => kept ? move(tx, row, { state: "live", resourceId: kept.id, at: now(), told: stopped }) : unknownCreate(tx, row, now()));
    return kept;
  }
  /** `found`: the id a release task's lookup found for a record that has none yet, which the commit after this one
   *  records; the host hears the session with it, and with the bill that commit makes. */
  async function emitReleased(cid: ConversationId, tag: string, read: DocumentReader, context: Context, at = now(), found: { resourceId?: string } = {}): Promise<void> {
    const [state, config] = await Promise.all([read.snapshot(Sessions, cid, context), read.snapshot(Config, cid, context)]);
    const stored = state?.sessions.find((r) => r.tag === tag);
    const record = stored && stored.resourceId === null && found.resourceId ? { ...stored, resourceId: found.resourceId } : stored;
    const spent = record && record.resourceId !== null ? meter(record.spent, at, true).spent : record?.spent;
    if (record && spent) await emit(cid, config?.label ?? "", { ...record, state: "released", endedAt: record.endedAt ?? at, spent }, "released");
  }
  const union = (...lists: (readonly string[] | null | undefined)[]) => [...new Set(lists.flatMap((ids) => ids ?? []))];
  /** The row stays in the inventory until a run open's reconcile sees nothing under its tag running. `found` goes on to
   *  the next attempt, and bills a lost one; of a lost one's other sessions, each the provider says no longer runs is
   *  told (raced), and the rest stay owed on the row for the reconcile. */
  async function retry(runtime: ReleaseRuntime, row: InventoryRow, attempt: number, context: Context, found: string[]): Promise<void> {
    if (attempt + 1 >= RELEASE_ATTEMPTS) {
      const ended = await step(runtime, async () => {
        const provider = await providerOf(runtime, cidOf(row), row.plane, context);
        const out: string[] = [];
        for (const id of othersOf(row, found)) if (!(await anyRunning(provider, row, [id], runtime.signal))) out.push(id);
        return out;
      }, []);
      if (ended.length) await raced?.(row, ended, await madeFor(runtime, row, context));
      await runtime.commit(async (tx) => {
        await move(tx, row, { state: "lost", reason: "lost", at: iso(runtime.now()), ...foundId(row, found), owed: othersOf(row, found), told: ended });
        return { status: "terminal", outcome: { status: "failed", error: { code: "release_failed", message: `${row.tag}: not released after ${RELEASE_ATTEMPTS} attempts` } } };
      }, context);
      return;
    }
    // pi 1.5: the wait is a durable sleep. Its deadline is computed once on the Harness clock and stored with the sleep
    // (the task's `until`), so a process that dies while it sleeps resumes at that same deadline, never a new one.
    await runtime.sleepUntil(runtime.now() + backoffMs(attempt), { phase: "release", attempt: attempt + 1, ...(found.length ? { found } : {}) }, context);
  }

  const ReleaseTask = defineTask<ReleaseInput, ReleaseState, { released: number }, object>({
    name: `${name}.release`,
    version: 1,
    initial: () => ({ phase: "release", attempt: 0 }),
    phases: {
      release: async (task, runtime, context) => {
        const { row, notBefore } = task.input;
        const { attempt } = task.state.checkpoint;
        const found = union(task.input.found, task.state.checkpoint.found);
        // The create deadline from the task's input (durable): sleep to it, then this phase runs again at the same
        // checkpoint, past the deadline.
        if (attempt === 0 && notBefore && runtime.now() < notBefore) return runtime.sleepUntil(notBefore, task.state.checkpoint, context);
        let seen: string[] = [];
        // Ids the lookup found that the task does not hold yet are committed before any stop is sent: an attempt cut
        // between its stop and its next commit (the task's abort) leaves them for the abort handler, whose own lookup
        // no longer lists a stopped session.
        const keep = async (ids: string[], made: Made) => {
          seen = ids;
          const known = union(found, ids);
          if (known.length > found.length) {
            await runtime.commit(async (tx) => {
              await noteMade(tx, row, made);
              return { status: "running", checkpoint: { phase: "release", attempt, found: known } };
            }, context);
          }
        };
        const released = await step(runtime, async () => releaseAll(row, await providerOf(runtime, cidOf(row), row.plane, context), runtime.signal, keep), null);
        // What the lookup found goes on to the next attempt even when its release failed: the stop may have landed.
        if (!released) return retry(runtime, row, attempt, context, union(found, seen));
        stoppedHook?.(row.tag);
        // Confirmed together: what this attempt released and what earlier ones did.
        const ids = union(found, released);
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "confirm", attempt, ids, polls: 0 } }), context);
      },
      confirm: async (task, runtime, context) => {
        const { row } = task.input;
        const { attempt, ids, polls } = task.state.checkpoint;
        const running = await step(runtime, async () => anyRunning(await providerOf(runtime, cidOf(row), row.plane, context), row, ids, runtime.signal), true);
        if (running && polls + 1 < CONFIRM_POLLS) {
          await runtime.sleepUntil(runtime.now() + backoffMs(polls), { phase: "confirm", attempt, ids, polls: polls + 1 }, context);
          return;
        }
        if (running) return retry(runtime, row, attempt, context, ids);
        // The host hears the release, and the other sessions it ended (tellRaced), before the task's last commit, so at
        // least once, with the bill that commit records.
        const at = iso(runtime.now());
        await emitReleased(cidOf(row), row.tag, runtime, context, at, foundId(row, ids));
        await tellRaced(row, ids, () => madeFor(runtime, row, context));
        await runtime.commit(async (tx) => {
          await move(tx, row, { state: "released", at, ...foundId(row, ids), told: othersOf(row, ids) });
          return { status: "terminal", outcome: { status: "completed", result: { released: ids.length } } };
        }, context);
      },
    },
    // After the abort mark: release and check once. It cannot wait or retry, so a release it cannot confirm is handed
    // to a successor task in the same commit.
    abort: async (task, runtime, context) => {
      const { row, notBefore } = task.input;
      const checkpoint = task.state.checkpoint;
      let found = union(task.input.found, checkpoint.phase === "confirm" ? checkpoint.ids : checkpoint.found);
      let stopped: string[] | null = null;
      let confirmed: string[] = [];
      let seen: Made = {};
      // Before the create deadline nothing found is proof of nothing: the successor keeps the delayed lookup. The ids
      // earlier attempts found that no lookup lists now are read once each; one not confirmed stays owed on the row.
      if (!(notBefore && runtime.now() < notBefore)) stopped = await providerOf(runtime, cidOf(row), row.plane, context).then(async (provider) => {
        const ids = await releasedIds(provider, row, context.abortSignal, (ids, made) => void ((found = union(found, ids)), (seen = { ...seen, ...made })));
        if (ids) for (const id of found) if (ids.includes(id) || !(await anyRunning(provider, row, [id], context.abortSignal).catch(() => true))) confirmed.push(id);
        return ids;
      }).catch(() => null);
      const others = stopped ? othersOf(row, union(found, stopped)) : [];
      const told = others.filter((id) => stopped?.includes(id) || confirmed.includes(id));
      if (stopped) stoppedHook?.(row.tag);
      if (told.length) await raced?.(row, told, await madeFor(runtime, row, context, seen));
      await runtime.commit(async (tx) => {
        if (stopped) await noteMade(tx, row, seen);
        if (stopped) await move(tx, row, { state: "released", at: iso(runtime.now()), ...foundId(row, union(found, stopped)), owed: others, told });
        else await tx.createTask(ReleaseTask, { ...task.input, ...(found.length ? { found } : {}) }, { ownership: { kind: "conversation" }, conversationId: cidOf(row), background: true });
        return { status: "terminal", outcome: { status: "aborted", reason: stopped ? "released by the abort handler" : "release handed to a successor task" } };
      }, context);
    },
  });

  /** Polls the port until it answers, every HANDOFF_POLL_MS while the answer is pending, then gives the session back with
   *  the outcome's notice, if it is still held for this request. `attempt` counts the reads in a row that failed, which
   *  back off (backoffMs); a read that answers "pending" starts it again. */
  const HandoffTask = defineTask<HandoffInput, { phase: "poll"; attempt: number }, HandoffResult, object>({
    name: `${name}.handoff`,
    version: 1,
    initial: () => ({ phase: "poll", attempt: 0 }),
    phases: {
      poll: async (task, runtime, context) => {
        const { row, requestId, interactionId, completionCondition } = task.input;
        const { attempt } = task.state.checkpoint;
        // A session no longer held for this request (the provider stopped it and a reconcile released it, or it was
        // given back) leaves nothing to wait for: the wait ends at once, and the call says the handoff ended.
        let over = false;
        await runtime.commit(async (tx) => {
          const record = (await tx.doc(Sessions, cidOf(row))).sessions.find((r) => r.tag === row.tag);
          if (record?.state === "held" && record.handoff === requestId) return undefined;
          over = true;
          return { status: "terminal", outcome: { status: "failed", error: { code: "handoff_ended", message: `${row.tag}: no longer held for ${requestId}` } } };
        }, context);
        if (over) return;
        let answer: "pending" | HandoffOutcome | { outcome: HandoffOutcome; reason: string } = "pending";
        let failed = false;
        try { if (handoff) answer = await handoff.outcome(interactionId, runtime.signal); } catch (error) {
          if (runtime.signal.aborted) throw error;
          runtime.report(scrubbed(error));
          failed = true;
        }
        // A person's answer can come at any moment: while it is pending, it is asked again at a short fixed interval, so
        // a hand-back resumes the agent within one poll. A read that failed backs off instead.
        if (failed) {
          await runtime.sleepUntil(runtime.now() + backoffMs(attempt), { phase: "poll", attempt: attempt + 1 }, context);
          return;
        }
        if (answer === "pending") {
          await runtime.sleepUntil(runtime.now() + HANDOFF_POLL_MS, { phase: "poll", attempt: 0 }, context);
          return;
        }
        const outcome = typeof answer === "string" ? answer : answer.outcome;
        const reason = typeof answer === "string" ? undefined : answer.reason;
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Sessions, cidOf(row));
          const record = state.sessions.find((r) => r.tag === row.tag);
          if (record?.state === "held" && record.handoff === requestId) {
            await move(tx, row, { state: "live", at: iso(runtime.now()) });
            addNotice(state, notices.handedBack(outcome, completionCondition));
            handedBack?.(row.tag, record.fence ?? 0);
          }
          return { status: "terminal", outcome: { status: "completed", result: { outcome, ...(reason ? { reason } : {}) } } };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        await waitForHandoff(tx, task.input);
        return { status: "terminal", outcome: { status: "aborted", reason: "the wait was handed to a successor task" } };
      }, context);
    },
  });
  const waitForHandoff = (tx: Tx, input: HandoffInput) => tx.createTask(HandoffTask, input, { ownership: { kind: "conversation" }, conversationId: cidOf(input.row), background: true });
  /** A request's newest wait: a successor is newer than the task it replaced. */
  async function findHandoff(tx: Tx, cid: ConversationId, requestId: string): Promise<TaskId<HandoffResult> | undefined> {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ conversationId: cid, kind: `${name}.handoff`, order: "descending" }, 50, cursor);
      const found = page.items.find((task) => (task.input as HandoffInput).requestId === requestId);
      if (found) return found.id as TaskId<HandoffResult>;
      cursor = page.next;
    } while (cursor);
    return undefined;
  }

  /** A lost row at run open: the sessions besides its own that its tag lists are saved as owed, then its own and those
   *  are released, and its own and every owed one read once each. The others a read confirms stopped are told (raced) though another's release failed; the rest stay owed.
   *  The row goes, its record billed, once every release answered and every session is confirmed stopped; a release
   *  that failed leaves it for the next reconcile (unreachable). A session known only by its tag (no id on the row) is
   *  the first its tag lists, kept on the row and record before any stop is sent, as its tag lookup lists running
   *  sessions only. */
  async function reconcileLost(provider: BrowserProvider, row: InventoryRow, commit: (change: (tx: Tx) => Promise<void>) => Promise<unknown>, outcome: (kind: keyof ReconcileReport, change?: (tx: Tx) => Promise<void>) => Promise<void>, at: string): Promise<void> {
    const refs = await provider.findByTag(row.tag);
    const listed = refs.map((ref) => ref.id);
    const made = { ...row.made, ...madeOf(refs) };
    const own = row.resourceId ?? listed[0] ?? null;
    const others = union(listed, row.owed).filter((id) => id !== own);
    if (others.some((id) => !row.owed?.includes(id)) || own !== row.resourceId) {
      await commit(async (tx) => {
        await owe(tx, row, others, made);
        const rows = (await tx.doc(Inventory)).rows;
        if (own !== null && rows[row.tag]?.resourceId === null) rows[row.tag]!.resourceId = own;
        const record = (await tx.doc(Sessions, cidOf(row))).sessions.find((r) => r.tag === row.tag);
        if (own !== null && record && record.resourceId === null) record.resourceId = own;
      });
    }
    let answered = true;
    for (const id of union(own === null ? [] : [own], listed)) if (!(await provider.release({ id, tag: row.tag }).then(() => true, () => false))) answered = false;
    const stopped: string[] = [];
    for (const id of union(own === null ? [] : [own], others)) if (!(await anyRunning(provider, row, [id]).catch(() => true))) stopped.push(id);
    const told = others.filter((id) => stopped.includes(id));
    if (told.length) await raced?.(row, told, made);
    const done = answered && (own === null || stopped.includes(own)) && told.length === others.length;
    if (done) {
      await outcome("released", async (tx) => {
        delete (await tx.doc(Inventory)).rows[row.tag];
        const record = (await tx.doc(Sessions, cidOf(row))).sessions.find((r) => r.tag === row.tag);
        if (record && record.resourceId !== null) await bill(tx, cidOf(row), record, at, true);
      });
      return;
    }
    if (told.length) {
      await commit(async (tx) => {
        const rows = (await tx.doc(Inventory)).rows;
        const at = rows[row.tag];
        if (!at) return;
        const { made: _told, ...fields } = at;
        const left = madeLeft(at.made, told);
        rows[row.tag] = { ...fields, owed: (at.owed ?? []).filter((id) => !told.includes(id)), ...(left ? { made: left } : {}) };
      });
    }
    if (!answered) throw new Error(`${row.tag}: a release failed`);
    await outcome("lost");
  }

  async function reconcileAll(harness: Harness, isActive: (conversationId: ConversationId) => boolean, context: Context): Promise<ReconcileReport> {
    const report: ReconcileReport = { released: [], kept: [], lost: [], unreachable: [] };
    for (const row of Object.values((await harness.snapshot(Inventory, context))?.rows ?? {})) {
      if (row.state === "releasing") continue;
      const at = now();
      const commit = (change: (tx: Tx) => Promise<void>) => harness.commit(change, context);
      const outcome = async (kind: keyof ReconcileReport, change?: (tx: Tx) => Promise<void>) => { if (change) await commit(change); report[kind].push(row.tag); };
      try {
        const provider = await providerOf(harness, cidOf(row), row.plane, context);
        if (row.state === "lost") {
          await reconcileLost(provider, row, commit, outcome, at);
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
        else if (row.state === "held") await outcome("kept");
        else if (isActive(cidOf(row))) await outcome("kept", (tx) => move(tx, live, { state: "live", at, notice: "kept" }));
        else await outcome("released", (tx) => requestRelease(tx, live, "lost", at));
      } catch {
        report.unreachable.push(row.tag);
      }
    }
    return report;
  }

  return { Inventory, move, addNotice, begin, requestRelease, bindByTag, emitReleased, ReleaseTask, HandoffTask, waitForHandoff, findHandoff, reconcileAll };
}
