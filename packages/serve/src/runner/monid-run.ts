// A claimed run's monid endpoints on the runner: one host tool per endpoint its revision's pin holds (monid.ts MonidPin,
// made at the save), under its wire name (catalog.ts wireName), with the pinned description and input. A spec builder
// joins them to the claim's MCP (mcp-run.ts ClaimMcp, withMonid), the loop's one seam for a catalog's tools: the loop
// hands them to every harness as it hands every host tool, asks the gate about a call by its catalog name
// (`monid:<provider>/<endpoint>`, catalogOf), and shows the pinned price on its card (priceOf).
// A call is a paid step on the run's one ledger (paid-calls.ts paidStep, the ledger the loop's bookedIn sets around it),
// named by its catalog name: its price read again from monid first and the call refused unsent unless monid still fixes
// it (one re-priced by usage since the save would pass any maxCost), held at the pinned price (a fixed one: the save
// pins no endpoint priced by usage), refused unsent when that does not fit the cap, sent with that hold as monid's
// maxCost (so monid refuses it unrun if it now prices it higher), and settled at what monid says it charged. With no run's ledger to book it on, it is never sent. Its key is the
// claim's (claim-secrets.ts: a run that grants a monid endpoint, and no other, is handed MONID_API_KEY), read at the call
// and sent to monid alone: never in the tool's input, its answer, or the run's computer.
import type { HostTool } from "@parcha/agentrun-kernel";
import { wireName } from "../catalog.js";
import { fauxFetch } from "../decisions.js";
import { redacted } from "../key-refusal.js";
import { chargeOf, FAUX_MONID_ENV, heldOf, MONID_KEY_ENV, type MonidAnswer, monidClient, type MonidPin, monidText, priceWords } from "../monid.js";
import { paidLedger, paidStep, unbookedRefusal } from "../paid-calls.js";
import { monidNameOf, parseToolName } from "../tool-names.js";
import type { Json } from "../validate.js";
import type { Workspace } from "../workspace/index.js";
import type { ClaimMcp } from "./mcp-run.js";

/** The run's monid endpoints, as the loop's catalog seam reads them. */
export type ClaimMonid = Pick<ClaimMcp, "tools" | "catalogOf" | "priceOf">;

/** One host tool per endpoint of `pin`, on the claim's environment `env` (its key, and the tests' fake under faux), an
 *  answer too long for the model filed in `work()`; undefined when the pin holds none. */
export function monidForClaim(pin: MonidPin | undefined, env: NodeJS.ProcessEnv, work: () => Workspace): ClaimMonid | undefined {
  const names = Object.keys(pin ?? {});
  if (!pin || !names.length) return undefined;
  const catalog = new Map<string, string>();
  const tools: HostTool[] = names.flatMap((name) => {
    const at = monidNameOf(name);
    if (!at) return [];
    const pinned = pin[name]!;
    const wire = wireName(name);
    catalog.set(wire, name);
    const basis = "the price monid listed for it when the agent was saved";
    return [{
      name: wire,
      description: pinned.description,
      inputSchema: pinned.input as Record<string, unknown>,
      // Never sent twice: a call a crash cut off is answered interrupted, never run again.
      replay: "never" as const,
      call: async (args, context) => {
        const ledger = paidLedger();
        if (!ledger) return { text: JSON.stringify({ error: unbookedRefusal(name) }), isError: true };
        const faux = await fauxFetch(env, FAUX_MONID_ENV);
        const key = env[MONID_KEY_ENV] ?? "";
        const client = monidClient({ key, ...(faux ? { fetch: faux } : {}) });
        // The price is read again first (an inspect, which monid does not charge): maxCost bounds only monid's estimate,
        // so an endpoint monid has re-priced by usage since the save could pass the pinned maxCost and be charged past it.
        // A call is sent only while monid still prices it at a fixed price; one priced above the pin, monid refuses unrun.
        const now = await client.inspect({ provider: at.provider, endpoint: `/${at.endpoint}` }, context.signal);
        if (now.error !== undefined) return { text: JSON.stringify({ error: `${name} was not sent: monid's price for it could not be read before the call (${redacted(String(now.error), [key])}), and a call is sent only at a price monid still fixes.` }), isError: true };
        if (heldOf(now.price) === undefined) return { text: JSON.stringify({ error: `${name} was not sent: monid now prices it ${priceWords(now.price)}, not the fixed $${pinned.usd} pinned when the agent was saved, and monid does not bound what a call priced by usage is charged. A run's cap could not be kept.` }), isError: true };
        const paid = await paidStep<MonidAnswer>(ledger, context.callId, { name, holdUsd: pinned.usd, basis, by: "monid" }, () => client.run({ provider: at.provider, endpoint: `/${at.endpoint}`, input: (args ?? {}) as Json, maxCost: pinned.usd }, context.signal), (outcome) => {
          if (!("result" in outcome)) return null;
          const usd = chargeOf(outcome.result);
          return usd === undefined ? 0 : usd;
        });
        if ("refused" in paid) return { text: JSON.stringify({ error: paid.refused }), isError: true };
        return { text: await monidText(paid.result, work(), at.provider), ...(paid.result.error !== undefined ? { isError: true } : {}) };
      },
    } satisfies HostTool];
  });
  return {
    tools,
    catalogOf: (tool) => catalog.get(tool),
    // Its card shows what the call is held at: the pinned price.
    priceOf: (name) => (Object.hasOwn(pin, name) ? pin[name]!.usd : undefined),
  };
}

/** The claim's MCP with the run's monid endpoints beside it: the one catalog seam the loop reads (AdapterRunSpec.mcp).
 *  Its credentials' hooks are MCP's alone. */
export function withMonid(mcp: ClaimMcp | undefined, monid: ClaimMonid | undefined): ClaimMcp | undefined {
  if (!monid) return mcp;
  return {
    tools: [...(mcp?.tools ?? []), ...monid.tools],
    catalogOf: (tool) => mcp?.catalogOf(tool) ?? monid.catalogOf(tool),
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
