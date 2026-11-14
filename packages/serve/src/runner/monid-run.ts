// A claimed run's monid endpoints on the runner: one host tool per endpoint its revision's pin holds (monid.ts MonidPin,
// made at the save), under its wire name (catalog.ts wireName), with the pinned description and input. A spec builder
// joins them to the claim's MCP (mcp-run.ts ClaimMcp, withMonid), the loop's one seam for a catalog's tools: the loop
// hands them to every harness as it hands every host tool, asks the gate about a call by its catalog name
// (`monid:<provider>/<endpoint>`, catalogOf), and shows what a call is held at on its card (priceOf): its pinned price,
// or for an endpoint priced by usage monid's estimate for the call's own input ({estimate_usd}).
// A call is a paid step on the run's one ledger (paid-calls.ts paidStep, the ledger the loop's bookedIn sets around it),
// named by its catalog name, held before it is sent: a fixed-price endpoint at its pinned price (its price read again
// once the cap lets it go, an inspect monid does not charge: fixedThenRun), one priced by usage at monid's estimate for
// its input (usageHeld, estimated: the call sent with maxCost 0, which monid refuses unrun and uncharged, naming the
// estimate). It is refused unsent when its hold does not fit the cap, sent with that hold as monid's maxCost (so monid
// refuses it unrun if it estimates it higher), and settled at what monid says it charged. maxCost checks only monid's
// estimate: a charge above the hold (a call priced by usage that used more, or one monid re-priced by usage since the
// save or between the read and the run) is booked as charged,
// logged, and stops the run at once in words naming both (stopRun). With no run's ledger to book it on, it is never
// sent. Its key is the claim's (claim-secrets.ts: a run that grants a monid endpoint, and no other, is handed
// MONID_API_KEY), read at the call and sent to monid alone: never in the tool's input, its answer, or the run's computer.
import type { HostTool } from "@parcha/agentrun-kernel";
import { wireName } from "../catalog.js";
import { fauxFetch } from "../decisions.js";
import { chargeOf, estimateOf, FAUX_MONID_ENV, MONID_KEY_ENV, type MonidAnswer, monidClient, type MonidPin, monidText, uncharged } from "../monid.js";
import { money } from "../cap.js";
import { type PaidBooking, paidLedger, paidStep, stopRun, unbookedRefusal } from "../paid-calls.js";
import { monidNameOf, parseToolName } from "../tool-names.js";
import type { Json } from "../validate.js";
import type { Workspace } from "../workspace/index.js";
import type { ClaimMcp } from "./mcp-run.js";

/** The run's monid endpoints, as the loop's catalog seam reads them; `release` cuts off every estimate read still out. */
export type ClaimMonid = Pick<ClaimMcp, "tools" | "catalogOf" | "priceOf" | "release">;

/** One host tool per endpoint of `pin`, on the claim's environment `env` (its key, and the tests' fake under faux), an
 *  answer too long for the model filed in `work()`; undefined when the pin holds none. `runId` names the run in the log. */
