// A claimed run's monid endpoints on the runner: one host tool per endpoint its revision's pin holds (monid.ts MonidPin,
// made at the save), under its wire name (catalog.ts wireName), with the pinned description and input. A spec builder
// joins them to the claim's MCP (mcp-run.ts ClaimMcp, withMonid), the loop's one seam for a catalog's tools: the loop
// hands them to every harness as it hands every host tool, asks the gate about a call by its catalog name
// (`monid:<provider>/<endpoint>`, catalogOf), and shows the pinned price on its card (priceOf).
// A call is a paid step on the run's one ledger (paid-calls.ts paidStep, the ledger the loop's bookedIn sets around it),
// named by its catalog name: held at the pinned price (a fixed one: the save pins no endpoint priced by usage), refused
// unsent when that does not fit the cap, then its price read again from monid and the call answered uncharged, unsent,
// unless monid still fixes it (fixedThenRun: one re-priced by usage since the save would pass any maxCost), sent with
// that hold as monid's maxCost (so monid refuses it unrun if it now prices it higher), and settled at what monid says it charged. maxCost
// checks only monid's estimate: a charge above the hold (monid re-priced it between the read and the run) is booked as
// charged, logged, and stops the run at once in words naming both (stopRun). With no run's ledger to book it on, it is never sent. Its key is the
// claim's (claim-secrets.ts: a run that grants a monid endpoint, and no other, is handed MONID_API_KEY), read at the call
// and sent to monid alone: never in the tool's input, its answer, or the run's computer.
import type { HostTool } from "@parcha/agentrun-kernel";
import { wireName } from "../catalog.js";
import { fauxFetch } from "../decisions.js";
import { chargeOf, FAUX_MONID_ENV, heldOf, MONID_KEY_ENV, type MonidAnswer, monidClient, type MonidPin, monidText, priceWords, uncharged } from "../monid.js";
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
        const client = monidClient({ key: env[MONID_KEY_ENV] ?? "", ...(faux ? { fetch: faux } : {}) });
        const paid = await paidStep<MonidAnswer>(ledger, context.callId, { name, holdUsd: pinned.usd, basis, by: "monid" }, () => fixedThenRun(client, at, (args ?? {}) as Json, name, pinned.usd, context.signal), (outcome) => {
          if (!("result" in outcome)) return null;
          const usd = chargeOf(outcome.result);
          return usd === undefined ? 0 : usd;
        });
        if ("refused" in paid) return { text: JSON.stringify({ error: paid.refused }), isError: true };
        const charged = chargeOf(paid.result);
        if (typeof charged === "number" && Math.round(charged * 1e6) > Math.round(pinned.usd * 1e6)) {
          const words = `monid charged ${money(charged)}, more than the ${money(pinned.usd)} held; the run stopped`;
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
    // Its card shows what the call is held at: the pinned price.
    priceOf: (name) => (Object.hasOwn(pin, name) ? pin[name]!.usd : undefined),
  };
}

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

/** One call of the endpoint `at` (`tool`, pinned at `usd`), sent with `usd` as monid's maxCost only once its price is read
 *  again and is still a fixed one. maxCost bounds only monid's estimate, so an endpoint monid has re-priced by usage since
 *  the save could pass it and be charged past it: that call, and one whose price cannot be read, is answered uncharged,
 *  never sent. An inspect costs nothing; one priced above the pin, monid refuses unrun at maxCost. monid's words reach
 *  the model as a run's error does: through the runner's one redactor. */
async function fixedThenRun(client: ReturnType<typeof monidClient>, at: { provider: string; endpoint: string }, input: Json, tool: string, usd: number, signal: AbortSignal): Promise<MonidAnswer> {
  const now = await client.inspect({ provider: at.provider, endpoint: `/${at.endpoint}` }, signal);
  if (now.error !== undefined) return uncharged({ error: `${tool} was not sent: monid's price for it could not be read before the call (${String(now.error)}), and a call is sent only at a price monid still fixes.` });
  if (heldOf(now.price) === undefined) return uncharged({ error: `${tool} was not sent: monid now prices it ${priceWords(now.price)}, not the fixed $${usd} pinned when the agent was saved, and monid does not bound what a call priced by usage is charged. A run's cap could not be kept.` });
  return client.run({ provider: at.provider, endpoint: `/${at.endpoint}`, input, maxCost: usd }, signal);
}

/** What a subagent may be given for the grant `grant` (subagent.ts sessionNames): for a provider's wildcard, every endpoint
 *  the revision's `pin` holds of that provider, by wire name; undefined for any other grant. */
export function monidSessionNames(grant: string, pin: MonidPin | undefined): string[] | undefined {
  const parsed = parseToolName(grant);
  if (parsed?.kind !== "monid-provider") return undefined;
  return Object.keys(pin ?? {}).filter((tool) => monidNameOf(tool)?.provider === parsed.provider).map(wireName);
}
