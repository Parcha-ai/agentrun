// The app of example 02: an agent that charges six invoices through a paid API, one tool call each. The model is
// pi-ai's faux provider (no key needed): for "Charge invoice k" it calls the `charge` tool, and it never retries a
// charge that did not complete.
//
// `charge` is an effect: a call with a cost outside the run. pi-durable commits the intent to call it before the call
// starts, so after a crash the call is never repeated: if its result was not committed, the model gets an
// `interrupted` result instead of a second charge. (A tool that only reads can say so with `replay: "safe"` and is rerun.)
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxToolCall, fauxProvider, Type } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { ArchilCodingTools } from "@parcha/pi-durable-disk";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";
import { dispatch } from "../../test/fixtures/paid-api.ts";

export const INVOICES = 6;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function log(event: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ event, ...extra });
  console.log(line);
  if (process.env.EXAMPLE_LOG) appendFileSync(process.env.EXAMPLE_LOG, `${line}\n`);
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("") : "";

async function transcript(conversation: Conversation): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  for (let cursor; ; ) {
    const page = await conversation.entries({}, 500, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all.reverse();
    cursor = page.next;
  }
}

export default async function app(where: AppContext): Promise<AppOptions> {
  let generation = 0;
  // The host's name as the supervisor gave it (`--host-name`), known once the run is open; this machine's until then.
  let host = hostname();
  const api = process.env.PAID_API;
  if (!api) throw new Error("PAID_API names the paid API's URL, e.g. http://127.0.0.1:7071");

  const charge = defineTool({
    name: "charge",
    description: "Charge an invoice through the paid API. Costs real money; call it once per invoice.",
    parameters: Type.Object({ invoice: Type.Number(), amount: Type.Number() }),
    async execute(args, call) {
      log("dispatch", { invoice: args.invoice, key: call.callId, generation, host });
      // The call's id is stable across incarnations, so it is the idempotency key a real paid API would want.
      const answer = await dispatch(api, "charge", call.callId, { invoice: args.invoice, amount: args.amount }, { writer: `${host} generation ${generation}` });
      log("charged", { invoice: args.invoice, key: call.callId, apiCall: answer.seq, generation });
      return { content: [{ type: "text", text: `charged invoice ${args.invoice}: API call #${answer.seq}` }] };
    },
  });
  const registry = createRegistry();
  registry.install(ArchilCodingTools);
  registry.install(defineExtension({ name: "billing", tools: [charge] }));

  const reply: FauxResponseFactory = (context) => {
    const last = context.messages.findLast((m) => (m.role as string) !== "system");
    if (last?.role === "toolResult") {
      return fauxAssistantMessage(last.isError ? `The charge did not complete (${textOf(last.content).slice(0, 120)}). I will not charge again by myself.` : textOf(last.content));
    }
    const invoice = Number(/(\d+)\s*$/.exec(textOf(last?.content))?.[1]);
    return fauxAssistantMessage(fauxToolCall("charge", { invoice, amount: invoice * 5 }, { id: `charge-${invoice}` }), { stopReason: "toolUse" });
  };
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 1000 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const agent = { model: { provider: model.provider, modelId: model.id } };

  return {
    models,
    registry,
    async onOpen(run) {
      generation = run.generation;
      host = String(run.record.holder?.host ?? host);
      const root = await run.harness.root(ctx, { agent });
      log("open", { run: where.ref.id, generation, host, uid: process.getuid?.() });
      for (let invoice = 1; invoice <= INVOICES; invoice++) {
        // A request id admits an invoice once: a resumed run walks the list from the top and sends only what is missing.
        const submission = await root.submit({ type: "input", content: `Charge invoice ${invoice}`, requestId: `invoice-${invoice}` }, ctx);
        const settled = await submission.wait(ctx);
        log("settled", { invoice, status: settled.status, generation });
        await sleep(300);
      }
      // What the store says happened to each charge: its result entry, committed or `interrupted`.
      const outcomes = (await transcript(root))
        .filter((e) => e.kind === "pi.tool-result")
        .map((e) => {
          const m = (e as unknown as { model: { toolCallId: string; isError: boolean; content: unknown }[] }).model[0];
          return { key: m.toolCallId, outcome: m.isError ? "interrupted" : "charged", text: textOf(m.content).slice(0, 100) };
        });
      log("outcomes", { outcomes });
      await run.setStatus("done", { invoices: INVOICES });
      await run.release();
      log("done", { generation });
      process.exit(0);
    },
  };
}
