// One host process of the teach_skills spike: a real pi-durable Harness over SQLite, the robot-teach and robot-thread
// extensions, fake GPU boxes, and a scripted model (pi-ai's faux provider) that plays both the session and its threads.
//
//   node host.ts --dir DIR --mode first   [--tick 700] [--capacity 8]   submit "Teach it to move." and run until killed
//   node host.ts --dir DIR --mode resume  [--tick 700] [--capacity 8]   reopen the same store, resume, finish, ask GPU 3
//
// Every live line it prints comes from the store: watchEvents() over the root and over each child conversation.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, FauxResponseFactory } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, watchEvents, type ConversationId, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { RobotBox, SKILLS, teachSkills, type TrainProgress } from "../teach-skills.ts";
import { FakeArtifacts, FakeBoxEnv, FakePool } from "./fake-cluster.ts";

const { values: a } = parseArgs({ options: { dir: { type: "string" }, mode: { type: "string" }, tick: { type: "string", default: "700" }, capacity: { type: "string", default: "8" } } });
const dir = a.dir!;
const mode = a.mode as "first" | "resume";
const tick = Number(a.tick);
const context = BACKGROUND_CONTEXT;
const T0 = Date.now();
mkdirSync(dir, { recursive: true });
const eventsFile = join(dir, `events-${mode}.jsonl`);
const say = (line: Record<string, unknown>) => {
  const full = { t: Date.now() - T0, mode, ...line };
  appendFileSync(eventsFile, `${JSON.stringify(full)}\n`);
  console.log(JSON.stringify(full));
};

// ---- the scripted model ------------------------------------------------------------------------------------------------
const textOf = (m: { content?: unknown }) =>
  typeof m.content === "string" ? m.content : ((m.content as { type: string; text?: string }[]) ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
const toolUse = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const brain: FauxResponseFactory = (ctx) => {
  // pi-durable puts positional system entries (sections, tool changes) into the transcript; answer the last real turn.
  const last = ctx.messages.filter((m) => m.role !== "system").pop() as { role: string; toolName?: string; content?: unknown };
  const text = textOf(last);
  if (last.role === "toolResult") {
    if (last.toolName === "teach_skills") say({ event: "teach.result", text });
    if (last.toolName === "teach_skills") return fauxAssistantMessage(fauxText(`Your robot learned its skills. ${text.split("\n")[0]} Ask me about any GPU.`));
    if (last.toolName === "train_skill") return fauxAssistantMessage(fauxText(text.split("\n")[0]!));
    if (last.toolName === "read_thread") {
      const lines = text.split("\n");
      const said = lines.filter((l) => l.startsWith("said: ")).pop()?.slice(6) ?? "";
      const ran = lines.find((l) => l.startsWith("train_skill "))?.replace(/^train_skill (returned|failed): /, "") ?? "";
      return fauxAssistantMessage(fauxText(`${lines[0]!.replace(/,? box .*/, "")}: ${ran.split("\n")[0]} It said: "${said}"`));
    }
  }
  if (last.role === "user") {
    const assigned = /Teach the robot to ([\w-]+): call train_skill/.exec(text);
    if (assigned) return toolUse("train_skill", { skill: assigned[1] });
    if (/teach it to move/i.test(text)) return toolUse("teach_skills", { skills: [...SKILLS] });
    const gpu = /happened on GPU (\d+)/i.exec(text);
    if (gpu) return toolUse("read_thread", { thread: gpu[1] });
  }
  return fauxAssistantMessage(fauxText("OK."));
};

// ---- the host ----------------------------------------------------------------------------------------------------------
const pool = new FakePool(dir, Number(a.capacity), (line) => say(line as Record<string, unknown>));
const artifacts: FakeArtifacts[] = [];
const { teach, thread } = teachSkills({
  boxes: pool,
  artifacts: ({ boxId, skill }) => {
    const sync = new FakeArtifacts(join(pool.boxDir(boxId), "workspace", "skills", skill), join(dir, "work", "skills", skill));
    artifacts.push(sync);
    return sync;
  },
});
const registry = createRegistry();
registry.install(teach);
registry.install(thread);
const faux = fauxProvider({ tokensPerSecond: 2000 });
const models = createModels();
models.setProvider(faux.provider);
faux.appendResponses(Array.from({ length: 400 }, () => brain));
const model = { provider: "faux", modelId: faux.getModel().id };

const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.sqlite")), {
  models,
  registry,
  settings: { extensions: [teach] },
  env: async (target, ctx) => {
    const box = await target.read.snapshot(RobotBox, target.conversationId, ctx);
    return box?.boxId ? new FakeBoxEnv(box.boxId, pool.boxDir(box.boxId), tick) : undefined;
  },
}, context);
const root = await harness.root(context, { agent: { model } });
say({ event: "open", root: root.id });

// ---- per-thread live lines, from the store -----------------------------------------------------------------------------
const label = new Map<ConversationId, string>();
const lastCheckpoint = new Map<ConversationId, number>();
const attached = new Set<ConversationId>();
async function attach(id: ConversationId, who: string): Promise<void> {
  if (attached.has(id)) return;
  attached.add(id);
  label.set(id, who);
  const stream = await watchEvents(harness, id, context);
  stream.start(async (events) => {
    for (const event of events) {
      if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const d = (event as { details?: unknown }).details as (TrainProgress & { threads?: { conversationId: number; skill: string; gpu: number }[] }) | undefined;
        if (d?.threads) for (const t of d.threads) await attach(t.conversationId as ConversationId, `GPU ${t.gpu} · ${t.skill}`);
        if (d?.skill !== undefined && d.checkpoint > (lastCheckpoint.get(id) ?? 0)) {
          lastCheckpoint.set(id, d.checkpoint);
          say({ event: "thread.checkpoint", who, checkpoint: d.checkpoint, passes: d.passes });
        }
      } else if (event.type === "tool_execution_start") {
        say({ event: "tool.start", who, tool: (event as { toolName?: string }).toolName });
      } else if (event.type === "message_end" && event.entry.kind === "pi.assistant") {
        const m = event.entry.model?.[0] as AssistantMessage | undefined;
        const text = m ? textOf(m) : "";
        if (text) say({ event: "said", who, text });
      }
    }
  });
}
await attach(root.id, "session");

