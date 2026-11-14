// A claimed run's monid endpoints on the runner: one host tool per endpoint its revision's pin holds (monid.ts MonidPin,
// made at the save), under its wire name (catalog.ts wireName), with the pinned description and input. A spec builder
// joins them to the claim's MCP (mcp-run.ts ClaimMcp, withMonid), the loop's one seam for a catalog's tools: the loop
// hands them to every harness as it hands every host tool, asks the gate about a call by its catalog name
// (`monid:<provider>/<endpoint>`, catalogOf), and shows what a call is held at on its card (priceOf): its pinned price,
// or for an endpoint priced by usage monid's estimate for the call's own input ({estimate_usd}).
// A call is a paid step on the run's one ledger (paid-calls.ts paidStep, the ledger the loop's bookedIn sets around it),
// named by its catalog name, held before it is sent (heldFor): at its pinned price while monid still fixes it (its
// price read again first, an inspect monid does not charge), else at monid's estimate for its input (estimated: the
// call sent with maxCost 0, which monid refuses unrun and uncharged, naming the estimate). It is refused unsent when its
// hold does not fit the cap, sent with that hold as monid's maxCost (so monid refuses it unrun if it estimates it
// higher), and settled at what monid says it charged. maxCost checks only monid's estimate: a charge above the hold (a
// call priced by usage that used more, or one monid re-priced between the read and the run) is booked as charged,
// logged, and stops the run at once in words naming both (stopRun). With no run's ledger to book it on, it is never
// sent. Its key is the claim's (claim-secrets.ts: a run that grants a monid endpoint, and no other, is handed
// MONID_API_KEY), read at the call and sent to monid alone: never in the tool's input, its answer, or the run's computer.
import type { HostTool } from "@parcha/agentrun-kernel";
import { wireName } from "../catalog.js";
import { fauxFetch } from "../decisions.js";
import { chargeOf, estimateOf, FAUX_MONID_ENV, heldOf, MONID_KEY_ENV, type MonidAnswer, monidClient, type MonidPin, monidText, uncharged } from "../monid.js";
import { money } from "../cap.js";
import { paidLedger, paidStep, stopRun, unbookedRefusal } from "../paid-calls.js";
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
  // monid's estimate for a call priced by usage, by the call's id: read for its card, then kept for its hold; read again
  // when its input is not the one it was read for.
  const estimates = new Map<string, { input: string; read: Promise<Estimated> }>();
  const estimated = (callId: string, at: Endpoint, input: Json, signal?: AbortSignal): Promise<Estimated> => {
    const key = JSON.stringify(input);
    const kept = estimates.get(callId);
    if (kept?.input === key) return kept.read;
    const read = clientOf().then((client) => client.run({ provider: at.provider, endpoint: `/${at.endpoint}`, input, maxCost: 0 }, signal)).then((answer): Estimated => {
      const usd = estimateOf(answer);
      return usd === undefined ? { answer } : { usd };
    });
    estimates.set(callId, { input: key, read });
    return read;
  };
  /** What the call `callId` of the endpoint `at` (`name`, pinned at `pinnedUsd`) with `input` is held at, and why: its
   *  pinned price while monid still fixes it (read again, an inspect monid does not charge); else monid's estimate for
   *  its input. Or the call's answer when it is not sent: its price or its estimate could not be read, or monid refused
   *  its estimate's read unrun (its input, the key, the wallet). A read monid ran instead (an estimate of $0, a free run,
   *  which maxCost 0 lets through) is the call itself (`ran`), held at $0. */
  const heldFor = async (name: string, at: Endpoint, pinnedUsd: number | null, input: Json, callId: string, signal: AbortSignal): Promise<Held | { answer: MonidAnswer }> => {
    if (pinnedUsd !== null) {
      const now = await (await clientOf()).inspect({ provider: at.provider, endpoint: `/${at.endpoint}` }, signal);
      if (now.error !== undefined) return { answer: uncharged({ error: `${name} was not sent: monid's price for it could not be read before the call (${String(now.error)}).` }) };
      if (heldOf(now.price) !== undefined) return { usd: pinnedUsd, basis: "the price monid listed for it when the agent was saved" };
    }
    const read = await estimated(callId, at, input, signal);
    if ("usd" in read) return { usd: read.usd, basis: "monid's estimate for this call's input (priced by usage: its charge can pass it)" };
    if (chargeOf(read.answer) === undefined) return { answer: read.answer };
    return { usd: 0, basis: "monid's estimate for this call's input, $0: monid ran it when asked for that estimate", ran: read.answer };
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
        const held = await heldFor(name, at, pinned.usd, input, context.callId, context.signal);
        estimates.delete(context.callId);
        if ("answer" in held) return { text: await monidText(held.answer, work(), at.provider), ...(held.answer.error !== undefined ? { isError: true } : {}) };
        const client = await clientOf();
        // Sent with its hold as maxCost: monid refuses it unrun when it estimates it higher.
        const send = () => (held.ran ? Promise.resolve(held.ran) : client.run({ provider: at.provider, endpoint: `/${at.endpoint}`, input, maxCost: held.usd }, context.signal));
        const paid = await paidStep<MonidAnswer>(ledger, context.callId, { name, holdUsd: held.usd, basis: held.basis, by: "monid" }, send, (outcome) => {
          if (!("result" in outcome)) return null;
          const usd = chargeOf(outcome.result);
          return usd === undefined ? 0 : usd;
        });
        if ("refused" in paid) return { text: JSON.stringify({ error: paid.refused }), isError: true };
        const charged = chargeOf(paid.result);
        if (typeof charged === "number" && Math.round(charged * 1e6) > Math.round(held.usd * 1e6)) {
          const words = `monid charged ${money(charged)}, more than the ${money(held.usd)} held; the run stopped`;
          console.error(`[runner] run ${runId ?? "(unnamed)"}: ${name}: ${words}`);
          await stopRun(words);
        }
        return { text: await monidText(paid.result, work(), at.provider), ...(paid.result.error !== undefined ? { isError: true } : {}) };
      },
    } satisfies HostTool];
  });
  return {
    tools,
    catalogOf: (tool) => catalog.get(tool),
    // Its card shows what the call is held at: its pinned price, or for one priced by usage monid's estimate for its
    // input (none when that cannot be read).
    priceOf: (name, call) => {
      if (!Object.hasOwn(pin, name)) return undefined;
      const usd = pin[name]!.usd;
      const at = monidNameOf(name);
      if (usd !== null || !at || !call) return usd ?? undefined;
      return estimated(call.callId, at, (call.args ?? {}) as Json).then((read) => ("usd" in read ? { estimate_usd: read.usd } : undefined));
    },
  };
}

type Endpoint = { provider: string; endpoint: string };
/** monid's estimate for a call priced by usage, in USD; or its answer when monid gave none (refused unrun, or ran it). */
type Estimated = { usd: number } | { answer: MonidAnswer };
/** What a call is held at, why (the cap's basis), and the call's answer when the read of its estimate ran it. */
type Held = { usd: number; basis: string; ran?: MonidAnswer };

/** The claim's MCP with the run's monid endpoints beside it: the one catalog seam the loop reads (AdapterRunSpec.mcp).
 *  Its credentials' hooks are MCP's alone, and so is the closure of a pinned tool's arguments (argumentsOf: the gate's
 *  settings pins are on MCP tools; a monid endpoint's input is held to its pinned schema by the harness). */
export function withMonid(mcp: ClaimMcp | undefined, monid: ClaimMonid | undefined): ClaimMcp | undefined {
  if (!monid) return mcp;
  return {
    tools: [...(mcp?.tools ?? []), ...monid.tools],
    catalogOf: (tool) => mcp?.catalogOf(tool) ?? monid.catalogOf(tool),
    argumentsOf: (name) => mcp?.argumentsOf(name),
    priceOf: (name, call) => mcp?.priceOf(name, call) ?? monid.priceOf(name, call),
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
