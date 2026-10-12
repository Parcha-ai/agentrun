// teach_skills: one session teaches the robot its skills on a GPU cluster, as pi-durable threads of itself.
//
// The tool creates a TeachSkills task it owns. In one commit that task creates one Thread task per skill and forks the
// calling conversation once per thread, each fork owned by its Thread task, then parks in a durable allSettled wait on
// the threads. Each Thread task acquires its GPU box, records it in the child's `robot.box` document (the host's
// env(target) builds the child's environment from it), hands the child its assignment, waits for the child's answer,
// flushes the box's artifacts, and releases the box. When every thread has settled, passed or not, TeachSkills folds
// their results and the tool returns them. Every child conversation stays in the same store with its parent link, so
// `read_thread` can answer "what happened on GPU 3?" from GPU 3's own transcript afterwards.
//
// Restart-safe at every step: the tool is replay-safe and finds the TeachSkills task it already made; the parent's
// wait is durable and runs no code; a Thread task re-acquires the same box (acquire is idempotent per thread) and
// resubmits with the same request ID, which finds the same submission; train_skill is replay-safe because the box's
// `pi-run` guard stops a previous run of the same skill and the trainer returns at once when the skill already passed.
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";

/** D2's skill names, frozen 2026-10-12. */
export const SKILLS = ["walk", "sprint", "backwards", "turn-left", "turn-right", "spin", "wave", "get-up"] as const;
export type Skill = (typeof SKILLS)[number];

/** Per child conversation: which skill and GPU it is, and the box its tools run on once acquired. */
export const RobotBox = defineDoc<{ skill: string; gpu: number; of: number; boxId: string | null; teach: number | null }>({
  kind: "robot.box",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ skill: "", gpu: 0, of: 0, boxId: null, teach: null }),
});

/** The tool call's own memory: the TeachSkills task it created, so a rerun after a crash finds it. */
const TeachCall = defineDoc<{ teach: number | null }>({ kind: "robot.teach-call", version: 1, scope: "task", initial: () => ({ teach: null }) });

/** The GPU pool, as the host reaches it (D4's link.gpu on the VM; a fake in tests). */
export interface ThreadBoxes {
  /** The box this thread holds, or a new one; idempotent per thread, and waits while the pool is full. */
  acquire(thread: { threadId: string; skill: string; gpu: number }, context: Context): Promise<string>;
  release(thread: { threadId: string }, context: Context): Promise<void>;
}

/** One artifact mirror per thread (D0's ArtifactSync): the box's skills/<skill>/ to the host's work/skills/<skill>/. */
export interface ThreadArtifacts {
  start(): void | Promise<void>;
  flush(context: Context): Promise<void>;
  stop(): void | Promise<void>;
}

export interface TeachSkillsOptions {
  readonly boxes: ThreadBoxes;
  readonly artifacts?: (box: { boxId: string; skill: string }) => ThreadArtifacts;
  /** The thread's command on its box (default: D2's trainer behind D0's pi-run guard). */
  readonly command?: (skill: string) => readonly string[];
  /** The children's agent cwd on their box (default /workspace). */
  readonly cwd?: string;
  /** A skill's output folder on the box, where the trainer keeps skill.json (default <cwd>/skills/<skill>). */
  readonly skillDir?: (skill: string) => string;
  /** What teach_skills teaches when the call names no skills (default: all of SKILLS). */
  readonly skills?: readonly Skill[];
  /**
   * Brings the passed skills home once every thread has settled and flushed its artifacts (D2's assemble-skills on the
   * session host). It may run again after a restart, so it must be idempotent. Its skills are named in the tool's result;
   * a throw is reported there too, and the threads' results are kept.
   */
  readonly assemble?: (threads: readonly ThreadResult[], context: Context) => Promise<{ readonly home: readonly string[] }>;
}

/** What one thread came back with; also each Thread task's result. */
export type ThreadResult = {
  readonly skill: string;
  readonly gpu: number;
  readonly conversationId: number;
  readonly boxId: string | null;
  readonly status: "passed" | "never-passed" | "bad-body" | "error" | "unanswered" | "aborted";
  readonly checkpoint?: number;
  readonly seconds?: number;
  /** The thread's own closing words. */
  readonly summary: string;
};