const threadsOfRoot = () =>
  root.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerConversationId: root.id }, 50);
    const out = [];
    for (const r of page.items) out.push({ id: r.id, parent: r.parent, owner: r.owner, box: { ...(await tx.doc(RobotBox, r.id)) } });
    return out;
  }, context);

async function graph() {
  const g = await harness.taskGraph(context);
  const value = g.value;
  g.dispose();
  return Object.values(value.tasks).map((n) => ({
    id: n.id,
    kind: n.kind,
    owner: n.owner ?? null,
    status: n.state.status,
    ...(n.state.status === "waiting" ? { on: n.state.on.length, policy: n.state.policy } : {}),
  }));
}

if (mode === "first") {
  const submission = await root.submit({ type: "input", content: "Teach it to move.", requestId: "teach-1" }, context);
  say({ event: "submitted", submission: submission.id });
  // Tell the orchestrator when the threads are mid-run: some skills passed, most still training.
  const timer = setInterval(async () => {
    // Mid-run: about half of all the checkpoints the threads will write (some skills passed, others still training).
    const counts = [...lastCheckpoint.values()];
    if (counts.reduce((n, c) => n + c, 0) >= 30) {
      clearInterval(timer);
      const tasks = await graph();
      writeFileSync(join(dir, "mid.json"), JSON.stringify({ t: Date.now() - T0, checkpoints: Object.fromEntries([...lastCheckpoint].map(([k, v]) => [label.get(k), v])), tasks }, null, 1));
      say({ event: "mid", tasks: tasks.length });
    }
  }, 50);
  await new Promise(() => {}); // the orchestrator kills this process
} else {
  // Before resuming: the store as the dead process left it.
  const before = await graph();
  writeFileSync(join(dir, "before-resume.json"), JSON.stringify(before, null, 1));
  say({ event: "before-resume", teach: before.find((t) => t.kind === "robot.teach-skills"), threads: before.filter((t) => t.kind === "robot.thread").map((t) => t.status) });
  for (const c of await threadsOfRoot()) await attach(c.id as ConversationId, `GPU ${c.box.gpu} · ${c.box.skill}`);
  const tResume = Date.now();
  harness.resume();
  const submission = await root.submit({ type: "input", content: "Teach it to move.", requestId: "teach-1" }, context);
  const settled = await submission.wait(context);
  say({ event: "teach.settled", status: settled.status, s: (Date.now() - tResume) / 1000 });
  const answer = settled.status === "done" && settled.answer !== undefined ? await root.commit((tx) => tx.entry(settled.answer!), context) : undefined;
  const ask = await (await root.submit({ type: "input", content: "What happened on GPU 3?", requestId: "ask-gpu3" }, context)).wait(context);
  const askAnswer = ask.status === "done" && ask.answer !== undefined ? await root.commit((tx) => tx.entry(ask.answer!), context) : undefined;
  await harness.waitForIdle(context);

  // The evidence, read back from the one store.
  const report = await root.commit(async (tx) => {
    const entries = async (id: ConversationId, min?: EntryId) => {
      const out: EntryRecord[] = [];
      let cursor;
      for (;;) {
        const page = await tx.scanEntries({ conversationId: id, ...(min !== undefined ? { minEntryId: min } : {}) }, 100, cursor);
        out.push(...page.items);
        if (!page.next) break;
        cursor = page.next;
      }
      return out.reverse();
    };
    const rootEntries = await entries(root.id);
    const teachResult = rootEntries.map((e) => e.model?.[0] as { role?: string; toolName?: string; content?: unknown; details?: unknown } | undefined).find((m) => m?.role === "toolResult" && m.toolName === "teach_skills");
    const readResult = rootEntries.map((e) => e.model?.[0] as { role?: string; toolName?: string; content?: unknown } | undefined).find((m) => m?.role === "toolResult" && m.toolName === "read_thread");
    const children = [];
    for (const r of (await tx.scanConversations({ ownerConversationId: root.id }, 50)).items) {
      const own = (await entries(r.id, r.parent?.at)).filter((e) => e.conversationId === r.id);
      children.push({ id: r.id, parent: r.parent, owner: r.owner, box: { ...(await tx.doc(RobotBox, r.id)) }, ownEntries: own.length, kinds: own.map((e) => e.kind) });
    }
    return { teachResult: teachResult && { text: textOf(teachResult), details: teachResult.details }, readThread: readResult && textOf(readResult), children };
  }, context);
  const out = {
    resume_to_settled_s: (Date.now() - tResume) / 1000,
    answer: answer ? textOf(answer.model![0] as never) : null,
    ask: askAnswer ? textOf(askAnswer.model![0] as never) : null,
    ...report,
    artifacts_copied: artifacts.reduce((n, s) => n + s.copied, 0),
    tasks_after: await graph(),
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(out, null, 1));
  say({ event: "done", children: report.children.length });
  await harness.close(context);
  process.exit(0);
}
