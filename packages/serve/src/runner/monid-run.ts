// A claimed run's monid endpoints on the runner: one host tool per endpoint its revision's pin holds (monid.ts MonidPin,
// made at the save), under its wire name (catalog.ts wireName), with the pinned description and input. A spec builder
// joins them to the claim's MCP (mcp-run.ts ClaimMcp, withMonid), the loop's one seam for a catalog's tools: the loop
// hands them to every harness as it hands every host tool, asks the gate about a call by its catalog name
// (`monid:<provider>/<endpoint>`, catalogOf), and shows its price on its card (priceOf): its pinned price, or for an
// endpoint priced by usage "priced by usage". A card reads nothing from monid: monid's estimate is read only once the call
// may run (after the person's allow, or at once when it needs none), since that read can run the call (below).
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
import { GIVEN_BACK, type PaidBooking, paidLedger, paidStep, stopRun, unbookedRefusal } from "../paid-calls.js";
import { monidNameOf, parseToolName } from "../tool-names.js";
import type { Json } from "../validate.js";
import type { Workspace } from "../workspace/index.js";
import type { ClaimMcp } from "./mcp-run.js";

/** The run's monid endpoints, as the loop's catalog seam reads them. */
export type ClaimMonid = Pick<ClaimMcp, "tools" | "catalogOf" | "priceOf">;

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
  /** Stops the run when monid charged `name`'s call more than the `heldUsd` it was held at: maxCost checks only monid's
   *  estimate, so such a charge is booked as charged (by its paid step), logged, and stops the run at once in words naming
   *  both (stopRun). */
  const overHold = async (name: string, charged: number | null | undefined, heldUsd: number): Promise<void> => {
    if (typeof charged !== "number" || Math.round(charged * 1e6) <= Math.round(heldUsd * 1e6)) return;
    const words = `monid charged ${money(charged)}, more than the ${money(heldUsd)} held; the run stopped`;
    console.error(`[runner] run ${runId ?? "(unnamed)"}: ${name}: ${words}`);
    await stopRun(words);
  };
  // monid's estimate for the call `callId` priced by usage, read once the call may run, on the run's ledger `ledger`:
  // the call sent with maxCost 0, which monid refuses unrun and uncharged, naming the estimate, or runs when it estimates
  // the call at $0 (a free run). So the read is a paid step of the call, marked at $0 before it is sent (a crash while
  // monid holds it leaves its possible charge on record, unknown), given back when monid refused it unrun, else settled
  // at what monid charged, a charge above $0 stopping the run.
  const estimated = async (ledger: PaidBooking, callId: string, name: string, at: Endpoint, input: Json, signal: AbortSignal): Promise<Estimated> => {
    const client = await clientOf();
    const step = await paidStep<MonidAnswer>(ledger, callId, { name, holdUsd: 0, basis: READ_BASIS, by: "monid" }, () => client.run({ provider: at.provider, endpoint: `/${at.endpoint}`, input, maxCost: 0 }, signal), (outcome) => {
      if (!("result" in outcome)) return null;
      const usd = chargeOf(outcome.result);
      return usd === undefined ? GIVEN_BACK : usd;
    });
    if ("refused" in step) return { answer: uncharged({ error: step.refused }) };
    const usd = estimateOf(step.result);
    if (usd !== undefined) return { usd };
    await overHold(name, chargeOf(step.result), 0);
    return { answer: step.result };
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
  /** What the call `callId` of the endpoint `at` (`name`) priced by usage with `input` is held at, and why: monid's
   *  estimate for its input. Or the call's answer when it is not sent again: its estimate could not be read, monid refused
   *  its estimate's read unrun (its input, the key, the wallet), or monid ran it at that read (an estimate of $0, a free
   *  run, which maxCost 0 lets through), booked there (estimated). */
  const usageHeld = async (ledger: PaidBooking, name: string, at: Endpoint, input: Json, callId: string, signal: AbortSignal): Promise<Held | { answer: MonidAnswer }> => {
    const read = await estimated(ledger, callId, name, at, input, signal);
    if ("usd" in read) return { usd: read.usd, basis: "monid's estimate for this call's input (priced by usage: its charge can pass it)" };
    return { answer: read.answer };
  };
  /** One paid step for the call `callId` of `name` on the run's ledger `ledger`: held at `held.usd`, `send` run, settled at
   *  what monid says it charged; a charge above the hold stops the run (overHold). */
  const paidCall = async (ledger: PaidBooking, callId: string, name: string, held: Held, send: () => Promise<MonidAnswer>) => {
    const paid = await paidStep<MonidAnswer>(ledger, callId, { name, holdUsd: held.usd, basis: held.basis, by: "monid" }, send, (outcome) => {
      if (!("result" in outcome)) return null;
      const usd = chargeOf(outcome.result);
      return usd === undefined ? 0 : usd;
    });
    if ("refused" in paid) return paid;
    await overHold(name, chargeOf(paid.result), held.usd);
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
        const held = fixedUsd !== null ? { usd: fixedUsd, basis: "the price monid listed for it when the agent was saved" } : await usageHeld(ledger, name, at, input, context.callId, context.signal);
        if ("answer" in held) return { text: await monidText(held.answer, work(), at.provider), ...(held.answer.error !== undefined ? { isError: true } : {}) };
        // Sent with its hold as maxCost: monid refuses it unrun when it estimates it higher.
        const send = async () => (fixedUsd !== null ? fixedThenRun(name, at, input, fixedUsd, context.signal) : (await clientOf()).run({ provider: at.provider, endpoint: `/${at.endpoint}`, input, maxCost: held.usd }, context.signal));
        const paid = await paidCall(ledger, context.callId, name, held, send);
        if ("refused" in paid) return { text: JSON.stringify({ error: paid.refused }), isError: true };
        return { text: await monidText(paid.result, work(), at.provider), ...(paid.result.error !== undefined ? { isError: true } : {}) };
      },
    } satisfies HostTool];
  });
  return {
    tools,
    catalogOf: (tool) => catalog.get(tool),
    // Its card shows its pinned price (the most monid may estimate it at and still run it), or for one priced by usage
    // "priced by usage": its estimate is never read for the card, since that read can run the call before the person
    // answers.
    priceOf: (name) => {
      if (!Object.hasOwn(pin, name)) return undefined;
      const usd = pin[name]!.usd;
      return usd === null ? "priced by usage" : usd;
    },
  };
}