export type TrainProgress = {
  skill: string;
  gpu: number;
  status: "starting" | "training" | "passed" | "never-passed" | "bad-body" | "error";
  checkpoint: number;
  steps?: number;
  t?: number;
  passes: boolean;
  exitCode?: number;
  /** The skill had already passed on this box (a replay after the trainer finished); the facts are its skill.json's. */
  already?: boolean;
};

// Task, conversation and entry IDs are numbers in pi-durable's store.
type ThreadRef = { taskId: number; conversationId: number; skill: string; gpu: number };
type TeachInput = { parent: number; at: number; skills: string[] };
type TeachState = { phase: "fork" } | { phase: "fold"; threads: ThreadRef[] };
/** What came home: the skills the assemble hook brought home, or why it could not. */
export type HomeResult = { skills: string[] } | { error: string };
type TeachResult = { threads: ThreadResult[]; home?: HomeResult };
type ThreadInput = { skill: string; gpu: number; of: number };
type ThreadState =
  | { phase: "acquire" }
  | { phase: "run"; conversationId: number; boxId: string }
  | { phase: "release"; conversationId: number; boxId: string; result: ThreadResult };

export const THREAD_INSTRUCTIONS =
  "You are one thread of a teaching run on a GPU cluster, with one GPU of your own and one skill to teach. Do only that: train your skill once, then say in one sentence how it went. Never ask a question.";

export function threadPrompt(t: ThreadInput): string {
  return `You are thread ${t.gpu} of ${t.of}, on GPU ${t.gpu}. Teach the robot to ${t.skill}: call train_skill once with skill "${t.skill}". When it returns, say in one sentence whether ${t.skill} passed, at which checkpoint, and how many seconds it took.`;
}

const defaultCommand = (skill: string) => ["pi-run", skill, "--", "train-skill", skill, "--body", "/workspace/robot.json", "--out", `/workspace/skills/${skill}`];

