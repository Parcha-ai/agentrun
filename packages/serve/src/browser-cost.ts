// Browser minutes in the run's spend: each charge of a browser session's time (pi-browser's onCharge) is booked as a
// TOOL_COST in the commit that writes it on the session's record, so the run's cost, /usage and the cap read it as they read
// monid's, and a crash never leaves one booked and not billed or billed and not booked. What the run's process counts
// (its spend, the holds below) moves once that commit is in, from the commit itself. Under a cap, no session time runs
// that the cap has not held first (cap.ts' paid holds):
// - The next stretch is the most a session can run before the run can check again: the provider's minimum (what a
//   release may top it up to), the idle window before pi-browser releases it, and RELEASE_ALLOWANCE_S for that release
//   to be confirmed at the provider.
// - Before each browser call, through paidCall, the call is held at what its conversation's sessions ran since their last
//   charge, plus two stretches: one for the call's own time, one for the reserve of a session it opens. Refused, the call
//   is not sent: the model gets the cap's words, and the conversation's session is released.
// - A session's first charge moves one stretch from its call's hold to the session's own reserve, held until its release
//   is booked: its idle time, its top-up and its release. Each call's charge is taken from the call's hold, which goes
//   when the call returns. The release's charge is taken from the session's reserve, which goes with it.
// So what the run spent plus what it holds stays within the cap through a create, calls, the idle time between them and
// the release. A session still tracked across a restart of the run's process is held from the reopen (reopened), at a
// stretch beside what it ran since its last charge; one reconcile kept is released an idle window after it unless a call
// uses it. A single call that runs
// longer than a stretch, a release that takes longer than its allowance to be confirmed, and the time a run's process
// was down while it held a session (spent before any process could hold it) can pass the cap, by that much, booked and
// shown.
import type { Context } from "@earendil-works/chord";
import type { Refusal } from "@parcha/agentrun-kernel";
import { ROOT_CONVERSATION_ID, type Conversation, type Session, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { SessionCharge } from "@parcha/pi-browser";
import type { BeforeCreate } from "@parcha/pi-browser/durable";
import { TOOL_COST } from "@parcha/pi-durable-agent/timeline";
import { BARRIER, syncNow } from "@parcha/pi-durable-disk";
import { addSpend, keepHold, paidCall, runCap, SPEND_CAP_REACHED } from "./cap.js";
import { type PaidBooking, paidStep, runJournal } from "./paid-calls.js";
import { logLine } from "./print.js";
import { forModel } from "./result.js";

/** The run journal's record of a browser session about to be created at its provider: its tag (pi-browser's, which a
 *  reconcile finds the vendor's session by), its conversation and the hold its call keeps for it (`held_usd`, null with
 *  no cap). Written with pi-browser's own `creating` record and synced (barriers.ts browserSessionOpen) before the vendor
 *  is asked, so a box loss never leaves a session billed that no record in the store names. */
export const BROWSER_SESSION_OPEN = "agentrun.browser_session_open";

/** List prices by pi-browser provider name (`provider.name`): Browserbase's (pi-browser's LIST_PRICES), $0.12 an hour with
 *  a one-minute minimum; Kernel's headless browser, about $0.06 an hour billed by the second; a local Chrome (`cdp`, and
 *  the `local` computer provider's), free. */
export const BROWSER_PRICES: Readonly<Record<string, { usdPerHour: number; minimumS: number }>> = Object.freeze({
  browserbase: { usdPerHour: 0.12, minimumS: 60 },
  kernel: { usdPerHour: 0.06, minimumS: 0 },
  cdp: { usdPerHour: 0, minimumS: 0 },
  local: { usdPerHour: 0, minimumS: 0 },
});
/** An operator's price for a provider, in USD an hour: this prefix and the provider's name in capitals
 *  (AGENTRUN_BROWSER_USD_PER_HOUR_BROWSERBASE, _KERNEL, _CDP). */
export const BROWSER_PRICE_ENV = "AGENTRUN_BROWSER_USD_PER_HOUR_";
/** What a release may take to be confirmed at the provider once it is asked (pi-browser's confirm polls back off 0.5 to 4 s). */
export const RELEASE_ALLOWANCE_S = 30;

/** How long pi-browser leaves a create whose answer was lost before it releases it by its tag (its create deadline; serve
 *  keeps the default). */
export const CREATE_DEADLINE_S = 60;

export const priceEnvOf = (provider: string) => `${BROWSER_PRICE_ENV}${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** `provider`'s session price: the operator's (a non-negative decimal), else the list's; `usdPerHour` null when neither
 *  names one or the operator's cannot be read, which is no price, never $0. */
export function browserPrice(provider: string, env: NodeJS.ProcessEnv): { usdPerHour: number | null; minimumS: number } {
  const listed = Object.hasOwn(BROWSER_PRICES, provider) ? BROWSER_PRICES[provider] : undefined;
  const text = env[priceEnvOf(provider)]?.trim();
  const given = text ? (/^(\d+(\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN) : undefined;
  return { usdPerHour: given === undefined ? (listed?.usdPerHour ?? null) : Number.isFinite(given) ? given : null, minimumS: listed?.minimumS ?? 0 };
}

type Hold = ReturnType<typeof keepHold>;
/** A cap refusal as the run's pause reads it (its words; for good, or for room with its figures). */
type LedgerRefusal = Refusal;
/** Up to the millionth of a dollar, so the cap's words name a figure never below the hold. */
const microUsd = (usd: number) => Math.ceil(Math.round(usd * 1e12) / 1e6) / 1e6;
/** A browser charge as its TOOL_COST holds it. */
type Booked = { tool: "browser"; charged_by: string; call: string | null; usd: number | null; seconds: number; tag: string; conversation: number; at: string; final: boolean };
type Open = { cid: number; reserve: Hold; at: number; call: string | null };
/** A row of pi-browser's open-session inventory. */
type Row = { tag: string; conversationId: number; state: string; resourceId: string | null };

/** One run's browser bookings, for its one provider at `price` with pi-browser's idle window `idleS`. `release` lets go of
 *  a conversation's session (pi-browser's release, "close"). `log` takes the line that says a charge went uncounted
 *  (default: the server's stderr). */
export function browserSpend(provider: string, price: { usdPerHour: number | null; minimumS: number }, idleS: number, release: (conversation: Pick<Conversation, "id" | "commit">, context: Context) => Promise<void>, log: (line: string) => void = (line) => void process.stderr.write(`agentrun-serve: ${line}\n`), ledger: { paid?: PaidBooking; pause?: (refusal: LedgerRefusal) => Promise<void> } = {}) {
  /** The runner's one ledger (the kernel cap's paidCalls), when the run has one: each browser call is one paid request on
   *  it, held at the hold main takes for it and settled at the charges booked under it; a charge under no call (a
   *  session's release, its top-up to the minute) is one more, settled at that charge. In place of this process's spend. */
  const paid = ledger.paid;
  /** Each browser call under way on the ledger: what has been charged under it (null: a charge with no price). */
  const chargedUnder = new Map<string, number | null>();
  /** The ledger steps of charges under no call, until they are written (ledgerIdle). */
  const pending = new Set<Promise<unknown>>();
  let ledgerSeq = 0;
  /** A hold of `usd` under `name`: on the run's one ledger when it is given (a held paid step, settled at nothing when the
   *  hold is let go, the time it held being booked by the session's own charge), else in this process's holds (keepHold).
   *  On the ledger nothing is written to this process's holds or spend. `admitted`: the ledger's answer (refused in the
   *  cap's words when it has no room). */
  const holdOf = (name: string, usd: number, basis: string): { hold: Hold; admitted: Promise<{ refused?: string; refusal?: LedgerRefusal }> } => {
    if (!paid) return { hold: keepHold(usd), admitted: Promise.resolve({}) };
    const booking = paid;
    const id = `browser:${name}#${(ledgerSeq += 1)}`;
    const admitted: Promise<{ refused?: string; refusal?: LedgerRefusal }> = booking.admit({ id, name, holdUsd: usd, basis, chargedBy: provider }).then(
      () => ({}),
      (error: unknown) => {
        const capped = (error as { code?: unknown })?.code === "spend_cap_reached";
        const refused = capped ? String((error as Error).message) : `${name} could not be held: ${String((error as Error)?.message ?? error)}`;
        // The cap's own refusal, as the run's pause reads it (a room refusal's figures; a refusal for good).
        const given = error as { forGood?: boolean; figures?: LedgerRefusal["figures"] };
        return { refused, ...(capped ? { refusal: { refuse: refused, forGood: given.forGood ?? true, ...(given.figures ? { figures: given.figures } : {}) } } : {}) };
      },
    );
    pending.add(admitted);
    void admitted.finally(() => pending.delete(admitted));
    let dropped = false;
    const hold = {
      usd,
      drop: () => {
        if (dropped) return;
        dropped = true;
        const settled = admitted.then((answer) => (answer.refused === undefined ? booking.settle(id, 0) : undefined)).catch(() => undefined);
        pending.add(settled);
        void settled.finally(() => pending.delete(settled));
      },
    };
    return { hold, admitted };
  };
  /** A charge joins this process's spend only off the ledger: on it, the charge is the ledger's (its own paid step). */
  const spendIn = (usd: number | null): void => {
    if (!paid) addSpend(usd);
  };
  const rate = price.usdPerHour;
  const usdOf = (seconds: number) => ((rate ?? 0) * seconds) / 3600;
  const stretchS = price.minimumS + idleS + RELEASE_ALLOWANCE_S;
  const stretch = usdOf(stretchS);
  const sessions = new Map<string, Open>();
  /** A person's time on a session that has ended but is not booked yet (personTime's holds are dropped as it ends), held
   *  at its price, each stretch from `from` to `to` (ms), until a charge books it (as far as that charge's own through), or
   *  the session leaves the inventory. The minutes are held once: a call's hold leaves out what is carried (capped). */
  const carried = new Map<string, Array<{ hold: Hold; from: number; to: number }>>();
  const dropCarried = (tag: string) => { for (const { hold } of carried.get(tag) ?? []) hold.drop(); carried.delete(tag); };
  /** A person's time on a session that is still under way (a take-over, an ask): each stretch its holds cover, from `from`
   *  to `to` (ms), while held. The part of it already run is in its hold, so a call's hold leaves it out, as carried time;
   *  a charge that books it takes it off the hold. */
  const active = new Map<string, Set<{ hold: Hold; from: number; to: number }>>();
  /** The carried time a charge through `through` (ms) books goes; a stretch that runs past it keeps what is after it. A
   *  person's stretch still under way keeps only what is after it, held until its holder drops it. */
  const bookCarried = (tag: string, through: number) => {
    for (const stretch of active.get(tag) ?? []) {
      if (stretch.from >= through) continue;
      stretch.from = Math.min(through, stretch.to);
      stretch.hold.usd = microUsd(usdOf((stretch.to - stretch.from) / 1000));
    }
    const kept = (carried.get(tag) ?? []).filter((stretch) => {
      if (stretch.to <= through) {
        stretch.hold.drop();
        return false;
      }
      if (stretch.from < through) {
        stretch.from = through;
        stretch.hold.usd = microUsd(usdOf((stretch.to - through) / 1000));
      }
      return true;
    });
    if (kept.length) carried.set(tag, kept);
    else carried.delete(tag);
  };
  /** What is carried for `tag` and falls after `since` (ms): the part of a session's run since its last charge that a call's
   *  hold must not count again. */
  const carriedSince = (tag: string, since: number, now: number) =>
    (carried.get(tag) ?? []).reduce((sum, { from, to }) => sum + usdOf(Math.max(0, to - Math.max(from, since)) / 1000), 0) +
    // A person who has the browser now: what of their held time has run is held already, as carried time is.
    [...(active.get(tag) ?? [])].reduce((sum, { from, to }) => sum + usdOf(Math.max(0, Math.min(to, now) - Math.max(from, since)) / 1000), 0);
  /** Each call under way, by its id: its conversation and its hold. */
  const calls = new Map<string, { cid: number; hold: Hold }>();
  const take = (hold: Hold | undefined, usd: number) => void (hold && (hold.usd = Math.max(0, hold.usd - usd)));

  /** Booked in the commit that bills it: a TOOL_COST under the call that ran it (a release's, under its session's last
   *  call), what it cost or null when its time has no price, and the seconds it was for, with what `booked` needs. A free
   *  provider's time books nothing and holds nothing. */
  async function onCharge(charge: SessionCharge, tx: Tx, call?: { callId: string }): Promise<void> {
    if (rate === 0) return;
    const usd = charge.state === "priced" ? charge.usd : null;
    if (paid) {
      const under = call?.callId;
      if (under !== undefined && chargedUnder.has(under)) {
        const so = chargedUnder.get(under) ?? null;
        chargedUnder.set(under, so === null || usd === null ? null : so + usd);
      } else {
        // A charge under no call under way (the release's, its top-up to the minute): one more paid request on the ledger,
        // held at nothing (its time is spent already) and settled at the charge.
        const step = paidStep(paid, `${charge.tag}${charge.final ? "@release" : "@charge"}`, { name: "this browser session's time", holdUsd: 0, basis: `${provider}'s session time, billed as it was charged`, by: charge.provider }, async () => undefined, () => usd).catch(() => undefined);
        pending.add(step);
        void step.finally(() => pending.delete(step));
      }
    }
    const data: Booked = { tool: "browser", charged_by: charge.provider, call: call?.callId ?? sessions.get(charge.tag)?.call ?? null, usd, seconds: charge.seconds, tag: charge.tag, conversation: charge.conversationId, at: charge.at, final: charge.final };
    await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: TOOL_COST, data });
  }

  /** A charge whose commit is in (watch): it joins what the run's process counts as spent, and moves the holds. Never
   *  inside the commit, so one that fails changes neither. */
  function booked(data: Booked): void {
    const usd = data.usd ?? 0;
    const session = sessions.get(data.tag);
    spendIn(data.usd);
    const through = Date.parse(data.at);
    // The part of this charge that is a kept session's person time, run since its last charge up to the charge's own
    // through: that part is held elsewhere already (carried, or still under way) and the call's hold left it out
    // (carriedSince), so it is taken off the call's hold below only once, never a second time with the rest of the charge.
    // Read before bookCarried, which trims those same holds.
    const personBooked = session && !data.final ? carriedSince(data.tag, session.at, through) : 0;
    // Its charge books the session's time since its last one, a person's included, up to its own through: what was carried
    // for it until then goes (all of it, at the release's), and a person's time after that through stays held. A charge
    // computed before a person's time ended, and committed after, so leaves the rest held.
    if (data.final) dropCarried(data.tag);
    else bookCarried(data.tag, through);
    if (data.final) {
      // A session the provider ended before its first charge has no reserve: its release comes out of its call's hold.
      take(session?.reserve ?? [...calls.values()].find((c) => c.cid === data.conversation)?.hold, usd);
      session?.reserve.drop();
      sessions.delete(data.tag);
    } else if (session) {
      take(data.call === null ? undefined : calls.get(data.call)?.hold, Math.max(0, usd - personBooked));
      // Its reserve is one stretch again: a kept session's held what it ran before this charge, which booked it.
      session.reserve.usd = stretch;
      Object.assign(session, { at: through, call: data.call ?? session.call });
    } else {
      take(data.call === null ? undefined : calls.get(data.call)?.hold, usd + stretch);
      sessions.set(data.tag, { cid: data.conversation, reserve: holdOf("this browser session's reserve", stretch, `${provider}'s next stretch of session time, held until its release is booked`).hold, at: through, call: data.call });
    }
  }

  /** At a reopen, after pi-browser's reconcile: every session its custody still tracks (each row of its inventory: kept,
   *  unreached, still releasing, lost) is held from here as if opened in this process, at a stretch beside what it ran
   *  since its last charge, the time the process was down included; that is already spent at the provider, so it is
   *  held, never refused. Its final charge, or its leaving the inventory, lets it go. One billed in full is not held. */
  async function reopened(harness: Pick<Session, "snapshot">, docs: { Inventory: unknown; Sessions: unknown }, context: Context): Promise<void> {
    if (rate === 0) return;
    const rows = Object.values(((await harness.snapshot(docs.Inventory as never, context)) as { rows?: Record<string, Row> } | undefined)?.rows ?? {});
    for (const row of rows.filter((r) => !sessions.has(r.tag))) {
      const record = ((await harness.snapshot(docs.Sessions as never, row.conversationId as never, context)) as { sessions?: { tag: string; spent: { chargedThrough: string; final?: true } }[] } | undefined)?.sessions?.find((s) => s.tag === row.tag);
      const at = Date.parse(record?.spent.chargedThrough ?? "");
      // Billed in full already (its release's charge landed since reconcile): nothing is left to hold, nor to drop it.
      if (!Number.isFinite(at) || record?.spent.final) continue;
      // Its reserve carries the down time, so its calls count what it runs from here (`at` now), not the down time again.
      const now = Date.now();
      sessions.set(row.tag, { cid: row.conversationId, reserve: holdOf("this browser session's reserve", stretch + usdOf(Math.max(0, now - at) / 1000), `${provider}'s session time since its last charge and its next stretch, held from the reopen`).hold, at: now, call: null });
    }
  }

  /** The open-session inventory as committed: a session it no longer holds lets go of its reserve (released, billed or
   *  not); one whose create's answer was lost, left to a release after the create deadline (releasing, no id), is held
   *  for that deadline and a stretch, out of its call's hold (two stretches, never less), until its release is billed or
   *  ends it. */
  function tracked(rows: Readonly<Record<string, Row>>): void {
    for (const [tag, open] of sessions) if (!Object.hasOwn(rows, tag)) (open.reserve.drop(), sessions.delete(tag));
    for (const tag of [...carried.keys()]) if (!Object.hasOwn(rows, tag)) dropCarried(tag);
    for (const row of Object.values(rows)) {
      if (rate === 0 || row.state !== "releasing" || row.resourceId !== null || sessions.has(row.tag)) continue;
      const usd = usdOf(CREATE_DEADLINE_S + stretchS);
      take([...calls.values()].find((c) => c.cid === row.conversationId)?.hold, usd);
      sessions.set(row.tag, { cid: row.conversationId, reserve: holdOf("this browser session's delayed release", usd, `${provider}'s session time for its create's deadline and a stretch, until its release is billed`).hold, at: Date.now(), call: null });
    }
  }

  /** Applies each browser charge `harness` commits, and each change of pi-browser's inventory (the document of kind
   *  `inventory`), once the commit is in: the charges first, so a release billed and ended in one commit is billed from
   *  its reserve before it goes. */
  function watch(harness: Pick<Session, "observeCommits" | "closed">, inventory = "browser.inventory"): void {
    // pi 1.5 detaches an observer whose advance throws, for good: every later charge would then go uncounted, silently.
    // So nothing leaves advance. A charge it fails to count makes the run's spend unknown (spent null), which a capped
    // run's next paid request or call is refused on, as it refuses any unknown spend; an uncapped run goes on, with one
    // line that says so. pi ends a commit observer only when its Session closes (session.js close: a normal close ends
    // it `failed` with "session closed", a failed Session `failed` with its error), and the Session's own end
    // (`closed`, settled by that same close once its Storage closed) says which, tagged by kind: `closed` keeps the
    // count, silently, on every close path; `failed` (the store failed, or could not close) leaves it unknown. A
    // listener error, which only a throw out of advance could cause, is unknown at once.
    let said = false;
    const uncounted = (why: string) => {
      // On the run's one ledger a charge is booked in the commit that bills it (onCharge), never from here.
      spendIn(null);
      if (said) return;
      said = true;
      log(logLine("browser_spend_uncounted", { said: `a browser charge was not counted in this process (${why.slice(0, 200)}): the run's spend is unknown from here` }));
    };
    harness.observeCommits({
      advance: (publication) => {
        try {
          for (const change of publication.changes) {
            const data = change.type === "entry" && change.value.kind === TOOL_COST ? (change.value.data as Partial<Booked> | undefined) : undefined;
            if (data?.tool === "browser" && typeof data.tag === "string") booked(data as Booked);
          }
          for (const change of publication.changes) {
            if (change.type === "document" && change.kind === "change" && change.record.kind === inventory) tracked(((change.value as { rows?: Record<string, Row> }).rows) ?? {});
          }
        } catch (error) {
          uncounted(String((error as Error)?.message ?? error));
        }
      },
      end: (end) => {
        const why = (kind: string, error: unknown) => `its commits stopped reaching the count: ${kind}${error === undefined ? "" : `, ${String((error as Error)?.message ?? error)}`}`;
        if (end.kind === "listener_error") return uncounted(why(end.kind, end.error));
        harness.closed.then(
          (ended) => void (ended.kind === "failed" && uncounted(why("the Session failed", ended.error))),
          (error: unknown) => uncounted(why("the Session's end is unknown", error)),
        );
      },
    });
  }

  /** `tool` held under the run's cap before each call. */
  function capped(tool: ToolRegistration): ToolRegistration {
    return {
      ...tool,
      execute: async (args: never, api: ToolExecutionApi, context: Context) => {
        const cap = runCap();
        if (cap !== undefined && rate === null) return refuse(`${SPEND_CAP_REACHED}: This browser call was not sent. ${provider}'s session time has no price here (${priceEnvOf(provider)} gives one), so the run's cap of $${cap} cannot be kept: the run is out of budget.`, api, context);
        const now = Date.now();
        const mine = [...sessions].filter(([, s]) => s.cid === api.conversationId);
        const ranS = mine.reduce((sum, [, s]) => sum + Math.max(0, now - s.at) / 1000, 0);
        // A person's time in that run is held already, carried or still under way: the call holds the rest of it, so the
        // minutes count once.
        const carriedUsd = mine.reduce((sum, [tag, s]) => sum + carriedSince(tag, s.at, now), 0);
        // Up to the millionth of a dollar, so the cap's words name a figure never below the hold.
        const usd = microUsd(Math.max(0, usdOf(ranS) - carriedUsd) + 2 * stretch);
        const basis = `${provider}'s session time at $${rate} an hour: the ${Math.round(ranS)} s its session ran since its last charge, and twice the next stretch of ${stretchS} s (its ${price.minimumS} s minimum, the ${idleS} s idle window and ${RELEASE_ALLOWANCE_S} s for its release)`;
        if (ledger.paid) {
          // On the runner's one ledger: one paid request, held at that same figure, settled at the charges booked under
          // this call (a call with none charged nothing; one with an unpriced charge at its hold).
          chargedUnder.set(api.callId, 0);
          calls.set(api.callId, { cid: api.conversationId, hold: { usd, drop: () => {} } as Hold });
          try {
            // A provider whose time has no price is held at no figure: the cap's rule refuses it for good, as main does.
            const stepped = await paidStep(ledger.paid, api.callId, { name: "this browser call", holdUsd: rate === null ? Number.NaN : usd, basis, by: provider }, () => tool.execute(args, api as never, context), () => chargedUnder.get(api.callId) ?? null);
            return "refused" in stepped ? await refuse(stepped.refused, api, context) : stepped.result;
          } finally {
            calls.delete(api.callId);
            chargedUnder.delete(api.callId);
          }
        }
        const paid = await paidCall("this browser call", async () => keepHold(usd), () => undefined, { usd, basis });
        if ("refused" in paid) return refuse(paid.refused, api, context);
        const hold = paid.result;
        calls.set(api.callId, { cid: api.conversationId, hold });
        try {
          return await tool.execute(args, api as never, context);
        } finally {
          calls.delete(api.callId);
          hold.drop();
        }
      },
    } as ToolRegistration;
  }

  /** pi-browser's `beforeCreate`: the session's open recorded in the run's journal (BROWSER_SESSION_OPEN) beside its
   *  `creating` record, and the journal synced (barriers.ts browserSessionOpen) before the vendor's session is created.
   *  A sync that fails throws, and pi-browser creates nothing. */
  const opening: BeforeCreate = async (open) => {
    const hold = [...calls.values()].find((c) => c.cid === open.conversationId)?.hold;
    const data = { tag: open.tag, conversation: open.conversationId, provider, held_usd: hold ? hold.usd : null };
    await open.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BROWSER_SESSION_OPEN, data })));
    await syncNow(runJournal(), BARRIER.browserSessionOpen);
  };

  /** The cap's refusal as the call's error, and the conversation's session let go, so it runs no longer. */
  async function refuse(why: string, api: ToolExecutionApi, context: Context) {
    await release({ id: api.conversationId, commit: api.commit.bind(api) } as never, context).catch(() => undefined);
    return forModel(JSON.stringify({ error: why }), { isError: true });
  }

  /** A person's time with a session, held up front under the run's cap (a take-over from the live view, an agent's ask for a person): the next
   *  `seconds` of session time at the provider's price, the most the person's time may last before it expires, held before it starts and refused
   *  in the cap's words when the cap has no room for it. The hold is the caller's to drop when the person's time ends; the time itself is booked
   *  as any session time is, at the session's next charge. A free provider's time holds nothing. With `tag` (its session)
   *  and `from` (ms, where the stretch it holds starts; now by default), the stretch is known while held: a call meanwhile
   *  leaves out what of it has run, and a charge that books it takes it off the hold. */
  async function personTime(what: string, seconds: number, options: { pauses?: boolean; tag?: string; from?: number } = {}): Promise<{ refused: string } | { drop(): void }> {
    const cap = runCap();
    if (cap !== undefined && rate === null) return { refused: `${SPEND_CAP_REACHED}: ${what} did not start. ${provider}'s session time has no price here (${priceEnvOf(provider)} gives one), so the run's cap of $${cap} cannot be kept.` };
    // Up to the millionth of a dollar, so the cap's words name a figure never below the hold.
    const usd = Math.ceil(Math.round(usdOf(seconds) * 1e12) / 1e6) / 1e6;
    const basis = `${provider}'s session time at $${rate} an hour for the ${Math.round(seconds / 60)} minutes it may last`;
    // A refusal pauses the run at its next request (paidCall) only for the agent's own step (an ask); `pauses: false` for a
    // person's take-over, which is no step of the agent's.
    let hold: Hold;
    if (ledger.paid) {
      // On the run's one ledger: held there up front, refused in the cap's words when it has no room (an unpriced
      // provider's time held at no figure, which the rule refuses for good); let go at its end, the time itself booked by
      // the session's next charge.
      const held = holdOf(what, rate === null ? Number.NaN : usd, basis);
      const answer = await held.admitted;
      if (answer.refused !== undefined) {
        // The agent's own step (an ask) refused at the cap pauses the run, as main's paidCall pause does: its pause is
        // journaled now and the run's next request is refused in its words. A person's take-over (pauses: false) pauses
        // nothing.
        if (options.pauses !== false && answer.refusal && ledger.pause) await ledger.pause(answer.refusal);
        return { refused: answer.refused };
      }
      hold = held.hold;
    } else {
      const paidHere = await paidCall(what, async () => keepHold(usd), () => undefined, { usd, basis }, { pauses: options.pauses });
      if ("refused" in paidHere) return { refused: paidHere.refused };
      hold = paidHere.result;
    }
    const tag = options.tag;
    if (tag === undefined || !rate) return hold;
    const from = options.from ?? Date.now();
    const stretch = { hold, from, to: from + seconds * 1000 };
    active.set(tag, (active.get(tag) ?? new Set()).add(stretch));
    return {
      drop: () => {
        const on = active.get(tag);
        if (on?.delete(stretch) && !on.size) active.delete(tag);
        hold.drop();
      },
    };
  }

  /** The person's time on session `tag` that just ended (`seconds` of it), held at the provider's price until the session's
   *  next charge books it: the time is spent at the provider, so it is held, never refused. A free or unpriced provider's
   *  holds nothing (an unpriced one under a cap was refused before any of it started). */
  function carry(tag: string, seconds: number): void {
    if (!rate || !(seconds > 0)) return;
    // Never further back than the session's last charge, which booked the time before it.
    const to = Date.now();
    const from = Math.max(to - seconds * 1000, sessions.get(tag)?.at ?? -Infinity);
    if (!(to > from)) return;
    // Spent at the provider already: held on the run's ledger (or this process's holds) until a charge books it.
    const { hold } = holdOf("a person's time in the browser", microUsd(usdOf((to - from) / 1000)), `${provider}'s session time a person used, until the session's next charge books it`);
    carried.set(tag, [...(carried.get(tag) ?? []), { hold, from, to }]);
  }

  /** Once every ledger step of a charge under no call is written (the runner's one ledger; nothing to wait for without). */
  const ledgerIdle = async (): Promise<void> => void (await Promise.all([...pending]));

  return { onCharge, watch, reopened, capped, opening, personTime, carry, stretch, ledgerIdle };
}