type Endpoint = { provider: string; endpoint: string };
/** monid's estimate for a call priced by usage, in USD; or its answer when monid gave none (refused unrun, or ran it,
 *  booked by the read). */
type Estimated = { usd: number } | { answer: MonidAnswer };
/** The cap's basis for the read of a call's estimate: sent with maxCost 0, which monid runs only at an estimate of $0. */
const READ_BASIS = "monid's estimate for this call's input, read with maxCost 0: monid runs it only if it estimates it at $0";
/** What a call is held at, and why (the cap's basis). */
type Held = { usd: number; basis: string };

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
    priceOf: (name) => mcp?.priceOf(name) ?? monid.priceOf(name),
    fresh: async () => mcp?.fresh(),
    release: () => mcp?.release(),
  };
}

/** What a subagent may be given for the grant `grant` (subagent.ts sessionNames): for a provider's wildcard, every endpoint
 *  the revision's `pin` holds of that provider, by wire name; undefined for any other grant. */
export function monidSessionNames(grant: string, pin: MonidPin | undefined): string[] | undefined {
  const parsed = parseToolName(grant);
  if (parsed?.kind !== "monid-provider") return undefined;
  return Object.keys(pin ?? {}).filter((tool) => monidNameOf(tool)?.provider === parsed.provider).map(wireName);
}