export function teachSkills(options: TeachSkillsOptions): { readonly teach: Extension; readonly thread: Extension } {
  const command = options.command ?? defaultCommand;
  const cwd = options.cwd ?? "/workspace";
  const skillDir = options.skillDir ?? ((skill: string) => `${cwd}/skills/${skill}`);
  /** Each running thread's artifact mirror in this process, so an abort or a retry can stop it. */
  const mirrors = new Map<number, ThreadArtifacts>();

  // ---- the thread's one tool, on its own box ---------------------------------------------------------------------------
  const trainSkill = defineTool({
    name: "train_skill",
    description: "Train one skill for this robot on this thread's GPU, and wait until it passes its test or runs out of steps.",
    parameters: Type.Object({ skill: Type.Union(SKILLS.map((s) => Type.Literal(s))) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const box = await api.snapshot(RobotBox, api.conversationId, context);
      if (box?.skill && args.skill !== box.skill) throw new Error(`This thread teaches ${box.skill}, not ${args.skill}.`);
      const env = api.env;
      if (env === undefined) throw new Error("This thread has no GPU box.");
      const progress: TrainProgress = { skill: args.skill, gpu: box?.gpu ?? 0, status: "starting", checkpoint: 0, passes: false };
      // Live details are best effort: a failed or cancelled publish must not outlive the call as an unhandled rejection.
      let chain = api.details({ ...progress }, context).catch(() => undefined);
      const publish = () => {
        const value = { ...progress };
        chain = chain.then(() => api.details(value, context)).catch(() => undefined);
      };
      let pending = "";
      let trained = false;
      const started = Date.now();
      const result = await env.exec(command(args.skill), {
        onOutput: (text, _c, info) => {
          if (info.stream !== "stdout") return;
          pending += text;
          let nl: number;
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl).trim();
            pending = pending.slice(nl + 1);
            let event: { event?: string; checkpoint?: number; steps?: number; t?: number; passes?: boolean; passed?: boolean };
            try {
              event = JSON.parse(line);
            } catch {
              continue; // the trainer's stdout is JSON lines; anything else is not progress
            }
            if (event.event === "skill.start") trained = true;
            if (event.event === "skill.done") {
              // A replay of a skill that already passed trains nothing: keep only the facts the trainer states.
              if (typeof event.checkpoint === "number") progress.checkpoint = event.checkpoint;
              if (typeof event.t === "number") progress.t = event.t;
            }
            if (event.event === "skill.checkpoint") {
              trained = true;
              Object.assign(progress, { status: "training", checkpoint: event.checkpoint ?? progress.checkpoint + 1, steps: event.steps, t: event.t, passes: event.passes === true });
              api.output(`checkpoint ${progress.checkpoint}: ${progress.passes ? "passes its test" : "not yet"}${event.t === undefined ? "" : ` (${Math.round(event.t)} s)`}\n`);
              publish();
            }
          }
        },
      }, context).finally(() => chain);
      if (!result.ok) throw new Error(`The run on the box failed: ${result.error.message}`);
      const code = result.value.exitCode;
      progress.exitCode = code;
      progress.status = code === 0 ? "passed" : code === 3 ? "never-passed" : code === 2 ? "bad-body" : "error";
      if (code === 0 && !trained) {
        // The trainer returned at once: the skill had passed before this call (the call is a replay). Its facts are in
        // the skill's skill.json on the box; without them, report the pass and invent no checkpoint or duration.
        progress.already = true;
        const saved = await env.readTextFile(`${skillDir(args.skill)}/skill.json`, context);
        if (saved.ok) {
          try {
            const info = JSON.parse(saved.value) as { passed_at?: unknown; wall_s?: unknown };
            if (typeof info.passed_at === "number") progress.checkpoint = info.passed_at;
            if (typeof info.wall_s === "number") progress.t = info.wall_s;
          } catch {
            // an unreadable skill.json leaves the facts unknown
          }
        }
      }
      const seconds = progress.t ?? (trained ? (Date.now() - started) / 1000 : undefined);
      if (seconds !== undefined) progress.t = seconds;
      const at = progress.checkpoint > 0 ? ` at checkpoint ${progress.checkpoint}` : "";
      const took = seconds !== undefined ? `, ${Math.round(seconds)} s after it started` : "";
      const text =
        progress.status === "passed"
          ? progress.already
            ? `${args.skill} had already passed its test on this GPU${at}${took}.`
            : `${args.skill} passed its test${at}${took}.`
          : progress.status === "never-passed"
            ? `${args.skill} never passed its test in its steps (${progress.checkpoint} checkpoints${seconds !== undefined ? `, ${Math.round(seconds)} s` : ""}).`
            : progress.status === "bad-body"
              ? `${args.skill} could not train: the robot's body is not valid for this trainer.`
              : `${args.skill} stopped with exit code ${code}.`;
      return { content: [{ type: "text", text }], details: { ...progress }, isError: progress.status !== "passed" };
    },
  });
  const thread: Extension = defineExtension({ name: "robot-thread", tools: [trainSkill] });

  // ---- one thread: box, assignment, answer, artifacts, release --------------------------------------------------------
  const Thread = defineTask<ThreadInput, ThreadState, ThreadResult>({
    name: "robot.thread",
    version: 1,
    initial: () => ({ phase: "acquire" }),
    phases: {
      acquire: async (task, runtime, context) => {
        const boxId = await options.boxes.acquire({ threadId: String(task.id), skill: task.input.skill, gpu: task.input.gpu }, context);
        await runtime.commit(async (tx) => {
          const child = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
          if (child === undefined) throw new Error(`thread ${task.id} has no conversation`);
          (await tx.doc(RobotBox, child.id)).boxId = boxId;
          return { status: "running", checkpoint: { phase: "run", conversationId: child.id, boxId } };
        }, context);
      },
      run: async (task, runtime, context) => {
        const { conversationId, boxId } = task.state.checkpoint;
        const sync = options.artifacts?.({ boxId, skill: task.input.skill });
        await mirrors.get(task.id)?.stop(); // a mirror an earlier invocation of this phase left behind
        if (sync !== undefined) mirrors.set(task.id, sync);
        let settled;
        try {
          await sync?.start();
          const handle = await runtime.conversation(conversationId as ConversationId, context);
          if (handle === undefined) throw new Error(`thread conversation ${conversationId} is gone`);
          const submission = await handle.submit({ type: "input", content: threadPrompt(task.input), requestId: `thread:${task.id}` }, context);
          settled = await submission.wait(context);
          await sync?.flush(context);
        } finally {
          // Errors and cancellation too: no mirror keeps copying for a thread that is not running.
          if (mirrors.get(task.id) === sync) mirrors.delete(task.id);
          await sync?.stop();
        }
        await runtime.commit(async (tx) => {
          const result = await readThreadResult(tx, task.input, conversationId as ConversationId, boxId, settled.status === "done" ? settled.answer : undefined);
          return { status: "running", checkpoint: { phase: "release", conversationId, boxId, result } };
        }, context);
      },
      release: async (task, runtime, context) => {
        await options.boxes.release({ threadId: String(task.id) }, context);
        const r = task.state.checkpoint.result;
        await runtime.commit(
          () =>
            r.status === "passed"
              ? { status: "terminal", outcome: { status: "completed", result: r } }
              : { status: "terminal", outcome: { status: "failed", error: { message: r.summary, detail: r } } }, // the fold reads `detail`
          context,
        );
      },
    },
    // Runs after the child conversation (owned work) is aborted: give the box back.
    abort: async (task, runtime, context) => {
      await mirrors.get(task.id)?.stop();
      mirrors.delete(task.id);
      await options.boxes.release({ threadId: String(task.id) }, context).catch(() => undefined);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  // ---- the parent's join: fork every thread in one commit, wait allSettled, fold -------------------------------------
  const TeachSkills = defineTask<TeachInput, TeachState, TeachResult>({
    name: "robot.teach-skills",
    version: 1,
    initial: () => ({ phase: "fork" }),
    phases: {
      fork: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const threads: ThreadRef[] = [];
          const of = task.input.skills.length;
          for (const [i, skill] of task.input.skills.entries()) {
            const gpu = i + 1;
            const taskId = await tx.createTask(Thread, { skill, gpu, of }, { ownership: { kind: "task", taskId: task.id } });
            const child = await tx.forkConversation(task.input.parent as ConversationId, task.input.at as EntryId, { ownership: { kind: "task", taskId } });
            await configure(tx, child.id, { extensions: [thread], tools: null, instructions: THREAD_INSTRUCTIONS, cwd });
            Object.assign(await tx.doc(RobotBox, child.id), { skill, gpu, of, boxId: null, teach: task.id });
            threads.push({ taskId, conversationId: child.id, skill, gpu });
          }
          return { status: "waiting", checkpoint: { phase: "fold", threads }, on: threads.map((t) => t.taskId as TaskId), policy: "allSettled" };
        }, context);
      },
      fold: async (task, runtime, context) => {
        const threads = task.state.checkpoint.threads;
        const outcomes = await runtime.outcomes(threads.map((t) => t.taskId as TaskId<ThreadResult>), context);
        const results = threads.map((t, i): ThreadResult => {
          const o = outcomes[i]!;
          if (o.status === "completed") return o.result;
          // A thread that ran to its end and did not pass saved its result in the failure's detail; use it as saved.
          if (o.status === "failed" && isThreadResult(o.error?.detail)) return o.error.detail;
          const message = o.status === "failed" ? (o.error?.message ?? "The thread failed.") : "The thread was stopped.";
          return { skill: t.skill, gpu: t.gpu, conversationId: t.conversationId, boxId: null, status: o.status === "aborted" ? "aborted" : "error", summary: message };
        });
        // Every thread has settled and flushed its artifacts: bring the skills home before the tool answers.
        let home: HomeResult | undefined;
        if (options.assemble !== undefined) {
          try {
            home = { skills: [...(await options.assemble(results, context)).home] };
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            home = { error: error instanceof Error ? error.message : String(error) };
          }
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { threads: results, ...(home ? { home } : {}) } } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  // ---- the parent's tools ---------------------------------------------------------------------------------------------
  const teachTool = defineTool({
    name: "teach_skills",
    description:
      "Teach the robot its skills on the GPU cluster: one thread per skill, each on its own GPU, all at once. Waits until every thread is done, passed or not, and returns each thread's result. Leave skills out to teach every skill (what \"teach it to move\" means); list skills only when the user names particular ones.",
    parameters: Type.Object({
      skills: Type.Optional(Type.Array(Type.Union(SKILLS.map((s) => Type.Literal(s))), { minItems: 1, maxItems: SKILLS.length, uniqueItems: true, description: "Only these skills. Omit to teach all of them." })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const teach = await api.commit(async (tx) => {
        const at = await forkPoint(tx, api.conversationId); // table reads before any write in this commit
        const call = await tx.doc(TeachCall, api.taskId);
        if (call.teach !== null) return call.teach as TaskId<TeachResult>;
        const skills = args.skills?.length ? [...new Set(args.skills)] : [...(options.skills ?? SKILLS)];
        const id = await tx.createTask(TeachSkills, { parent: api.conversationId, at, skills }, { ownership: { kind: "task", taskId: api.taskId } });
        call.teach = id;
        return id;
      }, context);
      // The threads, for a UI that attaches to them while they run (they are also in the store as the root's children).
      for (let n = 0; ; n++) {
        const record = await api.getTask(teach, context);
        const state = record?.state as { status: string; checkpoint?: TeachState } | undefined;
        if (state?.checkpoint?.phase === "fold" || state?.status === "terminal") {
          if (state.checkpoint?.phase === "fold") await api.details({ teach, threads: state.checkpoint.threads }, context);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(200, 20 * (n + 1))));
      }
      const settled = await api.waitForTask(teach, context);
      const outcome = settled.state.outcome;
      if (outcome.status !== "completed") throw new Error(`The teaching run ${outcome.status === "failed" ? `failed: ${outcome.error.message}` : "was stopped"}.`);
      const { threads, home } = outcome.result;
      const details: { [key: string]: JsonValue } = { teach, threads };
      if (home !== undefined) details.home = home;
      return { content: [{ type: "text", text: foldText(threads, home) }], details };
    },
  });

  const readThread = defineTool({
    name: "read_thread",
    description:
      "Read one teaching thread's own conversation, to answer what happened on it: what it was asked, what its GPU ran, what it reported. thread is a skill name or a GPU number; the newest thread for it is read.",
    parameters: Type.Object({ thread: Type.String({ description: "A skill name (spin) or a GPU number (3)." }) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const text = await api.commit(async (tx) => {
        const child = await findThread(tx, api.conversationId, args.thread);
        if (child === undefined) return undefined;
        return renderThread(tx, child);
      }, context);
      if (text === undefined) throw new Error(`No teaching thread matches "${args.thread}".`);
      return { content: [{ type: "text", text }] };
    },
  });

  const teach: Extension = defineExtension({ name: "robot-teach", tools: [teachTool, readThread], tasks: [TeachSkills, Thread] });
  return { teach, thread };
}

/** Fork the children just before the assistant turn that called teach_skills: they see the request, not the call. */
async function forkPoint(tx: Tx, conversationId: ConversationId): Promise<EntryId> {
  let cursor: Parameters<Tx["scanEntries"]>[2];
  let sawCall = false;
  for (;;) {
    const page = await tx.scanEntries({ conversationId }, 20, cursor);
    for (const entry of page.items) {
      if (sawCall) return entry.id;
      if (entry.kind === AssistantEntry.kind) sawCall = true;
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  throw new Error("teach_skills found no entry to fork at");
}

function isThreadResult(value: unknown): value is ThreadResult {
  const v = value as Partial<ThreadResult> | undefined;
  return typeof v === "object" && v !== null && typeof v.skill === "string" && typeof v.gpu === "number" && typeof v.status === "string" && typeof v.summary === "string";
}

async function readThreadResult(tx: Tx, input: ThreadInput, conversationId: ConversationId, boxId: string, answer: EntryId | undefined): Promise<ThreadResult> {
  let progress: TrainProgress | undefined;
  for (const entry of (await tx.scanEntries({ conversationId }, 20)).items) {
    const message = entry.model?.[0] as { role?: string; toolName?: string; details?: TrainProgress } | undefined;
    if (message?.role === "toolResult" && message.toolName === "train_skill") {
      progress = message.details;
      break;
    }
  }
  const summary = answer === undefined ? "" : assistantText(await tx.entry(answer));
  const status: ThreadResult["status"] =
    answer === undefined ? "unanswered" : progress === undefined ? "error" : progress.status === "starting" || progress.status === "training" ? "error" : progress.status;
  return {
    skill: input.skill,
    gpu: input.gpu,
    conversationId,
    boxId,
    status,
    ...(progress?.checkpoint ? { checkpoint: progress.checkpoint } : {}),
    ...(progress?.t !== undefined ? { seconds: Math.round(progress.t) } : {}),
    summary: summary || (status === "unanswered" ? "The thread never answered." : `${input.skill}: ${status}.`),
  };
}

function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
  return (message?.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("").trim();
}

/** The folded summary the parent's chat gets: one line per thread, in its own words. */
export function foldText(threads: readonly ThreadResult[], home?: HomeResult): string {
  const passed = threads.filter((t) => t.status === "passed").length;
  const lines = threads.map((t) => {
    const how = t.status === "passed" ? `passed${t.checkpoint === undefined ? "" : ` at checkpoint ${t.checkpoint}`}${t.seconds === undefined ? "" : ` in ${t.seconds} s`}` : t.status.replace("-", " ");
    return `- GPU ${t.gpu} · ${t.skill}: ${how}. ${t.summary}`;
  });
  const homeLine =
    home === undefined ? [] : "error" in home ? [`Bringing the skills home failed: ${home.error}`] : [`Home: ${home.skills.length} skill${home.skills.length === 1 ? "" : "s"}${home.skills.length ? ` (${home.skills.join(", ")})` : ""}.`];
  return [`${threads.length} threads finished: ${passed} passed${passed === threads.length ? "" : `, ${threads.length - passed} did not`}.`, ...lines, ...homeLine, "Each thread's own conversation: read_thread with its skill or GPU number."].join("\n");
}

async function findThread(tx: Tx, parent: ConversationId, which: string): Promise<{ id: ConversationId; at: EntryId } | undefined> {
  const want = which.trim().toLowerCase().replace(/^gpu\s*/, "").replace(/_/g, "-");
  let best: { id: ConversationId; at: EntryId } | undefined;
  let cursor: Parameters<Tx["scanConversations"]>[2];
  for (;;) {
    const page = await tx.scanConversations({ ownerConversationId: parent }, 50, cursor);
    for (const record of page.items) {
      if (record.parent === undefined) continue;
      const box = await tx.doc(RobotBox, record.id);
      if (box.skill === want || String(box.gpu) === want) {
        // Newest wins: a relearn's threads come after the first run's.
        if (best === undefined || record.id > best.id) best = { id: record.id, at: record.parent.at };
      }
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return best;
}

/** A thread's own entries (after its fork point), oldest first, as plain lines. */
async function renderThread(tx: Tx, child: { id: ConversationId; at: EntryId }): Promise<string> {
  const box = await tx.doc(RobotBox, child.id);
  const entries: EntryRecord[] = [];
  let cursor: Parameters<Tx["scanEntries"]>[2];
  for (;;) {
    const page = await tx.scanEntries({ conversationId: child.id, minEntryId: child.at }, 50, cursor);
    entries.push(...page.items.filter((e) => e.id !== child.at && e.conversationId === child.id));
    if (page.next === undefined) break;
    cursor = page.next;
  }
  const lines = [`Thread on GPU ${box.gpu} (${box.skill}), box ${box.boxId ?? "none"}, conversation ${child.id}:`];
  for (const entry of entries.reverse()) {
    const m = entry.model?.[0] as { role?: string; content?: unknown; toolName?: string; isError?: boolean } | undefined;
    if (m === undefined) continue;
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : ((m.content as { type: string; text?: string; name?: string; arguments?: unknown }[]) ?? []);
    const text = parts.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("").trim();
    if (m.role === "user") lines.push(`asked: ${text}`);
    else if (m.role === "assistant") {
      for (const c of parts) if (c.type === "toolCall") lines.push(`called ${c.name}(${JSON.stringify(c.arguments)})`);
      if (text) lines.push(`said: ${text}`);
    } else if (m.role === "toolResult") lines.push(`${m.toolName} ${m.isError ? "failed" : "returned"}: ${text.slice(0, 1500)}`);
  }
  return lines.join("\n");
}
