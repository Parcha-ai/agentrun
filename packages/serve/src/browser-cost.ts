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
// the release. A session kept across a restart of the run's process is held from the reopen (kept), at a stretch beside
// what it ran since its last charge, and released an idle window after it unless a call uses it. A single call that runs
// longer than a stretch, a release that takes longer than its allowance to be confirmed, and the time a run's process
// was down while it held a session (spent before any process could hold it) can pass the cap, by that much, booked and
// shown.
import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, type Conversation, type Session, type ToolExecutionApi, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { SessionCharge } from "@parcha/pi-browser";
import { TOOL_COST } from "@parcha/pi-durable-agent/timeline";
import { addSpend, keepHold, paidCall, runCap, SPEND_CAP_REACHED } from "./cap.js";
import { forModel } from "./result.js";

/** List prices by pi-browser provider name (`provider.name`): Browserbase's (pi-browser's LIST_PRICES), $0.12 an hour with
 *  a one-minute minimum; Kernel's headless browser, about $0.06 an hour billed by the second; a local Chrome (`cdp`), free. */
export const BROWSER_PRICES: Readonly<Record<string, { usdPerHour: number; minimumS: number }>> = Object.freeze({
  browserbase: { usdPerHour: 0.12, minimumS: 60 },
  kernel: { usdPerHour: 0.06, minimumS: 0 },
  cdp: { usdPerHour: 0, minimumS: 0 },
});
/** An operator's price for a provider, in USD an hour: this prefix and the provider's name in capitals
 *  (AGENTRUN_BROWSER_USD_PER_HOUR_BROWSERBASE, _KERNEL, _CDP). */
export const BROWSER_PRICE_ENV = "AGENTRUN_BROWSER_USD_PER_HOUR_";
/** What a release may take to be confirmed at the provider once it is asked (pi-browser's confirm polls back off 0.5 to 4 s). */
export const RELEASE_ALLOWANCE_S = 30;

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
/** A browser charge as its TOOL_COST holds it. */
type Booked = { tool: "browser"; charged_by: string; call: string | null; usd: number | null; seconds: number; tag: string; conversation: number; at: string; final: boolean };
type Open = { cid: number; reserve: Hold; at: number; call: string | null };

/** One run's browser bookings, for its one provider at `price` with pi-browser's idle window `idleS`. `release` lets go of
 *  a conversation's session (pi-browser's release, "close"). */
