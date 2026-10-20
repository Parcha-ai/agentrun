// The session's tools. The root conversation has `move_to`, `fork_threads` and `pick`, and two file tools confined to `work/`;
// it has no shell. A thread (a fork of the root, one per H100 sandbox) has `gpu_write` and `gpu_bash`, and both go to the
// thread's own sandbox through pi-transport: nothing a thread runs executes on the machine the session runs on.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ConversationId, Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { transport } from "@parcha/pi-transport/hands";
import { NoteError, readNote, writeNote } from "./notes.ts";

export type Where = "local" | "modal";
type Transport = ReturnType<typeof transport>;
type Context = Parameters<ToolExecutionApi["details"]>[1];

/** What the tools need from the app that installs them. */
export interface MovesRuntime {
  readonly work: string;
  /** This incarnation's generation and where it runs. */
  readonly generation: () => number;
  readonly where: Where;
  /** How many threads `fork_threads` makes. */
  readonly threads: number;
  /** The transport that gives each thread its sandbox; present on the Modal VM only. */
  readonly hands: () => Transport | undefined;
}

export interface Thread {
  readonly n: number;
  readonly conversation: string;
  readonly reply: string;
  readonly metric: number | null;
  readonly settings: string | null;
  /** The GPU name the thread's own `nvidia-smi` printed: the evidence of what the sandbox had. */
  readonly gpu: string | null;
}

/** What a thread is asked to do, after the root's own `job` sentence. */
export const THREAD_RULES =
  "You have two tools, gpu_write and gpu_bash, and both run in your own GPU sandbox. First run `nvidia-smi -L` and note the GPU's model name from its line (leave out the UUID). " +
  "Then write ONE short GPU job (a training run of under three minutes), choose its settings yourself, run it, and read its result. " +
  "Answer with exactly one line: METRIC=<a number, lower is better> SETTINGS=<the settings as JSON> GPU=<the model name nvidia-smi -L printed>.";

/** What `move_to` leaves for the instance: the generation that asked and where to. */
export const moveFile = (work: string, generation: number) => join(work, "moves", `g${generation}.json`);

const text = (value: unknown): string => {
  const m = value as { content?: unknown; output?: unknown };
  const blocks = m?.output ?? m?.content;
  return typeof blocks === "string" ? blocks : Array.isArray(blocks) ? blocks.map((b: { text?: string }) => b.text ?? "").join("") : "";
};

