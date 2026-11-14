// A claimed run's monid endpoints on the runner: one host tool per endpoint its revision's pin holds (monid.ts MonidPin,
// made at the save), under its wire name (catalog.ts wireName), with the pinned description and input. A spec builder
// joins them to the claim's MCP (mcp-run.ts ClaimMcp, withMonid), the loop's one seam for a catalog's tools: the loop
// hands them to every harness as it hands every host tool, asks the gate about a call by its catalog name
// (`monid:<provider>/<endpoint>`, catalogOf), and shows the pinned price on its card (priceOf).
// A call is a paid step on the run's one ledger (paid-calls.ts paidStep, the ledger the loop's bookedIn sets around it),
// named by its catalog name: held at the pinned price (or the usage ceiling), refused unsent when that does not fit the
// cap, and settled at what monid says it charged. With no run's ledger to book it on, it is never sent. Its key is the
// claim's (claim-secrets.ts: a run that grants a monid endpoint, and no other, is handed MONID_API_KEY), read at the call
// and sent to monid alone: never in the tool's input, its answer, or the run's computer.
import type { HostTool } from "@parcha/agentrun-kernel";
import { wireName } from "../catalog.js";
import { fauxFetch } from "../decisions.js";
import { chargeOf, FAUX_MONID_ENV, MONID_KEY_ENV, MONID_USAGE_CEILING_USD, type MonidAnswer, monidClient, type MonidPin, monidText } from "../monid.js";
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
    const basis = pinned.usage
      ? `monid prices ${name} by usage, so a call counts at the $${MONID_USAGE_CEILING_USD} ceiling until monid says what it charged`
      : "the price monid listed for it when the agent was saved";
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
        const client = monidClient({ key: env[MONID_KEY_ENV] ?? "", ...(faux ? { fetch: faux } : {}) });
        const paid = await paidStep<MonidAnswer>(ledger, context.callId, { name, holdUsd: pinned.usd, basis, by: "monid" }, () => client.run({ provider: at.provider, endpoint: `/${at.endpoint}`, input: (args ?? {}) as Json }, context.signal), (outcome) => {
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
    // Its card shows what the call is held at: the pinned price, or the usage ceiling.
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