export function browserSpend(provider: string, price: { usdPerHour: number | null; minimumS: number }, idleS: number, release: (conversation: Pick<Conversation, "id" | "commit">, context: Context) => Promise<void>) {
  const rate = price.usdPerHour;
  const usdOf = (seconds: number) => ((rate ?? 0) * seconds) / 3600;
  const stretchS = price.minimumS + idleS + RELEASE_ALLOWANCE_S;
  const stretch = usdOf(stretchS);
  const sessions = new Map<string, Open>();
  /** Each call under way, by its id: its conversation and its hold. */
  const calls = new Map<string, { cid: number; hold: Hold }>();
  const take = (hold: Hold | undefined, usd: number) => void (hold && (hold.usd = Math.max(0, hold.usd - usd)));

  /** Booked in the commit that bills it: a TOOL_COST under the call that ran it (a release's, under its session's last
   *  call), what it cost or null when its time has no price, and the seconds it was for, with what `booked` needs. A free
   *  provider's time books nothing and holds nothing. */
  async function onCharge(charge: SessionCharge, tx: Tx, call?: { callId: string }): Promise<void> {
    if (rate === 0) return;
    const usd = charge.state === "priced" ? charge.usd : null;
    const data: Booked = { tool: "browser", charged_by: charge.provider, call: call?.callId ?? sessions.get(charge.tag)?.call ?? null, usd, seconds: charge.seconds, tag: charge.tag, conversation: charge.conversationId, at: charge.at, final: charge.final };
    await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: TOOL_COST, data });
  }

  /** A charge whose commit is in (watch): it joins what the run's process counts as spent, and moves the holds. Never
   *  inside the commit, so one that fails changes neither. */
  function booked(data: Booked): void {
    const usd = data.usd ?? 0;
    const session = sessions.get(data.tag);
    addSpend(data.usd);
    if (data.final) {
      // A session the provider ended before its first charge has no reserve: its release comes out of its call's hold.
      take(session?.reserve ?? [...calls.values()].find((c) => c.cid === data.conversation)?.hold, usd);
      session?.reserve.drop();
      sessions.delete(data.tag);
    } else if (session) {
      take(data.call === null ? undefined : calls.get(data.call)?.hold, usd);
      // Its reserve is one stretch again: a kept session's held what it ran before this charge, which booked it.
      session.reserve.usd = stretch;
      Object.assign(session, { at: Date.parse(data.at), call: data.call ?? session.call });
    } else {
      take(data.call === null ? undefined : calls.get(data.call)?.hold, usd + stretch);
      sessions.set(data.tag, { cid: data.conversation, reserve: keepHold(stretch), at: Date.parse(data.at), call: data.call });
    }
  }

  /** The sessions a reopened run kept (pi-browser's reconcile `report`): held from here as if opened in this process, each
   *  at a stretch beside what it ran since its last charge, the time the process was down included; that is already
   *  spent at the provider, so it is held, never refused. */
  async function kept(harness: Pick<Session, "snapshot">, docs: { Inventory: unknown; Sessions: unknown }, report: { kept: readonly string[] }, context: Context): Promise<void> {
    if (rate === 0) return;
    const rows = Object.values(((await harness.snapshot(docs.Inventory as never, context)) as { rows?: Record<string, { tag: string; conversationId: number }> } | undefined)?.rows ?? {});
    for (const row of rows.filter((r) => report.kept.includes(r.tag) && !sessions.has(r.tag))) {
      const record = ((await harness.snapshot(docs.Sessions as never, row.conversationId as never, context)) as { sessions?: { tag: string; spent: { chargedThrough: string } }[] } | undefined)?.sessions?.find((s) => s.tag === row.tag);
      const at = Date.parse(record?.spent.chargedThrough ?? "");
      if (!Number.isFinite(at)) continue;
      sessions.set(row.tag, { cid: row.conversationId, reserve: keepHold(stretch + usdOf(Math.max(0, Date.now() - at) / 1000)), at, call: null });
    }
  }

  /** Applies each browser charge `harness` commits, once the commit is in. */
  function watch(harness: Pick<Session, "subscribeCommits">): void {
    harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        const data = change.type === "entry" && change.value.kind === TOOL_COST ? (change.value.data as Partial<Booked> | undefined) : undefined;
        if (data?.tool === "browser" && typeof data.tag === "string") booked(data as Booked);
      }
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
        const ranS = [...sessions.values()].filter((s) => s.cid === api.conversationId).reduce((sum, s) => sum + Math.max(0, now - s.at) / 1000, 0);
        // Up to the millionth of a dollar, so the cap's words name a figure never below the hold.
        const usd = Math.ceil(Math.round((usdOf(ranS) + 2 * stretch) * 1e12) / 1e6) / 1e6;
        const basis = `${provider}'s session time at $${rate} an hour: the ${Math.round(ranS)} s its session ran since its last charge, and twice the next stretch of ${stretchS} s (its ${price.minimumS} s minimum, the ${idleS} s idle window and ${RELEASE_ALLOWANCE_S} s for its release)`;
        const paid = await paidCall("This browser call", async () => keepHold(usd), () => undefined, { usd, basis });
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

  /** The cap's refusal as the call's error, and the conversation's session let go, so it runs no longer. */
  async function refuse(why: string, api: ToolExecutionApi, context: Context) {
    await release({ id: api.conversationId, commit: api.commit.bind(api) } as never, context).catch(() => undefined);
    return forModel(JSON.stringify({ error: why }), { isError: true });
  }

  return { onCharge, watch, kept, capped, stretch };
}
