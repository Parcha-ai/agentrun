import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { gatewayIntentOf, returnedFailure, type InheritedReceipt, type InheritedUnknown } from "@parcha/agentrun-dsl/recovery";
import type { DocumentStoreHost } from "./store.js";

// Not buying an effect twice, structurally. A pi hook cannot answer a call without executing it, so a run that pays for
// external calls wraps each paid tool: the call's paid result is recorded in the run's receipts, a repeat of a call another
// session of the run paid for is answered from them and says so, and a call equal to an effect whose outcome is unknown
// is refused. A continuation seeds the receipts from the handoff before its first request. The wrapper needs no pi tool
// type: it decorates anything with a name and an `execute`, so a host applies it through pi-durable's `wrapTool` or to its
// own registrations.

/** The run's paid-effect receipts, one per external call (the tool and the hash of its arguments): what the call answered
 *  and which session paid for it. A record of spend, never a stop. Every session of the run is in the same Session, so a
 *  continuation reads its predecessor's receipts here, with no copy at the handoff beyond the seed. The kind, version and
 *  key are a stored format. */
export const ReceiptIndex = defineDocFamily<{ tool: string; argsHash: string; result: JsonValue | null; session: string | null }, null>({
  kind: "agentrun.receipts", version: 1, scope: "session", family: true, initial: () => ({ tool: "", argsHash: "", result: null, session: null }),
});

/** Put a journal's paid receipts into the run's receipts before a continuation's first request. A receipt already held
 *  is kept. A receipt with no session is the run `from` paid for. */
export async function seedReceipts(host: DocumentStoreHost, receipts: readonly Pick<InheritedReceipt, "tool" | "argsHash" | "result" | "session">[], from: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
  if (!receipts.length) return;
  await host.commit(async (tx) => {
    for (const receipt of receipts) {
      const held = await tx.doc(ReceiptIndex, `${receipt.tool}:${receipt.argsHash}`, null);
      if (held.result !== null) continue;
      held.tool = receipt.tool; held.argsHash = receipt.argsHash; held.session = receipt.session ?? from;
      held.result = (typeof receipt.result === "string" ? receipt.result : JSON.stringify(receipt.result ?? null)) as JsonValue;
    }
  }, context);
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details?: Record<string, unknown> };
/** The part of a durable tool the wrapper reads and replaces: `execute` gets the call's arguments, pi-durable's call api
 *  (`snapshot` and `commit` on the run's documents) and the call's context. */
export type ReusableTool = { name: string; execute: (args: any, api: any, context: any) => Promise<any> };

export type ReuseReceiptsOptions = {
  /** The tools whose calls are paid and keep a receipt: a tool whose answer is its own session's state keeps none. */
  tools: readonly string[];
  /** The session this wrapper runs in: it never answers a call from a receipt its own session wrote. */
  sessionId: string;
  /** Whether a repeat of another session's paid call is answered from its receipt (a continuation's sessions do). Receipts
   *  are recorded either way. */
  answer: boolean;
  /** Effects whose outcome is unknown, from the handoff (`handoff.unknown`): a call equal to one is refused. */
  unknown?: readonly Pick<InheritedUnknown, "name" | "argsHash" | "intent">[];
  /** How a call's key is derived. Default: the gateway tool a `fetch` wrapper names, else the tool's own name. */
  keyOf?: (toolName: string, args: unknown) => { tool: string; argsHash: string };
};

export type ReceiptReuse = {
  /** The tool with its `execute` wrapped; a tool not named in `tools` is returned as it is. */
  wrap<T extends ReusableTool>(tool: T): T;
  /** Calls answered from a receipt and calls refused as unknown, so far. */
  readonly stats: { reused: number; refused: number };
};

/** A returned result that is itself a failure is no paid result: `isError`, or a failure envelope as the result itself,
 *  its JSON text, or the text of its content blocks. */
const failed = (raw: unknown): boolean => {
  if (raw && typeof raw === "object" && (raw as { isError?: unknown }).isError === true) return true;
  const content = (raw as { content?: unknown })?.content;
  if (Array.isArray(content)) return returnedFailure(content.map((block) => (block as { text?: string })?.text ?? "").join("\n"));
  return returnedFailure(raw);
};

export function reuseReceipts(options: ReuseReceiptsOptions): ReceiptReuse {
  const keyOf = options.keyOf ?? gatewayIntentOf;
  // An unknown is matched by the name and hash its admission recorded, and by the external call it was admitted for.
  const unknown = new Set((options.unknown ?? []).flatMap((u) => [`${u.name}\n${u.argsHash}`, ...(u.intent ? [`${u.intent.tool}\n${u.intent.argsHash}`] : [])]));
  const paid = new Set(options.tools);
  const stats = { reused: 0, refused: 0 };
  return {
    stats,
    wrap: <T extends ReusableTool>(tool: T): T => !paid.has(tool.name) ? tool : {
      ...tool,
      execute: async (args: unknown, api: any, context: unknown) => {
        const intent = keyOf(tool.name, args);
        if (unknown.has(`${intent.tool}\n${intent.argsHash}`) || unknown.has(`${tool.name}\n${intent.argsHash}`)) {
          stats.refused += 1;
          return { isError: true, content: [{ type: "text", text: `${tool.name} is not called again: an identical earlier call was cut while it ran, so what it did outside is unknown. Work from what you have, or make a different call.` }],
            details: { effect_status: "unknown", refused: true } } satisfies ToolResult;
        }
        const key = `${intent.tool}:${intent.argsHash}`;
        if (options.answer) {
          const receipt = await api.snapshot(ReceiptIndex, key, context);
          if (receipt?.result != null && receipt.session !== options.sessionId) {
            stats.reused += 1;
            const text = typeof receipt.result === "string" ? receipt.result : JSON.stringify(receipt.result);
            return { content: [{ type: "text", text: `${text}\n\n(answered from the paid receipt of ${receipt.session}; the call was not dispatched again)` }],
              details: { effect_status: "reused", source_session: receipt.session } } satisfies ToolResult;
          }
        }
        const result = await tool.execute(args, api, context);
        if (!failed(result)) {
          const value = ((result?.content ?? []) as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n");
          await api.commit(async (tx: any) => {
            const receipt = await tx.doc(ReceiptIndex, key, null);
            if (receipt.result === null) { receipt.tool = intent.tool; receipt.argsHash = intent.argsHash; receipt.result = value; receipt.session = options.sessionId; }
          }, context);
        }
        return result;
      },
    },
  };
}
