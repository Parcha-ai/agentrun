// The session's own tools, as a pi extension: `fork_threads` and `pick` (the `threads` node's), and `gpu_write` / `gpu_bash` (a thread's). The
// others the example's agents use are pi's confined `write` and `read` (file operations in the run's workspace; nothing that starts a process),
// and the workflow's `call` nodes make the two hand-overs. `fork_threads` makes 8 child conversations of the node's own conversation
// (`conversation.fork`, owned by the call), gives each its own GPU sandbox through the box provider, and waits for their answers; a thread's
// two tools run in that thread's sandbox and nowhere else.
import { Type } from "@earendil-works/pi-ai";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ConversationId, Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeDoc } from "@parcha/agentrun-pi/durable";
import type { Box, BoxProvider } from "@parcha/pi-transport";
import { boxEnv } from "@parcha/pi-transport/hands";
import { GPU, GPU_IMAGE, THREADS } from "./config.ts";

type Context = Parameters<ToolExecutionApi["details"]>[1];

export interface Thread {
  readonly n: number;
  readonly conversation: string;
  readonly reply: string;
  readonly metric: number | null;
  readonly settings: string | null;
  /** The GPU name the thread's own `nvidia-smi -L` printed: the evidence of what its sandbox had. */
  readonly gpu: string | null;
}

/** What a thread is asked to do, after the node's own `job` sentence. */
export const THREAD_RULES =
  "You have two tools, gpu_write and gpu_bash, and both run in your own GPU sandbox. First run `nvidia-smi -L` and note the GPU's model name from its line (leave out the UUID). " +
  "Then write ONE short GPU job (a training run of under three minutes), choose its settings yourself, run it, and read its result. " +
  "Answer with exactly one line: METRIC=<a number, lower is better> SETTINGS=<the settings as JSON> GPU=<the model name nvidia-smi -L printed>.";

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

export interface MovesTools {
  /** The provider the threads' sandboxes come from: Modal's on the VM, a stand-in offline. Asked for at the first thread, never before. */
  readonly provider: (workspace: string) => Promise<BoxProvider>;
  /** Labels on every sandbox, so a run's own can be found and ended by exact id. */
  readonly labels: Readonly<Record<string, string>>;
}

export function movesExtensions(deps: MovesTools): { session: Extension; thread: Extension } {
  // One sandbox per thread conversation, made at its first tool call and kept for the process (the threads run in one process, the one on the VM).
  const boxes = new Map<string, Promise<Box>>();
  const boxFor = (conversation: ConversationId, context: Context, workspace: string): Promise<Box> => {
    let box = boxes.get(String(conversation));
    if (!box) {
      box = (async () => {
        const provider = await deps.provider(workspace);
        const made = await provider.create({ gpu: GPU, image: GPU_IMAGE, isolation: "gvisor", maxLifetimeMs: 30 * 60_000, labels: deps.labels }, context);
        if (!made.ok) throw made.error;
        return made.value;
      })();
      boxes.set(String(conversation), box);
    }
    return box;
  };
  const sandbox = async (api: ToolExecutionApi, context: Context) => boxEnv(await boxFor(api.conversationId, context, api.env?.cwd ?? "."));

  const forkThreads = defineTool({
    name: "fork_threads",
    description: `Fork this conversation into ${THREADS} threads. Each continues from here with its own GPU sandbox, writes and runs one GPU job of its own and reports a metric. Returns when all ${THREADS} have answered.`,
    parameters: Type.Object({ job: Type.String({ description: "One sentence: what the GPU job should train or measure." }) }),
    replay: "safe", // a rerun after a crash finds the same threads and the same submissions
    async execute(args, api, context) {
      const children = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, THREADS + 1)).items;
        if (existing.length > 0) return existing.map((record) => record.id).sort();
        // Fork where the conversation last heard from the user, so every thread starts from the same words.
        const entries = (await tx.scanEntries({ conversationId: api.conversationId }, 200)).items;
        const at = entries.find((entry) => entry.kind === "pi.user")?.id;
        if (at === undefined) throw new Error("nothing to fork from yet");
        const made: ConversationId[] = [];
        for (let i = 0; i < THREADS; i++) {
          const child = await tx.forkConversation(api.conversationId, at, { ownership: { kind: "task", taskId: api.taskId } });
          // A thread gets the thread tools and none of this node's: it cannot fork or pick. It is no workflow node, so it does not inherit the node's contract (a copy of it would hold every request
          // until a node runner that never opens this conversation reaches it).
          // The node's tool list is explicit, so the thread's own tools are named in its list too.
          await configure(tx, child.id, { tools: [gpuWrite, gpuBash], extensions: { add: [threadExtension], remove: [forkExtension] } });
          Object.assign(await tx.doc(NodeDoc, child.id), { system: "", label: "", schema: null, fileKey: null });
          made.push(child.id);
        }
        return made;
      }, context);
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
      // The threads are done: their sandboxes are ended now, by the exact box each thread used (one that fails to end is left to its lifetime and the runner's sweep).
      const owned = [...boxes.values()];
      boxes.clear();
      await Promise.allSettled(owned.map(async (box) => (await box).destroy(context)));
      const env = api.env;
      if (!env) throw new Error("no workspace");
      getOrThrow(await env.writeFile("threads.json", `${JSON.stringify({ threads }, null, 2)}\n`, context));
      api.output(threads.map((t) => `thread ${t.n}: ${t.reply}`).join("\n"));
      return {};
    },
  });
  const pick = defineTool({
    name: "pick",
    description: "Record which thread's result you choose, and why. Call it once, after fork_threads has returned.",
    parameters: Type.Object({ thread: Type.Integer({ minimum: 1 }), why: Type.String() }),
    replay: "safe",
    async execute(args, api, context) {
      const env = api.env;
      if (!env) return fail(new Error("no workspace"));
      const read = await env.readTextFile("threads.json", context);
      if (!read.ok) return fail(new Error("fork_threads has not returned yet"));
      const threads = (JSON.parse(read.value) as { threads: Thread[] }).threads;
      const chosen = threads.find((t) => t.n === args.thread);
      if (!chosen) return fail(new Error(`there is no thread ${args.thread}; the threads are 1 to ${threads.length}`));
      const result = { picked: chosen.n, why: args.why, metric: chosen.metric, settings: chosen.settings, gpu: chosen.gpu, threads: threads.map((t) => ({ n: t.n, metric: t.metric, settings: t.settings, gpu: t.gpu })) };
      getOrThrow(await env.writeFile("result.json", `${JSON.stringify(result, null, 2)}\n`, context));
      api.output(`recorded thread ${chosen.n} (metric ${chosen.metric})`);
      return {};
    },
  });
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
    description: "Run a shell command in your sandbox (it has a GPU). Returns its output and exit code.",
    parameters: Type.Object({ command: Type.String(), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 900 })) }),
    // Not replay-safe: a command that was running when the process stopped is reported interrupted, never run twice.
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

  const forkExtension = defineExtension({ name: "moves-session", tools: [forkThreads, pick] });
  const threadExtension = defineExtension({ name: "moves-thread", tools: [gpuWrite, gpuBash] });
  // Both are installed on the host. The `threads` node offers `fork_threads` and `pick` by name; a fork is configured with the thread's two.
  return { session: forkExtension, thread: threadExtension };
}
