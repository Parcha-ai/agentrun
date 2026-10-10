import { gatewayIntentOf, type InheritedReceipt, type InheritedUnknown } from "@parcha/agentrun-dsl/recovery";

// Not buying an effect twice, structurally. A pi hook cannot answer a call without executing it, so a continuation that
// inherits paid receipts wraps each paid tool: a call whose tool and argument hash match an inherited receipt is answered
// from it and says so; one that matches an inherited unknown is refused. The wrapper needs no pi import: it decorates
// anything with a name and an `execute`, so a host applies it through pi-durable's `wrapTool` or to its own tools.

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details?: Record<string, unknown> };
/** The part of a durable tool the wrapper reads and replaces. */
export type ReusableTool = { name: string; execute: (args: any, ...rest: any[]) => Promise<unknown> };

export type ReuseReceiptsOptions = {
  /** What the journal handed over: `handoff.receipts` and `handoff.unknown`. */
  receipts: readonly InheritedReceipt[];
  unknown?: readonly InheritedUnknown[];
  /** The tools whose calls are paid. A tool not named here is never answered or refused. */
  tools: readonly string[];
  /** How a call's key is derived. Default: the gateway tool a `fetch` wrapper names, else the tool's own name. */
  keyOf?: (toolName: string, args: unknown) => { tool: string; argsHash: string };
};

export type ReceiptReuse = {
  /** The tool with its `execute` wrapped. A tool the host did not name as paid is returned as it is. */
  wrap<T extends ReusableTool>(tool: T): T;
  /** Calls answered from a receipt and calls refused as unknown, so far. */
  readonly stats: { reused: number; refused: number };
};

export function reuseReceipts(options: ReuseReceiptsOptions): ReceiptReuse {
  const keyOf = options.keyOf ?? gatewayIntentOf;
  const held = new Map<string, InheritedReceipt>();
  for (const receipt of options.receipts) if (!held.has(`${receipt.tool}:${receipt.argsHash}`)) held.set(`${receipt.tool}:${receipt.argsHash}`, receipt);
  // An unknown is matched by the name and hash its admission recorded, and by the external call it was admitted for.
  const unknown = new Set((options.unknown ?? []).flatMap((u) => [`${u.name}\n${u.argsHash}`, ...(u.intent ? [`${u.intent.tool}\n${u.intent.argsHash}`] : [])]));
  const paid = new Set(options.tools);
  const stats = { reused: 0, refused: 0 };
  return {
    stats,
    wrap: <T extends ReusableTool>(tool: T): T => !paid.has(tool.name) ? tool : {
      ...tool,
      execute: async (args: unknown, ...rest: unknown[]) => {
        const intent = keyOf(tool.name, args);
        if (unknown.has(`${intent.tool}\n${intent.argsHash}`) || unknown.has(`${tool.name}\n${intent.argsHash}`)) {
          stats.refused += 1;
          return { isError: true, content: [{ type: "text", text: `${tool.name} is not called again: an identical earlier call was cut while it ran, so what it did outside is unknown. Work from what you have, or make a different call.` }],
            details: { effect_status: "unknown", refused: true } } satisfies ToolResult;
        }
        const receipt = held.get(`${intent.tool}:${intent.argsHash}`);
        if (receipt && receipt.result !== null && receipt.result !== undefined) {
          stats.reused += 1;
          const text = typeof receipt.result === "string" ? receipt.result : JSON.stringify(receipt.result);
          return { content: [{ type: "text", text: `${text}\n\n(answered from the paid receipt of ${receipt.session}; the call was not dispatched again)` }],
            details: { effect_status: "reused", source_session: receipt.session } } satisfies ToolResult;
        }
        return tool.execute(args, ...rest);
      },
    },
  };
}