/** `METRIC=<number> SETTINGS=<json> GPU=<name>` as a thread answered it. */
export function parseReply(reply: string): { metric: number | null; settings: string | null; gpu: string | null } {
  const metric = /METRIC=(-?\d+(?:\.\d+)?(?:e-?\d+)?)/i.exec(reply)?.[1];
  const settings = /SETTINGS=(\{.*?\})(?:\s|$)/.exec(reply)?.[1];
  const gpu = /GPU=([^(]+?)\s*(?:\(|$)/.exec(reply)?.[1];
  return { metric: metric === undefined ? null : Number(metric), settings: settings ?? null, gpu: gpu ?? null };
}

const fail = (error: unknown) => ({ isError: true as const, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });

export function movesExtensions(rt: MovesRuntime): { root: Extension; thread: Extension } {
  const writeNoteTool = defineTool({
    name: "write_note",
    description: "Write a text file in the run's workspace (a relative path, inside the workspace).",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    replay: "safe",
    async execute(args, api) {
      try {
        writeNote(rt.work, args.path, args.content);
        api.output(`wrote ${args.path}`);
        return {};
      } catch (error) {
        return fail(error);
      }
    },
  });
  const readNoteTool = defineTool({
    name: "read_note",
    description: "Read a text file from the run's workspace (a relative path, inside the workspace).",
    parameters: Type.Object({ path: Type.String() }),
    replay: "safe",
    async execute(args, api) {
      try {
        api.output(readNote(rt.work, args.path));
        return {};
      } catch (error) {
        return fail(error);
      }
    },
  });
  const moveTo = defineTool({
    name: "move_to",
    description:
      "Hand the session over to another host at the end of this turn: `modal` (a Modal VM with the disk mounted, where the threads run) or `local` (back to the machine you started on). Call it once, when your work for this host is done.",
    parameters: Type.Object({ to: Type.Union([Type.Literal("modal"), Type.Literal("local")]) }),
    replay: "safe",
    async execute(args, api) {
      if (args.to === rt.where) return fail(new Error(`you are already on ${rt.where}`));
      const g = rt.generation();
      mkdirSync(join(rt.work, "moves"), { recursive: true });
      writeFileSync(moveFile(rt.work, g), `${JSON.stringify({ from: rt.where, to: args.to, generation: g })}\n`);
      api.output(`The session will move to ${args.to} when this turn ends.`);
      return {};
    },
  });
  const forkThreads = defineTool({
    name: "fork_threads",
    description: `Fork the conversation into ${rt.threads} threads. Each thread continues from here, with its own H100 sandbox, writes and runs one GPU job of its own and reports a metric. This call returns when all of them have answered.`,
    parameters: Type.Object({ job: Type.String({ description: "One sentence: what the GPU job should train or measure." }) }),
    replay: "safe", // a rerun after a crash finds the same threads and the same submissions
    async execute(args, api, context) {
      const hands = rt.hands();
      if (!hands) return fail(new Error("this host has no sandboxes for threads: move to modal first"));
      const children = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, rt.threads + 1)).items;
        if (existing.length > 0) return existing.map((record) => record.id).sort();
        // Fork where the conversation last heard from the user, so every thread starts from the same words.
        const entries = (await tx.scanEntries({ conversationId: api.conversationId }, 200)).items;
        const at = entries.find((entry) => entry.kind === "pi.user")?.id;
        if (at === undefined) throw new Error("nothing to fork from yet");
        const made: ConversationId[] = [];
        for (let i = 0; i < rt.threads; i++) {
          const child = await tx.forkConversation(api.conversationId, at, { ownership: { kind: "task", taskId: api.taskId } });
          // A thread gets the thread tools and none of the root's: it cannot fork, move or pick.
          await configure(tx, child.id, { extensions: { add: [extensions.thread], remove: [extensions.root] } });
          made.push(child.id);
        }
        return made;
      }, context);
      for (const child of children) getOrThrow(await hands.assign(child, "gpu", context));
      await api.details({ threads: children.map(String) }, context);
      const replies = await Promise.all(
        children.map(async (child, i) => {
          const handle = await api.conversation(child, context);
          if (!handle) throw new Error(`thread ${i + 1} is gone`);
          const content = `Thread ${i + 1} of ${children.length}. ${args.job}\n\n${THREAD_RULES}`;
          await (await handle.submit({ type: "input", content, requestId: `thread:${api.taskId}:${i + 1}` }, context)).wait(context);
          const entries = (await api.commit((tx) => tx.scanEntries({ conversationId: child }, 40), context)).items;
          const answer = entries.find((entry) => entry.kind === "pi.assistant" && text(Array.isArray(entry.model) ? entry.model[0] : entry.model).includes("METRIC="));
          return text(Array.isArray(answer?.model) ? answer.model[0] : answer?.model) || "(no answer)";
        }),
      );
      const threads: Thread[] = replies.map((reply, i) => ({ n: i + 1, conversation: String(children[i]), reply, ...parseReply(reply) }));
      mkdirSync(rt.work, { recursive: true });
      writeFileSync(join(rt.work, "threads.json"), `${JSON.stringify({ threads }, null, 2)}\n`);
      api.output(threads.map((t) => `thread ${t.n}: ${t.reply}`).join("\n"));
      return {};
    },
  });
  const pick = defineTool({
    name: "pick",
    description: "Record which thread's result you choose, and why. Call it once, after fork_threads has returned.",
    parameters: Type.Object({ thread: Type.Integer({ minimum: 1 }), why: Type.String() }),
    replay: "safe",
    async execute(args, api) {
      let threads: Thread[];
      try {
        threads = (JSON.parse(readFileSync(join(rt.work, "threads.json"), "utf8")) as { threads: Thread[] }).threads;
      } catch {
        return fail(new Error("fork_threads has not returned yet"));
      }
      const chosen = threads.find((t) => t.n === args.thread);
      if (!chosen) return fail(new Error(`there is no thread ${args.thread}; the threads are 1 to ${threads.length}`));
      writeFileSync(join(rt.work, "result.json"), `${JSON.stringify({ picked: chosen.n, why: args.why, metric: chosen.metric, settings: chosen.settings, threads: threads.map((t) => ({ n: t.n, metric: t.metric, settings: t.settings, gpu: t.gpu })) }, null, 2)}\n`);
      api.output(`recorded thread ${chosen.n} (metric ${chosen.metric})`);
      return {};
    },
  });

  /** The thread's sandbox: pi-transport's environment for this conversation, and never the host's own. */
  async function sandbox(api: ToolExecutionApi, context: Context) {
    const hands = rt.hands();
    const env = hands ? await hands.env({ conversationId: api.conversationId, read: api }, context) : undefined;
    if (!env) throw new Error("this conversation has no sandbox, and its tools never run on the host");
    return env;
  }
  const gpuWrite = defineTool({
    name: "gpu_write",
    description: "Write a file in your sandbox (a relative path).",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    replay: "safe",
    async execute(args, api, context) {
      try {
        getOrThrow(await (await sandbox(api, context)).writeFile(args.path, args.content, context));
        api.output(`wrote ${args.path}`);
        return {};
      } catch (error) {
        return fail(error);
      }
    },
  });
  const gpuBash = defineTool({
    name: "gpu_bash",
    description: "Run a shell command in your sandbox (it has an H100). Returns its output and exit code.",
    parameters: Type.Object({ command: Type.String(), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900 })) }),
    // Not replay-safe: a command that was running when the host stopped is reported interrupted, never run twice.
    async execute(args, api, context) {
      try {
        const env = await sandbox(api, context);
        let output = "";
        const result = getOrThrow(await env.exec(args.command, { timeout: args.timeoutSeconds ?? 600, onOutput: (chunk: string) => void (output += chunk) }, context));
        api.output(`${output.slice(-6000)}\nexit ${result.exitCode}`);
        return {};
      } catch (error) {
        return fail(error);
      }
    },
  });

  const extensions = {
    root: defineExtension({ name: "moves-root", tools: [writeNoteTool, readNoteTool, moveTo, forkThreads, pick] }),
    thread: defineExtension({ name: "moves-thread", tools: [gpuWrite, gpuBash] }),
  };
  return extensions;
}

export { NoteError };
