// The app both hosts run (`pi-durable-disk run --app app.ts`): an agent that does four steps, one `step` tool call each,
// with pi-ai's faux model. On the first host, after step PDA_MOVE_AFTER, the run hands itself over: it records
// `paused` with where it is going and releases (which seals the store), and the instance exits 0. On the next host,
// `beforeResume` reads `previous` (run.json as the last incarnation left it) and, when that was a move, tells the agent
// before any step resumes. At the end the app writes `work/report.json` for the supervisor, which reads it over S3.
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";

export const STEPS = 4;

/** A message's text. A tool result keeps its blocks in `content` up to pi 1.1 and in `output` from 1.2. */
function textOf(message: unknown): string {
  const m = message as { content?: unknown; output?: unknown };
  const blocks = m.output ?? m.content;
  return typeof blocks === "string" ? blocks : Array.isArray(blocks) ? blocks.map((b: { text?: string }) => b.text ?? "").join("") : "";
}

async function transcript(conversation: Conversation): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  for (let cursor; ; ) {
    const page = await conversation.entries({}, 500, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all.reverse();
    cursor = page.next;
  }
}

export default function app(where: AppContext): AppOptions {
  let generation = 0;
  let host = hostname();
  const moveAfter = Number(process.env.PDA_MOVE_AFTER ?? 0);
  const moveTo = process.env.PDA_MOVE_TO ?? "";

  const step = defineTool({
    name: "step",
    description: "Do one step of the job. It changes the workspace: call it once per step.",
    parameters: Type.Object({ n: Type.Number() }),
    async execute(args, api) {
      writeFileSync(join(where.work, `step-${args.n}.txt`), `${JSON.stringify({ step: args.n, generation, host })}\n`);
      api.output(`step ${args.n} done by generation ${generation} on ${host}`);
      return {};
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "job", tools: [step] }));

  // "Do step k" calls `step` once; anything else (a result, the move note) gets a short answer.
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 100 }, () => (context: { messages: Message[] }) => {
    // pi 1.0 adds a system message after the user's, so the last message that counts is the last non-system one.
    const last = context.messages.findLast((m) => (m.role as string) !== "system");
    const k = /^Do step (\d+)$/.exec(textOf(last))?.[1];
    if (last?.role === "user" && k) return fauxAssistantMessage(fauxToolCall("step", { n: Number(k) }, { id: `step-${k}` }), { stopReason: "toolUse" });
    return fauxAssistantMessage(last?.role === "toolResult" ? textOf(last) : `Noted: ${textOf(last)}`);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const agent = { model: { provider: model.provider, modelId: model.id } };

  return {
    models,
    registry,
    async beforeResume({ harness, context, generation: g, previous }) {
      // A planned move left run.json `paused` with where it went: say so before any resumed step.
      const detail = previous?.detail as { moveTo?: string; from?: string; afterStep?: number } | null | undefined;
      if (previous?.status !== "paused" || !detail?.moveTo) return;
      const root = await harness.root(context, { agent });
      const content = `You were moved from ${detail.from} to ${process.env.PDA_HOST_LABEL ?? hostname()} after step ${detail.afterStep}.`;
      await root.submit({ type: "input", content, requestId: `moved-g${g}` }, context);
    },
    async onOpen(run) {
      generation = run.generation;
      host = String(run.record.holder?.host ?? host);
      const root = await run.harness.root(ctx, { agent });
      for (let n = 1; n <= STEPS; n++) {
        // The request id admits a step once: the next host walks the list from the top and adds only what is missing.
        await (await root.submit({ type: "input", content: `Do step ${n}`, requestId: `step-${n}` }, ctx)).wait(ctx);
        if (n === moveAfter && moveTo && generation === 1) {
          // The step boundary: hand the run over. `paused` is left alone by a supervisor unless it is asked to start it.
          await run.setStatus("paused", { moveTo, from: host, afterStep: n });
          await run.release();
          process.exit(0);
        }
      }
      await run.harness.waitForIdle(ctx);
      // What the store says happened, for the supervisor: every tool result, the move note, nothing interrupted.
      const entries = await transcript(root);
      const results = entries.filter((e) => e.kind === "pi.tool-result").map((e) => (Array.isArray(e.model) ? e.model[0] : e.model) as { toolCallId: string; isError: boolean });
      const notes = entries.filter((e) => e.kind === "pi.user").map((e) => textOf(Array.isArray(e.model) ? e.model[0] : e.model)).filter((t) => t.startsWith("You were moved"));
      const report = {
        generation,
        host,
        results: results.map((r) => ({ id: r.toolCallId, error: r.isError })),
        moveNotes: notes,
        stepOrder: entries.filter((e) => e.kind === "pi.user").map((e) => textOf(Array.isArray(e.model) ? e.model[0] : e.model)),
      };
      writeFileSync(join(where.work, "report.json"), `${JSON.stringify(report)}\n`);
      await run.setStatus("done", { steps: STEPS });
      await run.release();
      process.exit(0);
    },
  };
}