export function monidForClaim(pin: MonidPin | undefined, env: NodeJS.ProcessEnv, work: () => Workspace, runId?: string): ClaimMonid | undefined {
  const names = Object.keys(pin ?? {});
  if (!pin || !names.length) return undefined;
  const catalog = new Map<string, string>();
  const clientOf = async () => {
    const faux = await fauxFetch(env, FAUX_MONID_ENV);
    return monidClient({ key: env[MONID_KEY_ENV] ?? "", ...(faux ? { fetch: faux } : {}) });
  };
  // monid's estimate for a call priced by usage, by the call's id: read for its card, then kept for its hold; read again
  // when its input is not the one it was read for, or when its read failed. Every read still out ends with `signal` (the
  // run's stop, the call's own) or the claim's release (`released`), which forgets them all.
  const estimates = new Map<string, { input: string; read: Promise<Estimated> }>();
  let released = new AbortController();
  const estimated = (callId: string, at: Endpoint, input: Json, signal?: AbortSignal): Promise<Estimated> => {
    const key = JSON.stringify(input);
    const kept = estimates.get(callId);
    if (kept?.input === key) return kept.read;
    const until = signal ? AbortSignal.any([signal, released.signal]) : released.signal;
    const read = clientOf().then((client) => client.run({ provider: at.provider, endpoint: `/${at.endpoint}`, input, maxCost: 0 }, until)).then((answer): Estimated => {
      const usd = estimateOf(answer);
      return usd === undefined ? { answer } : { usd };
    });
    estimates.set(callId, { input: key, read });
    const forget = () => {
      if (estimates.get(callId)?.read === read) estimates.delete(callId);
    };
    // Kept only when it gave an estimate or monid ran the call; a read cut off or refused is read again by the next asker.
    read.then((got) => {
      if (until.aborted || ("answer" in got && chargeOf(got.answer) === undefined)) forget();
    }, forget);
    return read;
  };
  /** A call of the fixed-price endpoint `at` (`name`) with `input`, held at its pinned `usd`: its price read again first
   *  (an inspect monid does not charge; one whose price cannot be read is not sent), then sent with that pinned price as
   *  maxCost, so monid refuses it unrun when it now estimates it higher, whether monid has raised its price or moved it
   *  to usage pricing since the save. */
  const fixedThenRun = async (name: string, at: Endpoint, input: Json, usd: number, signal: AbortSignal): Promise<MonidAnswer> => {
    const client = await clientOf();
    const now = await client.inspect({ provider: at.provider, endpoint: `/${at.endpoint}` }, signal);
    if (now.error !== undefined) return uncharged({ error: `${name} was not sent: monid's price for it could not be read before the call (${String(now.error)}).` });
    return client.run({ provider: at.provider, endpoint: `/${at.endpoint}`, input, maxCost: usd }, signal);
  };
  /** What the call `callId` of the endpoint `at` priced by usage with `input` is held at, and why: monid's estimate for
   *  its input. Or the call's answer when it is not sent: its estimate could not be read, or monid refused its
   *  estimate's read unrun (its input, the key, the wallet). A read monid ran instead (an estimate of $0, a free run,
   *  which maxCost 0 lets through) is the call itself (`ran`), held at $0. */
  const usageHeld = async (at: Endpoint, input: Json, callId: string, signal: AbortSignal): Promise<Held | { answer: MonidAnswer }> => {
    const read = await estimated(callId, at, input, signal);
    if ("usd" in read) return { usd: read.usd, basis: "monid's estimate for this call's input (priced by usage: its charge can pass it)" };
    // Not sent; or run, and booked already by its card's read (priceOf): its answer is the call's.
    if (read.booked || chargeOf(read.answer) === undefined) return { answer: read.answer };
    return { usd: 0, basis: RAN_BASIS, ran: read.answer };
  };
  /** One paid step for the call `callId` of `name` on the run's ledger `ledger`: held at `held.usd`, `send` run, settled at
   *  what monid says it charged. maxCost checks only monid's estimate, so a charge above the hold is booked as charged,
   *  logged, and stops the run at once in words naming both (stopRun). */
  const paidCall = async (ledger: PaidBooking, callId: string, name: string, held: { usd: number; basis: string }, send: () => Promise<MonidAnswer>) => {
    const paid = await paidStep<MonidAnswer>(ledger, callId, { name, holdUsd: held.usd, basis: held.basis, by: "monid" }, send, (outcome) => {
      if (!("result" in outcome)) return null;
      const usd = chargeOf(outcome.result);
      return usd === undefined ? 0 : usd;
    });
    if ("refused" in paid) return paid;
    const charged = chargeOf(paid.result);
    if (typeof charged === "number" && Math.round(charged * 1e6) > Math.round(held.usd * 1e6)) {
      const words = `monid charged ${money(charged)}, more than the ${money(held.usd)} held; the run stopped`;
      console.error(`[runner] run ${runId ?? "(unnamed)"}: ${name}: ${words}`);
      await stopRun(words);
    }
    return paid;
  };
  const tools: HostTool[] = names.flatMap((name) => {
    const at = monidNameOf(name);
    if (!at) return [];
    const pinned = pin[name]!;
    const wire = wireName(name);
    catalog.set(wire, name);
    return [{
      name: wire,
      description: pinned.description,
      inputSchema: pinned.input as Record<string, unknown>,
      // Never sent twice: a call a crash cut off is answered interrupted, never run again.
      replay: "never" as const,
      call: async (args, context) => {
        const ledger = paidLedger();
        if (!ledger) return { text: JSON.stringify({ error: unbookedRefusal(name) }), isError: true };
        const input = (args ?? {}) as Json;
        // A fixed price is held as pinned, the cap asked before monid is; one priced by usage at monid's estimate.
        const fixedUsd = pinned.usd;
        const held = fixedUsd !== null ? { usd: fixedUsd, basis: "the price monid listed for it when the agent was saved" } : await usageHeld(at, input, context.callId, context.signal);
        estimates.delete(context.callId);
        if ("answer" in held) return { text: await monidText(held.answer, work(), at.provider), ...(held.answer.error !== undefined ? { isError: true } : {}) };
        // Sent with its hold as maxCost: monid refuses it unrun when it estimates it higher.
        const send = async () => (fixedUsd !== null ? fixedThenRun(name, at, input, fixedUsd, context.signal) : (held.ran ?? (await clientOf()).run({ provider: at.provider, endpoint: `/${at.endpoint}`, input, maxCost: held.usd }, context.signal)));
        const paid = await paidCall(ledger, context.callId, name, held, send);
        if ("refused" in paid) return { text: JSON.stringify({ error: paid.refused }), isError: true };
        return { text: await monidText(paid.result, work(), at.provider), ...(paid.result.error !== undefined ? { isError: true } : {}) };
      },
    } satisfies HostTool];
  });
  return {
    tools,
    catalogOf: (tool) => catalog.get(tool),
    // Its card shows what the call is held at: its pinned price (the most monid may estimate it at and still run it), or
    // for one priced by usage monid's estimate for its input, read when the card is made (none when that cannot be read).
    // A read monid ran (an estimate of $0, a free run maxCost 0 lets through) is booked here, under the call on the run's
    // ledger the card is read in, so its charge is never lost however the card is answered: above $0 it stops the run.
    priceOf: (name, call) => {
      if (!Object.hasOwn(pin, name)) return undefined;
      const usd = pin[name]!.usd;
      const at = monidNameOf(name);
      if (usd !== null || !at || !call) return usd ?? undefined;
      return estimated(call.callId, at, (call.args ?? {}) as Json, call.signal).then(async (read) => {
        if ("usd" in read) return { estimate_usd: read.usd };
        if (chargeOf(read.answer) === undefined) return undefined;
        const ledger = paidLedger();
        if (ledger && !read.booked) {
          read.booked = true;
          await paidCall(ledger, call.callId, name, { usd: 0, basis: RAN_BASIS }, async () => read.answer);
        }
        return { estimate_usd: 0 };
      });
    },
    release: () => {
      released.abort(new Error("the claim let its monid endpoints go"));
      released = new AbortController();
      estimates.clear();
    },
  };
}

