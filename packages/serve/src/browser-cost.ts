// Browser minutes in the run's spend, on the run's one ledger (the kernel cap's paid tool calls, RunTools): each charge
// of a browser session's time (pi-browser's onCharge) is recorded on the run's root (BROWSER_CHARGED, no cost) in the
// commit that bills it, and its money is a paid step on the ledger, booked once that commit is in (never for a commit
// that failed). The ledger is another session than the root, so the two are not one commit: a process lost between them
// leaves a call's charges at its step's hold (booked cut, never less), and a charge under no call unbooked on the
// ledger, its record on the root, which the next claim's reopen books. Under a cap, no session time runs that the
// ledger has not held first:
// - The next stretch is the most a session can run before the run can check again: the provider's minimum (what a
//   release may top it up to), the idle window before pi-browser releases it, and RELEASE_ALLOWANCE_S for that release
//   to be confirmed at the provider.
// - Before each browser call, the call is held at what its conversation's sessions ran since their last charge, plus
//   two stretches: one for the call's own time, one for the reserve of a session it opens. Refused, the call is not
//   sent: the model gets the cap's words, and the conversation's session is released.
// - A session's first charge holds one stretch as the session's own reserve, until its release is booked: its idle
//   time, its top-up and its release. A person's time is held up front (personTime), and what of it was used is held
//   until a charge books it (carry).
// A session still tracked across a restart of the run's process is held from the reopen (reopened), at a stretch
// beside what it ran since its last charge. A single call that runs longer than a stretch, a release that takes longer
// than its allowance to be confirmed, and the time a run's process was down while it held a session (spent before any
// process could hold it) can pass the cap, by that much, booked and shown.
// With no run's ledger, nothing is held or booked anywhere: every browser call and every person's time is refused
// unsent, as a priced MCP call is (mcp-gateway.ts).
import type { Context } from "@earendil-works/chord/context";
import type { Refusal } from "@parcha/agentrun-kernel";
import { type Harness, ROOT_CONVERSATION_ID, type Conversation, type Session, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { PROVIDERS } from "@parcha/agentrun-computer";
import type { SessionCharge } from "@parcha/pi-browser";
import type { BeforeCreate } from "@parcha/pi-browser/durable";
import { BROWSER_CHARGED, SPEND_CAP_REACHED, UNHELD_BROWSER_TAG, unheldBrowserTag } from "./cap.js";
import { BROWSERS_UNHELD } from "./timeline/index.js";
import type { UnheldSessions } from "./workspace/resolve-computer.js";
import { type PaidBooking, paidStep, unbookedRefusal } from "./paid-calls.js";
import { logLine } from "./print.js";
import { forModel } from "./result.js";

/** The run journal's record of a browser session about to be created at its provider: its tag (pi-browser's, which a
 *  reconcile finds the vendor's session by), its conversation and the hold its call keeps for it (`held_usd`, null with
 *  no cap). Written with pi-browser's own `creating` record and flushed before the vendor is asked, so a lost box never
 *  leaves a session billed that no record in the store names. */
export const BROWSER_SESSION_OPEN = "agentrun.browser_session_open";

/** List prices by pi-browser provider name (`provider.name`): Browserbase's (pi-browser's LIST_PRICES), $0.12 an hour with
 *  a one-minute minimum; Kernel's headless browser, about $0.06 an hour billed by the second; a local Chrome (`cdp`),
 *  free. A computer provider whose descriptor bills nothing (metered false: Local Chrome's) is free too (browserPrice). */
export const BROWSER_PRICES: Readonly<Record<string, { usdPerHour: number; minimumS: number }>> = Object.freeze({
  browserbase: { usdPerHour: 0.12, minimumS: 60 },
  kernel: { usdPerHour: 0.06, minimumS: 0 },
  cdp: { usdPerHour: 0, minimumS: 0 },
});
/** The free price of a computer provider whose descriptor says it bills nothing, never by its id. */
const unmeteredPrice = (provider: string): { usdPerHour: number; minimumS: number } | undefined =>
  PROVIDERS.some((entry) => entry.id === provider && !entry.metered) ? { usdPerHour: 0, minimumS: 0 } : undefined;
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
  const listed = Object.hasOwn(BROWSER_PRICES, provider) ? BROWSER_PRICES[provider] : unmeteredPrice(provider);
  const text = env[priceEnvOf(provider)]?.trim();
  const given = text ? (/^(\d+(\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN) : undefined;
  return { usdPerHour: given === undefined ? (listed?.usdPerHour ?? null) : Number.isFinite(given) ? given : null, minimumS: listed?.minimumS ?? 0 };
}

/** A hold on the run's ledger, as the browser keeps it: its figure (moved as charges book the time it covers), and
 *  `drop`, which gives it back (on the ledger, once its returned promise settles; a hold held nowhere returns nothing). */
type Hold = { usd: number; drop(): Promise<void> | void };
/** A cap refusal as the run's pause reads it (its words; for good, or for room with its figures). */
type LedgerRefusal = Refusal;
/** Up to the millionth of a dollar, so the cap's words name a figure never below the hold. */
const microUsd = (usd: number) => Math.ceil(Math.round(usd * 1e12) / 1e6) / 1e6;
/** A browser charge as its BROWSER_CHARGED record holds it. */
type Booked = { tool: "browser"; charged_by: string; call: string | null; usd: number | null; seconds: number; tag: string; conversation: number; at: string; final: boolean };
/** An open session: its conversation, its reserve, the through of its last charge and its last call. `refused`: the cap
 *  refused its reserve (askReserve), so nothing is held for it, and its next charge asks again. */
type Open = { cid: number; reserve: Hold; at: number; call: string | null; refused?: boolean };
export { BROWSER_CHARGED };
/** Each browser step that is owed, by name: booked and held past the cap's rule (kernel/cap port.ts), for money its
 *  provider is already owed outside any call. The one place this file sets owed (owed-pin.test.mjs pins the list and
 *  each name's one use): a new owed step is named here, and reviewed there. */
const OWED = {
  /** A charge's time, as charged (bookOnLedger): under no call too (a release, its top-up). */
  charge: { owed: true },
  /** A kept session's reserve, held from the reopen (its time since its last charge and its next stretch). */
  reopenReserve: { owed: true },
  /** That reserve held again at one stretch once its charge booked the time before it. */
  reserveAgain: { owed: true },
  /** A delayed release's hold, until its release is billed. */
  delayedRelease: { owed: true },
  /** A person's carried time, until the session's next charge books it. */
  personTime: { owed: true },
} as const;
/** The tool a browser step on the run's one ledger names (main's charge's `tool`, the timeline's BROWSER_CHARGE): the run
 *  view folds its charge into its call's row, as main's. */
const BROWSER_TOOL = "browser";
/** A row of pi-browser's open-session inventory. */
type Row = { tag: string; conversationId: number; state: string; resourceId: string | null };

/** The tag a browser a create race left running is charged under (BROWSER_CHARGED), whichever release ended it (a let-go's
 *  releaseUnheld, or a release by a session's tag that ended it beside that session): one key, so it is charged once in a
 *  process and booked once on the ledger (chargeRef). */
export const unheldTag = (id: string): string => `${UNHELD_BROWSER_TAG}${id}`;

/** What a release of the browsers a create race left running says on the run's timeline and its root (BROWSERS_UNHELD):
 *  that nothing the run held was among them, so a reader does not take their time for the run's own use. */
export function unheldWords(swept: UnheldSessions): string {
  const n = swept.released.length;
  const one = n === 1;
  const released = n > 0 ? `Released ${n} browser${one ? "" : "s"} a create race left running (${swept.released.map((r) => r.id).join(", ")}); this run did not hold ${one ? "it" : "them"}, and ${one ? "its" : "their"} time is booked on the run and absorbed, not billed.` : "";
  const failed = swept.failed.length > 0 ? `Could not release ${swept.failed.length} browser${swept.failed.length === 1 ? "" : "s"} a create race left running (${swept.failed.join("; ")}): each runs to its vendor's lifetime.` : "";
  const creating = swept.creating.length > 0 ? `Left ${swept.creating.length} browser${swept.creating.length === 1 ? "" : "s"} to ${swept.creating.length === 1 ? "its create" : "their creates"}, still running (${swept.creating.join(", ")}).` : "";
  return [released, failed, creating].filter(Boolean).join(" ");
}

/** One run's browser bookings, for its one provider at `price` with pi-browser's idle window `idleS`. `release` lets go of
 *  a conversation's session (pi-browser's release, "close"). `log` takes the line that says a charge went uncounted
 *  (default: the server's stderr). */
export function browserSpend(provider: string, price: { usdPerHour: number | null; minimumS: number }, idleS: number, release: (conversation: Pick<Conversation, "id" | "commit">, context: Context) => Promise<void>, log: (line: string) => void = (line) => void process.stderr.write(`agentrun-serve: ${line}\n`), ledger: { paid?: PaidBooking; pause?: (refusal: LedgerRefusal) => Promise<void>; flush?: () => Promise<void> } = {}) {
  /** The runner's one ledger (the kernel cap's paidCalls); with none, every call and person's time is refused. Its holds
   *  are hold-only steps (`hold`:
   *  money reserved, never spent, given back when let go or when a claim is lost): each browser call's, held at the hold
   *  main takes for it, a session's reserve, a person's time. Its money is its charges: each one paid step of its own,
   *  owed (its time is spent at the provider: never refused, however the run's spend stands), settled at the charge,
   *  named by its session and time (`ref`) so it is booked once, and booked once its commit is in (booked); a reopen books
   *  any the root holds and the ledger lacks (reopened). Every step names its tool
   *  ("browser") and, where it has them, its call and session, so the run view folds it as main's charge. */
  const paid = ledger.paid;
  /** The ledger steps of charges and holds, until they are written (ledgerIdle). */
  const pending = new Set<Promise<unknown>>();
  let ledgerSeq = 0;
  /** A hold of `usd` under `name` on the run's one ledger (a held paid step, given back when the hold is let go, the time
   *  it held being booked by the session's own charge). `admitted`: the ledger's answer (refused in the cap's words when
   *  it has no room; refused with no ledger, where nothing is held). `owed`: time its provider is already owed, run
   *  outside any call (a person's carried time, a session held from a reopen, a delayed release): never refused. A fresh
   *  session's reserve and a person's time to come (personTime) are not owed: the cap may refuse them. `after`: the hold
   *  this one takes the place of, given back (its drop's promise): this one is asked only once that has landed, so the
   *  ledger never judges the two side by side, whatever order it books them in. */
  const holdOf = (name: string, usd: number, basis: string, options: { owed?: true; tag?: string; after?: Promise<void> | void } = {}): { hold: Hold; admitted: Promise<{ refused?: string; refusal?: LedgerRefusal }> } => {
    if (!paid) return { hold: { usd, drop: () => {} }, admitted: Promise.resolve({ refused: unbookedRefusal(name) }) };
    const booking = paid;
    const id = `browser:${name}#${(ledgerSeq += 1)}`;
    const ask = () => booking.admit({ id, name, holdUsd: usd, basis, chargedBy: provider, tool: BROWSER_TOOL, hold: true, ...(options.tag ? { tag: options.tag } : {}), ...(options.owed ? { owed: true as const } : {}) });
    const admitted: Promise<{ refused?: string; refusal?: LedgerRefusal }> = (options.after ? options.after.then(ask, ask) : ask()).then(
      () => ({}),
      (error: unknown) => {
        const capped = (error as { code?: unknown })?.code === "spend_cap_reached";
        const refused = capped ? String((error as Error).message) : `${name} could not be held: ${String((error as Error)?.message ?? error)}`;
        // The cap's own refusal, as the run's pause reads it (a room refusal's figures; a refusal for good).
        const given = error as { forGood?: boolean; figures?: LedgerRefusal["figures"] };
        // Its code rides with it (Refusal.code): the model request the pause refuses next is the cap's refusal.
        return { refused, ...(capped ? { refusal: { refuse: refused, code: SPEND_CAP_REACHED, forGood: given.forGood ?? true, ...(given.figures ? { figures: given.figures } : {}) } } : {}) };
      },
    );
    pending.add(admitted);
    void admitted.finally(() => pending.delete(admitted));
    let settled: Promise<void> | undefined;
    const hold = {
      usd,
      drop: (): Promise<void> => {
        if (settled) return settled;
        // Given back: a hold is no charge (its time, when it ran, is booked by the session's own charge), never a $0 one.
        const giving = admitted.then((answer) => (answer.refused === undefined ? booking.settle(id, 0, { givenBack: true }) : undefined)).then(() => undefined, () => undefined);
        settled = giving;
        pending.add(giving);
        void giving.finally(() => pending.delete(giving));
        return giving;
      },
    };
    return { hold, admitted };
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
  /** Each call under way, by its id: its conversation, its hold, `givenBack` (settles once its hold on the run's ledger
   *  is given back) and `reserves`, the reserves of the sessions it opened, each asked on the ledger once that has landed
   *  (the call returns only once they are held, or refused and acted on). */
  const calls = new Map<string, { cid: number; hold: Hold; givenBack: Promise<void>; reserves: Promise<void>[] }>();
  const take = (hold: Hold | undefined, usd: number) => void (hold && (hold.usd = Math.max(0, hold.usd - usd)));

  /** Session `tag`'s reserve, one stretch, asked of the cap and not owed: a new session's, or one whose reserve the cap
   *  refused before, asked again. Under `call` it is asked once the call's hold is given back (after), in the room that
   *  hold kept for it, and the call returns only once it is held, or refused and acted on (reserves): until then the
   *  call's own hold covers the session. Refused, its next stretch is held nowhere: that is said, and the cap's own
   *  refusal pauses the run, as an ask's refused time does (personTime), so its next request is refused in the cap's words
   *  and it parks for a raise. The session is then marked (Open.refused) while this is still its reserve, so its next
   *  charge asks again, and once the cap is raised its next stretch is held. A refusal that is not the cap's (a lost
   *  claim's) marks nothing: no raise mends it, and the next claim's reopen holds the session. */
  const askReserve = (tag: string, basis: string, call: { givenBack: Promise<void>; reserves: Promise<void>[] } | undefined): Hold => {
    const reserve = holdOf("this browser session's reserve", stretch, basis, { tag, ...(call ? { after: call.givenBack } : {}) });
    const acted = reserve.admitted.then(async (answer) => {
      if (answer.refused === undefined) return;
      const open = sessions.get(tag);
      if (answer.refusal && open?.reserve === reserve.hold) open.refused = true;
      log(logLine("browser_reserve_refused", { said: `the reserve of browser session ${tag} was not held on the run's ledger (${answer.refused.slice(0, 200)}): its next stretch is held nowhere` }));
      if (answer.refusal && ledger.pause) await ledger.pause(answer.refusal);
    }).catch((error: unknown) => void log(logLine("browser_reserve_refused", { said: `the run could not be paused on the refused reserve of browser session ${tag} (${String((error as Error)?.message ?? error).slice(0, 200)})` })));
    pending.add(acted);
    void acted.finally(() => pending.delete(acted));
    call?.reserves.push(acted);
    return reserve.hold;
  };

  /** Recorded in the commit that bills it: a BROWSER_CHARGED under the call that ran it (a release's, under its session's
   *  last call), its money the ledger step's (booked), what it cost or null when its time has no price, and the seconds it
   *  was for, with what `booked` needs. A free provider's time books nothing and holds nothing. */
  async function onCharge(charge: SessionCharge, tx: Tx, call?: { callId: string }): Promise<void> {
    if (rate === 0) return;
    const usd = charge.state === "priced" ? charge.usd : null;
    const data: Booked = { tool: "browser", charged_by: charge.provider, call: call?.callId ?? sessions.get(charge.tag)?.call ?? null, usd, seconds: charge.seconds, tag: charge.tag, conversation: charge.conversationId, at: charge.at, final: charge.final };
    // Its money is the ledger's, booked once this commit is in (booked): the root keeps the record under a kind no cost reads.
    await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BROWSER_CHARGED, data });
  }

  /** A charge on the run's one ledger, once its commit is in: one paid step of its own, owed (its time is spent at the
   *  provider, so the cap never refuses it, however the run's spend stands), settled at the charge, under its call (the
   *  one that ran it, else its session's last; none after a restart that lost it) and named by its session and time, so
   *  it is booked once whoever books it (this, or a reopen's: reopened). One that cannot be booked (its claim lost, a
   *  write that failed) is said in the log, and booked by the next claim's reopen. */
  function bookOnLedger(booking: PaidBooking, data: Booked): Promise<void> {
    // Held at its charge (known: it was billed): a claim lost before its settle leaves it booked at that, never unknown
    // (the kernel's bookCut books an owed step at its hold). A charge of an unknown amount holds nothing.
    const owes = typeof data.usd === "number" && Number.isFinite(data.usd) && data.usd > 0 ? data.usd : 0;
    const step = paidStep(booking, data.call ?? undefined, { name: "this browser session's time", holdUsd: owes, basis: `${provider}'s session time, billed as it was charged`, by: data.charged_by, tool: BROWSER_TOOL, tag: data.tag, ...OWED.charge, ref: chargeRef(data) }, async () => undefined, () => data.usd).then(
      (stepped) => void ("refused" in stepped && log(logLine("browser_spend_unbooked", { said: `a browser charge of ${data.tag} was not booked on the run's ledger (${stepped.refused.slice(0, 200)}): the next claim's reopen books it` }))),
      (error: unknown) => void log(logLine("browser_spend_unbooked", { said: `a browser charge of ${data.tag} was not booked on the run's ledger (${String((error as Error)?.message ?? error).slice(0, 200)}): the next claim's reopen books it` })),
    );
    pending.add(step);
    void step.finally(() => pending.delete(step));
    return step;
  }

  /** A charge whose commit is in (watch): booked on the ledger, and it moves the holds. Never inside the commit, so one
   *  that fails changes neither. */
  function booked(data: Booked): void {
    if (paid) bookOnLedger(paid, data);
    const usd = data.usd ?? 0;
    const session = sessions.get(data.tag);
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
      // Its reserve is one stretch again: a kept session's (a reopen's, a delayed release's) held what it ran before this
      // charge, which booked it. On the run's ledger too, where a hold keeps the figure it was admitted at: that hold is
      // given back for one of a stretch, so the time this charge booked is never held beside it. Owed, as the reserve it
      // takes the place of was: the session is open and its provider bills its time whatever the cap says, so a refusal
      // would only leave that time unheld (a new session's reserve is the cap's to refuse: its room is its call's hold's).
      // Asked once the old one is given back on the ledger (after), so the two are never held side by side there.
      // A session whose reserve the cap refused holds nothing on the ledger: its reserve is asked again (askReserve), not
      // owed, as a new session's is, so a raise since holds its next stretch, and a cap still full refuses it again.
      if (session.refused) {
        session.refused = false;
        session.reserve = askReserve(data.tag, `${provider}'s next stretch of session time, asked again once the cap refused it`, data.call === null ? undefined : calls.get(data.call));
      } else if (session.reserve.usd !== stretch) {
        const givenBack = session.reserve.drop();
        session.reserve = holdOf("this browser session's reserve", stretch, `${provider}'s next stretch of session time, held again once its charge booked the time before it`, { ...OWED.reserveAgain, tag: data.tag, after: givenBack }).hold;
      }
      Object.assign(session, { at: through, call: data.call ?? session.call });
    } else {
      const call = data.call === null ? undefined : calls.get(data.call);
      take(call?.hold, usd + stretch);
      // Its call's hold is two stretches, one of them for this reserve, but on the run's ledger that hold keeps its
      // admitted figure until the call returns: asked beside it, the reserve would be judged twice and refused for room
      // the run has. So it is asked once the call's hold is given back, in the room that hold kept for it (askReserve). A
      // charge under no call still running asks at once. A new session's reserve is the cap's to refuse (starting a
      // session is a choice).
      sessions.set(data.tag, { cid: data.conversation, reserve: askReserve(data.tag, `${provider}'s next stretch of session time, held until its release is booked`, call), at: through, call: data.call });
    }
  }

  /** The one booking a charge names on the ledger: its session, its time, and whether it was the session's last. A
   *  browser a create race left (unheldTag) is charged once whatever ended it, so its booking is its id alone. */
  const chargeRef = (data: Pick<Booked, "tag" | "at" | "final">) => (unheldBrowserTag(data.tag) ? `browser:${data.tag}/final` : `browser:${data.tag}@${data.at}${data.final ? "/final" : ""}`);

  /** At a reopen, on the runner's one ledger: every charge the root holds (BROWSER_CHARGED) is booked there, once by its
   *  ref, so one whose commit landed and whose booking did not (its process lost between the two) is counted now; one
   *  booked already books nothing. */
  async function bookRootCharges(harness: Pick<Harness, "conversation">, context: Context): Promise<void> {
    if (!paid) return;
    const root = await harness.conversation(ROOT_CONVERSATION_ID as never, context);
    if (!root) return;
    const charges: Booked[] = [];
    for (let cursor: unknown = undefined; ; ) {
      const page = await root.entries({ order: "ascending" } as never, 500, cursor as never, context);
      for (const entry of page.items as readonly { kind: string; data?: unknown }[]) if (entry.kind === BROWSER_CHARGED) charges.push(entry.data as Booked);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    await Promise.all(charges.map((data) => bookOnLedger(paid, data)));
  }

  /** At a reopen, after pi-browser's reconcile: every session its custody still tracks (each row of its inventory: kept,
   *  unreached, still releasing, lost) is held from here as if opened in this process, at a stretch beside what it ran
   *  since its last charge, the time the process was down included; that is already spent at the provider, so it is
   *  held, never refused. Its final charge, or its leaving the inventory, lets it go. One billed in full is not held. */
  async function reopened(harness: Pick<Session, "snapshot"> & Partial<Pick<Harness, "conversation">>, docs: { Inventory: unknown; Sessions: unknown }, context: Context): Promise<void> {
    if (rate === 0) return;
    if (harness.conversation) await bookRootCharges(harness as Pick<Harness, "conversation">, context);
    const rows = Object.values(((await harness.snapshot(docs.Inventory as never, context)) as { rows?: Record<string, Row> } | undefined)?.rows ?? {});
    for (const row of rows.filter((r) => !sessions.has(r.tag))) {
      const record = ((await harness.snapshot(docs.Sessions as never, row.conversationId as never, context)) as { sessions?: { tag: string; spent: { chargedThrough: string; final?: true } }[] } | undefined)?.sessions?.find((s) => s.tag === row.tag);
      const at = Date.parse(record?.spent.chargedThrough ?? "");
      // Billed in full already (its release's charge landed since reconcile): nothing is left to hold, nor to drop it.
      if (!Number.isFinite(at) || record?.spent.final) continue;
      // Its reserve carries the down time, so its calls count what it runs from here (`at` now), not the down time again.
      const now = Date.now();
      sessions.set(row.tag, { cid: row.conversationId, reserve: holdOf("this browser session's reserve", stretch + usdOf(Math.max(0, now - at) / 1000), `${provider}'s session time since its last charge and its next stretch, held from the reopen`, { ...OWED.reopenReserve, tag: row.tag }).hold, at: now, call: null });
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
      sessions.set(row.tag, { cid: row.conversationId, reserve: holdOf("this browser session's delayed release", usd, `${provider}'s session time for its create's deadline and a stretch, until its release is billed`, { ...OWED.delayedRelease, tag: row.tag }).hold, at: Date.now(), call: null });
    }
  }

  /** Applies each browser charge `harness` commits, and each change of pi-browser's inventory (the document of kind
   *  `inventory`), once the commit is in: the charges first, so a release billed and ended in one commit is billed from
   *  its reserve before it goes. */
  function watch(harness: Pick<Session, "observeCommits" | "closed">, inventory = "browser.inventory"): void {
    // pi 1.5 detaches an observer whose advance throws, for good: every later charge would then go unbooked, silently.
    // So nothing leaves advance; a charge it fails to book is said in one line, and the next claim's reopen books it from
    // the root (bookRootCharges). pi ends a commit observer only when its Session closes (session.js close: a normal close
    // ends it `failed` with "session closed", a failed Session `failed` with its error), and the Session's own end
    // (`closed`, settled by that same close once its Storage closed) says which, tagged by kind: `closed` is said
    // nothing, on every close path; `failed` (the store failed, or could not close) is said. A listener error, which only
    // a throw out of advance could cause, is said at once.
    let said = false;
    const uncounted = (why: string) => {
      if (said) return;
      said = true;
      log(logLine("browser_spend_uncounted", { said: `a browser charge was not counted in this process (${why.slice(0, 200)}): the run's spend is unknown from here` }));
    };
    harness.observeCommits({
      advance: (publication) => {
        try {
          for (const change of publication.changes) {
            const data = change.type === "entry" && change.value.kind === BROWSER_CHARGED ? (change.value.data as Partial<Booked> | undefined) : undefined;
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

  /** `tool` held under the run's cap before each call, on the run's one ledger; with none, refused unsent. */
  function capped(tool: ToolRegistration): ToolRegistration {
    return {
      ...tool,
      execute: async (args: never, api: ToolExecutionApi, context: Context) => {
        if (!paid) return refuse(unbookedRefusal("this browser call"), api, context);
        const now = Date.now();
        const mine = [...sessions].filter(([, s]) => s.cid === api.conversationId);
        const ranS = mine.reduce((sum, [, s]) => sum + Math.max(0, now - s.at) / 1000, 0);
        // A person's time in that run is held already, carried or still under way: the call holds the rest of it, so the
        // minutes count once.
        const carriedUsd = mine.reduce((sum, [tag, s]) => sum + carriedSince(tag, s.at, now), 0);
        // Up to the millionth of a dollar, so the cap's words name a figure never below the hold.
        const usd = microUsd(Math.max(0, usdOf(ranS) - carriedUsd) + 2 * stretch);
        const basis = `${provider}'s session time at $${rate} an hour: the ${Math.round(ranS)} s its session ran since its last charge, and twice the next stretch of ${stretchS} s (its ${price.minimumS} s minimum, the ${idleS} s idle window and ${RELEASE_ALLOWANCE_S} s for its release)`;
        // One hold-only step, held at that figure and given back when the call returns (or its claim is lost): the call's
        // charges are each their own step (booked).
        let landed!: () => void;
        const entry = { cid: api.conversationId, hold: { usd, drop: () => {} }, givenBack: new Promise<void>((resolve) => (landed = resolve)), reserves: [] as Promise<void>[] };
        calls.set(api.callId, entry);
        try {
          // A provider whose time has no price is held at no figure: the cap's rule refuses it for good, as main does.
          // One refused for room pauses the run (ledger.pause, the run's own: a native tool task runs in no host tool
          // call's ledger), in the cap's words and figures, as an ask's person time does: its next request is refused
          // and the run parks for a raise.
          // paidStep returns once the call's hold is given back on the ledger (its settle): the reserves of the sessions
          // the call opened are asked then, and the call returns once they are held, so nothing the run does next is judged
          // while the session is held nowhere.
          const stepped = await paidStep(paid, api.callId, { name: "this browser call", holdUsd: rate === null ? Number.NaN : usd, basis, by: provider, tool: BROWSER_TOOL, hold: true }, () => tool.execute(args, api as never, context), () => 0, ledger.pause).finally(async () => {
            landed();
            await Promise.all(entry.reserves);
          });
          return "refused" in stepped ? await refuse(stepped.refused, api, context) : stepped.result;
        } finally {
          calls.delete(api.callId);
        }
      },
    } as ToolRegistration;
  }

  /** pi-browser's `beforeCreate`: the session's open recorded in the run's journal (BROWSER_SESSION_OPEN) beside its
   *  `creating` record, then flushed to disk (`ledger.flush`, the runner's store flush) before the vendor's session is
   *  created. The runner's flush before a tool call comes before the call opens its session, so it never covers this
   *  record. A write or a flush that fails throws, and pi-browser creates nothing. */
  const opening: BeforeCreate = async (open) => {
    const hold = [...calls.values()].find((c) => c.cid === open.conversationId)?.hold;
    const data = { tag: open.tag, conversation: open.conversationId, provider, held_usd: hold ? hold.usd : null };
    await open.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BROWSER_SESSION_OPEN, data })));
    await ledger.flush?.();
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
    // Up to the millionth of a dollar, so the cap's words name a figure never below the hold.
    const usd = Math.ceil(Math.round(usdOf(seconds) * 1e12) / 1e6) / 1e6;
    const basis = `${provider}'s session time at $${rate} an hour for the ${Math.round(seconds / 60)} minutes it may last`;
    // Held on the run's one ledger up front, refused in the cap's words when it has no room (an unpriced provider's time
    // held at no figure, which the rule refuses for good; with no ledger, refused); let go at its end, the time itself
    // booked by the session's next charge.
    const held = holdOf(what, rate === null ? Number.NaN : usd, basis);
    const answer = await held.admitted;
    if (answer.refused !== undefined) {
      // The agent's own step (an ask) refused at the cap pauses the run, as main's paidCall pause does: its pause is
      // journaled now and the run's next request is refused in its words. A person's take-over (pauses: false) pauses
      // nothing.
      if (options.pauses !== false && answer.refusal && ledger.pause) await ledger.pause(answer.refusal);
      return { refused: answer.refused };
    }
    const hold = held.hold;
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
    // Spent at the provider already: held on the run's ledger until a charge books it.
    const { hold } = holdOf("a person's time in the browser", microUsd(usdOf((to - from) / 1000)), `${provider}'s session time a person used, until the session's next charge books it`, { ...OWED.personTime, tag });
    carried.set(tag, [...(carried.get(tag) ?? []), { hold, from, to }]);
  }

  /** Once every ledger step of a charge under no call is written. */
  const ledgerIdle = async (): Promise<void> => void (await Promise.all([...pending]));

  /** The browsers a create race left running that this process has charged (unheldTag): each once, whichever release saw
   *  it end. */
  const raced = new Set<string>();
  /** Sessions a create race left running and nothing held, released (a let-go's ClaimBrowser.releaseUnheld, or a release
   *  by a session's tag that ended them beside it: pi-browser's onRaceReleased), in one commit on the run's root: each
   *  one's time charged as a session's release is (a BROWSER_CHARGED, final, under no call, its tag unheldTag), from when
   *  its vendor made it to `at`, topped up to the provider's minimum (pi-browser's sessionCharge), and what was released,
   *  what could not be, and what was left to a create still in flight, said on the run's timeline (BROWSERS_UNHELD). A
   *  session this process charged already is neither charged nor said again. Each charge is booked on the run's one ledger
   *  as every charge is, once its commit is in (watch, booked: by its ref, its id alone, so a reopen, or the other release,
   *  never books it twice). One whose vendor does not say when it made it is charged at no known amount (usd null):
   *  unknown, never 0. A free provider's time charges nothing. */
  async function unheld(harness: Pick<Harness, "commit">, swept: UnheldSessions, context: Context, at = new Date().toISOString()): Promise<void> {
    const fresh = { ...swept, released: swept.released.filter((one) => !raced.has(unheldTag(one.id))) };
    if (fresh.released.length === 0 && fresh.failed.length === 0 && fresh.creating.length === 0) return;
    // Taken before any wait, so a release that sees the same session meanwhile finds it charged; given back if the commit
    // fails, so the next release that sees it charges it.
    const tags = fresh.released.map((one) => unheldTag(one.id));
    for (const tag of tags) raced.add(tag);
    let words: string;
    try {
      const { sessionCharge, startSpent } = await import("@parcha/pi-browser");
      const prices = { sessionUsdPerHour: rate, sessionMinimumS: price.minimumS, fetchUsd: 0, fetchProxiedUsd: 0, searchUsd: 0 };
      const charges: Booked[] = fresh.released.map(({ id, createdAt }) => {
        const base = { tool: "browser" as const, charged_by: provider, call: null, tag: unheldTag(id), conversation: ROOT_CONVERSATION_ID as number, at, final: true };
        if (createdAt === null) return { ...base, usd: null, seconds: 0 };
        const charged = sessionCharge(startSpent(createdAt), at, prices, rate === null ? "unpriced" : "priced", true);
        return { ...base, usd: charged.usage.state === "priced" ? charged.usage.usage.cost.total : null, seconds: charged.spent.seconds };
      });
      words = unheldWords(fresh);
      await harness.commit(async (tx) => {
        if (rate !== 0) for (const data of charges) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BROWSER_CHARGED, data });
        await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BROWSERS_UNHELD, data: { words, released: fresh.released.map((one) => one.id), failed: [...fresh.failed], creating: [...fresh.creating] } });
      }, context);
    } catch (error) {
      for (const tag of tags) raced.delete(tag);
      throw error;
    }
    log(logLine("browser_unheld_released", { said: words }));
  }

  return { onCharge, watch, reopened, capped, opening, personTime, carry, stretch, ledgerIdle, unheld };
}
