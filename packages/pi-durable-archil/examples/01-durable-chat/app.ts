// The app of example 01: a chat that answers a fixed list of messages, one every CHAT_PACE_MS, on pi-ai's faux
// provider, so it needs no model key. Each answer names the generation and the host that produced it, so a run that
// was killed on one host and resumed on another shows it in its transcript.
//
// This module is what `pi-durable-archil run --app` loads: a default export that returns pi-durable's Harness options
// (without `env`; the run builds that on its claim) and an `onOpen` that submits or resumes work once the run is open.
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { ArchilCodingTools } from "@parcha/pi-durable-archil";
import type { AppContext, AppOptions } from "@parcha/pi-durable-archil";

export const MESSAGES = [
  "What happens to you when your machine dies mid-sentence?",
  "Who decides which machine may write to your store?",
  "What stops the old machine from writing after the new one starts?",
  "Where does your transcript live?",
  "What did you answer to my first question?",
  "How many of these messages have you seen so far?",
  "Are you the same process that saw the first one?",
  "Say goodbye.",
];

const pace = Number(process.env.CHAT_PACE_MS ?? 1500);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One JSON line on stdout (the journal, under systemd) and, when $EXAMPLE_LOG names a file, appended to it for the demo to follow. */
function log(event: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ event, ...extra });
  console.log(line);
  if (process.env.EXAMPLE_LOG) appendFileSync(process.env.EXAMPLE_LOG, `${line}\n`);
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("") : "";

/** The conversation's entries, oldest first. */
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
  // The scripted model sees the whole transcript, so it can count the messages that came before this one.
  const reply: FauxResponseFactory = (context) => {
    const users = context.messages.filter((m) => m.role === "user");
    const text = `Message ${users.length} of ${MESSAGES.length}: "${textOf(users.at(-1)?.content)}" Answered by generation ${generation} on ${host}.`;
    log("model", { generation, host, text });
    return fauxAssistantMessage(text);
  };
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 1000 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(ArchilCodingTools);
  const model = faux.getModel();
  const agent = { model: { provider: model.provider, modelId: model.id } };

  return {
    models,
    registry,
    async onOpen(run) {
      generation = run.generation;
      host = String(run.record.holder?.host ?? host);
      const root = await run.harness.root(ctx, { agent });
      const answered = (await transcript(root)).filter((e) => e.kind === "pi.assistant").length;
      log("open", { run: where.ref.id, generation, host, uid: process.getuid?.(), alreadyAnswered: answered });
      for (const [i, text] of MESSAGES.entries()) {
        // The request id makes a message a no-op once it was admitted: a resumed run walks the list from the top and
        // only the messages the transcript does not have yet are sent.
        const submission = await root.submit({ type: "input", content: text, requestId: `chat-${i + 1}` }, ctx);
        const settled = await submission.wait(ctx);
        if (i >= answered) log("answered", { n: i + 1, status: settled.status, generation, host });
        await sleep(pace);
      }
      // What the store holds, read back from the committed entries.
      const entries = await transcript(root);
      log("transcript", {
        lines: entries.filter((e) => e.kind === "pi.user" || e.kind === "pi.assistant").map((e) => `${e.kind === "pi.user" ? "you" : "bot"}: ${textOf((e as unknown as { model: { content: unknown }[] }).model[0]?.content)}`),
      });
      await run.setStatus("done", { messages: MESSAGES.length });
      await run.release();
      log("done", { generation });
      process.exit(0);
    },
  };
}
