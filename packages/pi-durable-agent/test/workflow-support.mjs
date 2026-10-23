import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceFiles } from "@parcha/agentrun-dsl/recovery";
import { createWorkflowExtension } from "@parcha/agentrun-pi/durable";

export { ctx };

/**
 * A workflow with no code and no model: `stock` asks one tool for the item's tier, `by tier` routes on that value to one
 * of two quote tools, and with `gate` an escalation fires at `too big` once `amount` reaches 500, after `stock` ran.
 */
export function workflowDoc({ gate = false } = {}) {
  const quote = (label, tool) => ({ node: "call", label, via: "tool", tool, args: { sku: "{sku}" }, out: "Quote", as: "quote", deadline_s: 20 });
  return {
    v: 2, name: "stock-and-quote",
    schemas: {
      In: {
        type: "object", additionalProperties: false, required: ["sku", "amount"],
        properties: { sku: { type: "string" }, amount: { type: "number", minimum: 0, maximum: 1000 } },
      },
      Stock: { type: "object", required: ["tier"], properties: { tier: { enum: ["fast", "slow"] } } },
      Quote: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Quote", path: "quote" },
    root: {
      node: "chain",
      steps: [
        { node: "call", label: "stock", via: "tool", tool: "stock.check", args: { sku: "{sku}" }, out: "Stock", as: "stock", deadline_s: 20 },
        ...(gate ? [{ node: "escalate", label: "too big", when: { predicate: "gte", path: "amount", n: 500 }, kind: "review", stage: "gate", summary: "needs a person" }] : []),
        { node: "route", label: "by tier", valuePath: "stock.tier", branches: { fast: { body: quote("quote fast", "prices.quote") }, slow: { body: quote("quote slow", "prices.slow_quote") } } },
      ],
    },
  };
}

export const TOOLS = ["stock.check", "prices.quote", "prices.slow_quote"];

/** A workflow revision's body, as a store holds it. */
export const bodyOf = (workflow = workflowDoc()) => ({ workflow, skills: {}, tools: [...TOOLS] });

/** A run of an agent's workflow revision, in the shape `startRun` gives one, on a fresh store file. */
export async function runOf({ body = bodyOf(), revision = "rev-a", runId = "run-1", agentId = "agent-1" } = {}) {
  // Loaded here, not at the top: support.mjs registers test hooks, and a child process that runs a host loads this module.
  const root = await (await import("./support.mjs")).scratch();
  await mkdir(path.join(root, "store"));
  await mkdir(path.join(root, "work"));
  return { runId, dir: root, storePath: path.join(root, "store", "run.sqlite"), workspace: path.join(root, "work"), agentId, revision: { id: revision, kind: "workflow", body } };
}

/**
 * The host's part for a run: the DSL's workflow extension with fake tools that count their calls, on a Harness open on
 * the run's store file. `onCall(tool, count)` runs after a tool answers, before its result is committed; the tool `fail`
 * names throws instead.
 */
export async function hostFor(run, { tier = "fast", onCall, fail } = {}) {
  const calls = {};
  const answers = { "stock.check": () => ({ tier }), "prices.quote": () => ({ price: 21 }), "prices.slow_quote": () => ({ price: 34 }) };
  const workflows = createWorkflowExtension({
    options: () => ({ files: workspaceFiles(run.workspace) }),
    run: () => ({
      adapters: {
        runEffect: async ({ node }) => {
          calls[node.tool] = (calls[node.tool] ?? 0) + 1;
          if (node.tool === fail) throw new Error("the tool is down");
          const answer = answers[node.tool]();
          await onCall?.(node.tool, calls[node.tool]);
          return answer;
        },
      },
    }),
  });
  const registry = createRegistry();
  registry.install(workflows.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { registry, models: {} }, ctx);
  return { harness, workflows, calls, close: () => harness.close(ctx) };
}
