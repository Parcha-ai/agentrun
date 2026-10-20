// The session: one app module that all three generations run (`pi-durable-disk run --app app.ts`).
//   generation 1  on the local host: writes the brief with its confined file tool, then moves to the Modal VM.
//   generation 2  on the Modal VM, the disk mounted: forks 8 threads, each with its own H100 sandbox for its tools; picks; moves back.
//   generation 3  on the local host: reads what generation 2 wrote and answers.
// `MOVES_HOST` says where an incarnation runs (`local` or `modal`; the supervisor sets it), `MOVES_MODE=offline` runs the scripted
// model and stand-in sandboxes (the tests). The model key reaches the model through a closure, never through `process.env`
// again: it is read once and removed, so no tool, child process or command of this instance can inherit it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry } from "@earendil-works/pi-durable";
import type { Conversation } from "@earendil-works/pi-durable";
import { parseTransportConfig } from "@parcha/pi-transport";
import { transport } from "@parcha/pi-transport/hands";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";
import { fakeModalBoxes, ledgerPath, modalProvider } from "./boxes.ts";
import { MODEL, THINKING, THREADS, transportBlock } from "./config.ts";
import { scriptedModels } from "./fakes.ts";
import { moveFile, movesExtensions } from "./tools.ts";
import type { Where } from "./tools.ts";

const INSTRUCTIONS = [
  "You are one session that lives on a disk and is carried from host to host. The user opens each stage with a message that starts with [stage N].",
  "Your tools: write_note and read_note (files in your workspace), move_to (hand the session to another host), fork_threads (make 8 threads, each with its own GPU sandbox, and wait for their results), pick (record the thread you choose).",
  "Stage 1 is the local machine: write the brief for a small GPU experiment (what to train, which settings the threads may choose) with write_note, then move_to modal.",
  "Stage 2 is a Modal VM with the disk mounted: call fork_threads once, read the results, call pick for the best, then move_to local.",
  "Stage 3 is the local machine again: read result.json with read_note and answer in two sentences.",
].join("\n");

const PROMPTS: Record<number, string> = {
  1: "[stage 1] You are on the local machine, generation 1. Write the brief, then move to modal.",
  2: "[stage 2] You were moved to a Modal VM with the disk mounted, generation 2. Run the threads, pick the best, then move back to local.",
  3: "[stage 3] You are back on the local machine, generation 3. Read result.json and tell me which thread won and with what settings.",
};

/** The newest thing the agent said, as text. */
async function lastAnswer(conversation: Conversation): Promise<string> {
  const page = await conversation.entries({}, 20, undefined, ctx);
  const entry = page.items.find((e) => e.kind === "pi.assistant");
  const blocks = (Array.isArray(entry?.model) ? entry.model[0] : entry?.model) as { content?: unknown } | undefined;
  const content = blocks?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? (content as { type?: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : "";
}

export default async function app(where: AppContext): Promise<AppOptions> {
  const offline = process.env.MOVES_MODE === "offline";
  const here: Where = process.env.MOVES_HOST === "modal" ? "modal" : "local";
  // The secrets this instance was given, taken out of the environment before anything else runs.
  const take = (name: string) => {
    const value = process.env[name];
    delete process.env[name];
    return value;
  };
  const anthropicKey = take("ANTHROPIC_API_KEY");
  const modalToken = { id: take("MODAL_TOKEN_ID"), secret: take("MODAL_TOKEN_SECRET") };

  let generation = 0;
  let previousDetail: { moveTo?: string; from?: string } | null = null;
  let hands: ReturnType<typeof transport> | undefined;
  const ext = movesExtensions({ work: where.work, generation: () => generation, where: here, threads: THREADS, hands: () => hands });
  const registry = createRegistry();
  registry.install(ext.root);
  registry.install(ext.thread);

  let models;
  let model: { provider: string; modelId: string };
  if (offline) {
    ({ models, model } = scriptedModels());
  } else {
    if (!anthropicKey) throw new Error("the model key is not in this instance's environment");
    models = createModels({ authContext: { env: async (name) => (name === "ANTHROPIC_API_KEY" ? anthropicKey : undefined), fileExists: async () => false } });
    models.setProvider(anthropicProvider());
    model = { ...MODEL };
  }
  const agent = { model, thinkingLevel: THINKING, extensions: [ext.root], instructions: INSTRUCTIONS };

  return {
    models,
    registry,
    async beforeResume({ harness, context, previous, generation: g }) {
      generation = g;
      previousDetail = (previous?.status === "paused" ? previous.detail : null) as typeof previousDetail;
      // Sandboxes for the threads exist only where the threads run: the transport needs a provider that makes Modal sandboxes.
      if (here !== "modal") return;
      const parsed = parseTransportConfig(transportBlock());
      if (!parsed.ok) throw parsed.error;
      const provider = offline
        ? fakeModalBoxes(join(where.work, "..", "tmp", "fake-boxes"), ledgerPath(process.env.MOVES_LEDGER_DIR ?? join(where.work, "..", "tmp")))
        : await modalProvider("agentrun-moves", modalToken.id ?? "", modalToken.secret ?? "");
      hands = transport(parsed.value, { providers: { modal: provider }, commit: (change, c) => harness.commit(change, c), labels: { run: where.ref.id } });
      void context;
    },
    async onOpen(run) {
      generation = run.generation;
      const root = await run.harness.root(ctx, { agent });
      const prompt = PROMPTS[generation] ?? `[stage ${generation}] Continue.`;
      await (await root.submit({ type: "input", content: prompt, requestId: `stage-${generation}` }, ctx)).wait(ctx);
      await run.harness.waitForIdle(ctx);
      const file = moveFile(where.work, generation);
      if (existsSync(file)) {
        // The agent asked for a move: hand the run over. `paused` is left alone by a supervisor unless it is asked to start it.
        const asked = JSON.parse(readFileSync(file, "utf8")) as { from: Where; to: Where };
        await hands?.destroy(ctx);
        await run.setStatus("paused", { moveTo: asked.to, from: asked.from, generation });
        await run.release();
        return;
      }
      if (generation >= 3) {
        const answer = await lastAnswer(root);
        writeFileSync(join(where.work, "answer.txt"), `${answer}\n`);
        const result = existsSync(join(where.work, "result.json")) ? (JSON.parse(readFileSync(join(where.work, "result.json"), "utf8")) as { picked: number }) : null;
        writeFileSync(join(where.work, "report.json"), `${JSON.stringify({ generation, picked: result?.picked ?? null, previousDetail, answer, keyLikeVariablesInTheInstance: Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/i.test(k)) })}\n`);
        await run.setStatus("done", { picked: result?.picked ?? null });
        await run.release();
        return;
      }
      await run.setStatus("failed", { reason: `generation ${generation} ended without asking to move` });
      await run.release();
    },
  };
}