type Endpoint = { provider: string; endpoint: string };
/** monid's estimate for a call priced by usage, in USD; or its answer when monid gave none (refused unrun, or ran it:
 *  `booked` once its card's read booked that run). */
type Estimated = { usd: number } | { answer: MonidAnswer; booked?: boolean };
/** The cap's basis for a call monid ran when asked for its estimate. */
const RAN_BASIS = "monid's estimate for this call's input, $0: monid ran it when asked for that estimate";
/** What a call is held at, why (the cap's basis), and the call's answer when the read of its estimate ran it. */
type Held = { usd: number; basis: string; ran?: MonidAnswer };

/** The claim's MCP with the run's monid endpoints beside it: the one catalog seam the loop reads (AdapterRunSpec.mcp).
 *  Its credentials' hooks are MCP's alone, and so is the closure of a pinned tool's arguments (argumentsOf: the gate's
 *  settings pins are on MCP tools; a monid endpoint's input is held to its pinned schema by the harness), and so is each
 *  tool's effect (effectOf: Allow reads and the destructive confirm read an MCP tool's annotations; an endpoint has none). */
export function withMonid(mcp: ClaimMcp | undefined, monid: ClaimMonid | undefined): ClaimMcp | undefined {
  if (!monid) return mcp;
  return {
    tools: [...(mcp?.tools ?? []), ...monid.tools],
    catalogOf: (tool) => mcp?.catalogOf(tool) ?? monid.catalogOf(tool),
    argumentsOf: (name) => mcp?.argumentsOf(name),
    effectOf: (name) => mcp?.effectOf(name),
    priceOf: (name, call) => mcp?.priceOf(name, call) ?? monid.priceOf(name, call),
    fresh: async () => mcp?.fresh(),
    release: () => {
      mcp?.release();
      monid.release();
    },
  };
}

/** What a subagent may be given for the grant `grant` (subagent.ts sessionNames): for a provider's wildcard, every endpoint
 *  the revision's `pin` holds of that provider, by wire name; undefined for any other grant. */
export function monidSessionNames(grant: string, pin: MonidPin | undefined): string[] | undefined {
  const parsed = parseToolName(grant);
  if (parsed?.kind !== "monid-provider") return undefined;
  return Object.keys(pin ?? {}).filter((tool) => monidNameOf(tool)?.provider === parsed.provider).map(wireName);
}
