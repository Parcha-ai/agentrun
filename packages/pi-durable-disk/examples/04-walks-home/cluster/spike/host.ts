// One host process of the teach_skills spike: a real pi-durable Harness over SQLite, the robot-teach and robot-thread
// extensions, fake GPU boxes, and a scripted model (pi-ai's faux provider) that plays both the session and its threads.
//
//   node host.ts --dir DIR --mode first   [--tick 700] [--capacity 8]   submit "Teach it to move." and run until killed
//   node host.ts --dir DIR --mode resume  [--tick 700] [--capacity 8]   reopen the same store, resume, finish, ask GPU 3
//   node host.ts --dir DIR --mode abort                                  start teaching, abort the run mid-way, check cleanup
//   --done-before SKILL:CHECKPOINT:SECONDS   that skill's box already holds a finished run (a replay after the trainer ended)
//   --assemble-fails                         bringing the skills home throws
//   --plan [--deadline-ms N]                 code mode: the session plans 3 skills with briefs; each thread writes a reward
//                                            and trains it with its coding tools (write, bash) on its box
//
// Every live line it prints comes from the store: watchEvents() over the root and over each child conversation.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, FauxResponseFactory } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, watchEvents, type ConversationId, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { RobotBox, SKILLS, teachSkills, type TrainProgress } from "../teach-skills.ts";
import { FakeArtifacts, FakeBoxEnv, FakePool, MAX_CHECKPOINTS, PASS_AT } from "./fake-cluster.ts";

const { values: a } = parseArgs({ options: { dir: { type: "string" }, mode: { type: "string" }, tick: { type: "string", default: "700" }, capacity: { type: "string", default: "8" }, "done-before": { type: "string" }, "assemble-fails": { type: "boolean", default: false }, plan: { type: "boolean", default: false }, "deadline-ms": { type: "string" } } });
const dir = a.dir!;
const mode = a.mode as "first" | "resume" | "abort";
const doneBefore = Object.fromEntries((a["done-before"] ?? "").split(",").filter(Boolean).map((spec) => {
  const [skill, checkpoint, seconds] = spec.split(":");
  return [skill!, { checkpoint: Number(checkpoint), seconds: Number(seconds) }];
}));
/**
 * The kill point: half of all the checkpoints this run will write. Skills whose box already holds a finished run write
 * none, so the threshold comes from the skills that train; with none left there is no mid-run to kill.
 */
export function midThreshold(skills: readonly string[], done: Record<string, unknown>): number {
  const total = skills.filter((s) => !(s in done)).reduce((n, s) => n + (PASS_AT[s] ?? MAX_CHECKPOINTS), 0);
  if (total === 0) throw new Error("every skill is --done-before: no thread trains, so there is no mid-run to kill");
  return Math.max(1, Math.floor(total / 2));
}
const mid = midThreshold(SKILLS, doneBefore);
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
const PLAN = [
  { name: "walk", brief: "Walk forward steadily: forward speed above 0.3 m/s for 5 s without falling. Stop after 2 runs." },
  { name: "spin", brief: "Turn in place: yaw rate above 1 rad/s for 3 s with the torso upright. Stop after 2 runs." },
  { name: "wave", brief: "Lift one front leg and wave it while standing on the others for 3 s. Stop after 2 runs." },
];
const planThread = (msgs: { role: string; toolName?: string; content?: unknown }[]) => {
  let u = -1;
  msgs.forEach((m, i) => { if (m.role === "user") u = i; });
  const skill = /Your skill: ([\w-]+)/.exec(u >= 0 ? textOf(msgs[u]!) : "")?.[1];
  if (!skill) return undefined;
  const results = msgs.slice(u + 1).filter((m) => m.role === "toolResult") as { role: string; toolName?: string; isError?: boolean; content?: unknown }[];
  const train = toolUse("bash", { command: `pi-run ${skill} -- python train.py --reward train/${skill}_reward.py --out /workspace/skills/${skill}`, timeout: 120 });
  const last = results[results.length - 1];
  if (results.length === 0) return toolUse("write", { path: `train/${skill}_reward.py`, content: `def reward(obs):\n    return obs["${skill}_progress"]\n` });
  if (results.length === 1) return train;
  // A training run the host's restart interrupted is run again (pi-run stops the old one on the box first).
  if (last?.toolName === "bash" && last.isError && /interrupt/i.test(textOf(last)) && results.length < 4) return train;
  if (!results.some((r) => r.toolName === "bash" && /skill\.json|"status"/.test(textOf(r)))) {
    if (last?.toolName === "bash" && !/"status"/.test(textOf(last))) return toolUse("bash", { command: `cat /workspace/skills/${skill}/skill.json` });
  }
  return fauxAssistantMessage(fauxText(`I wrote a reward for ${skill}, trained it with it, and read its skill.json.`));
};
const brain: FauxResponseFactory = (ctx) => {
  if (a.plan) {
    const real = ctx.messages.filter((m) => m.role !== "system") as { role: string; toolName?: string; content?: unknown }[];
    const step = planThread(real);
    if (step) return step;
    const lastReal = real[real.length - 1]!;
    if (lastReal.role === "user" && /teach it to move/i.test(textOf(lastReal))) return toolUse("teach_skills", { skills: PLAN });
  }
  // pi-durable puts positional system entries (sections, tool changes) into the transcript; answer the last real turn.
  const last = ctx.messages.filter((m) => m.role !== "system").pop() as { role: string; toolName?: string; content?: unknown };
  const text = textOf(last);
  if (last.role === "toolResult") {
    if (last.toolName === "teach_skills") say({ event: "teach.result", text });
    if (last.toolName === "teach_skills") return fauxAssistantMessage(fauxText(`Your robot learned its skills. ${text.split("\n")[0]} Ask me about any GPU.`));
    // A thread that did not pass says so in its own words, which never decide its status.
    if (last.toolName === "train_skill") return fauxAssistantMessage(fauxText((last as { isError?: boolean }).isError ? `${/^([\w-]+)/.exec(text)?.[1]} ran out of steps.` : text.split("\n")[0]!));
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
    if (/teach it to move/i.test(text)) return toolUse("teach_skills", {}); // no skills named: all of them
    const gpu = /happened on GPU (\d+)/i.exec(text);
    if (gpu) return toolUse("read_thread", { thread: gpu[1] });
  }
  return fauxAssistantMessage(fauxText("OK."));
};

// ---- the host ----------------------------------------------------------------------------------------------------------
const pool = new FakePool(dir, Number(a.capacity), (line) => say(line as Record<string, unknown>), doneBefore);
const artifacts: FakeArtifacts[] = [];
const { teach, thread } = teachSkills({
  ...(a.plan
    ? {
        plan: {
          threadExtensions: [CodingTools],
          threadInstructions: "You teach one skill on your own GPU: write a reward, train with `pi-run <skill> -- python train.py`, read skill.json, report.",
          ...(a["deadline-ms"] ? { threadDeadlineMs: Number(a["deadline-ms"]) } : {}),
          // The outcome from the trainer's own file, as mirrored home; never from the thread's words.
          status: async ({ skill }) => {
            const file = join(dir, "work", "skills", skill, "skill.json");
            if (!existsSync(file)) return undefined;
            const s = JSON.parse(readFileSync(file, "utf8"));
            return s.status === "done" ? { status: "passed" as const, checkpoint: s.passed_at, seconds: Math.round(s.wall_s) } : s.status === "failed" ? { status: "never-passed" as const } : undefined;
          },
        },
      }
    : {}),
  boxes: pool,
  // D2's assemble-skills, faked: every skill whose mirrored skill.json says done goes into home/skills.json.
  assemble: async () => {
    if (a["assemble-fails"]) throw new Error("assemble-skills exited 1");
    const work = join(dir, "work", "skills");
    const done = (existsSync(work) ? readdirSync(work) : []).filter((skill) => {
      const file = join(work, skill, "skill.json");
      return existsSync(file) && JSON.parse(readFileSync(file, "utf8")).status === "done";
    }).sort((x, y) => SKILLS.indexOf(x as never) - SKILLS.indexOf(y as never));
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home", "skills.json"), JSON.stringify({ version: 1, skills: Object.fromEntries(done.map((s) => [s, { label: s }])) }));
    say({ event: "home.assembled", skills: done });
    return { home: done };
  },
  artifacts: ({ boxId, skill }) => {
    const sync = new FakeArtifacts(join(pool.boxDir(boxId), "workspace", "skills", skill), join(dir, "work", "skills", skill));
    artifacts.push(sync);
    return sync;
  },
});
const registry = createRegistry();
registry.install(teach);
registry.install(thread);
if (a.plan) registry.install(CodingTools); // the threads select it; the session's default stays [teach]
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

function boxCheckpoints(): number {
  const boxes = join(dir, "boxes");
  if (!existsSync(boxes)) return 0;
  let n = 0;
  for (const b of readdirSync(boxes)) {
    const skills = join(boxes, b, "workspace", "skills");
    if (!existsSync(skills)) continue;
    for (const s of readdirSync(skills)) {
      const c = join(skills, s, "checkpoints");
      if (existsSync(c)) n += readdirSync(c).length;
    }
  }
  return n;
}

if (mode === "abort") {
  // Abort the whole run while the threads train: every mirror must stop and every box must come back.
  const submission = await root.submit({ type: "input", content: "Teach it to move.", requestId: "teach-1" }, context);
  while ([...lastCheckpoint.values()].reduce((n, c) => n + c, 0) < 10) await new Promise((r) => setTimeout(r, 25));
  const teachTask = (await graph()).find((t) => t.kind === "robot.teach-skills")!;
  const mirrorsBefore = FakeArtifacts.active;
  await harness.abortTask(teachTask.id as never, context);
  const settled = await submission.wait(context);
  await harness.waitForIdle(context);
  await new Promise((r) => setTimeout(r, 600)); // longer than a mirror's interval: a leaked one would still be counted
  const threads = (await harness.waitForTask(teachTask.id as never, context)).state.outcome.status;
  writeFileSync(join(dir, "abort-report.json"), JSON.stringify({ mirrorsBefore, mirrorsAfter: FakeArtifacts.active, teach: threads, submission: settled.status, tasks_after: await graph() }, null, 1));
  await harness.close(context);
  process.exit(0);
} else if (mode === "first") {
  const submission = await root.submit({ type: "input", content: "Teach it to move.", requestId: "teach-1" }, context);
  say({ event: "submitted", submission: submission.id });
  // Tell the orchestrator when the threads are mid-run: some skills passed, most still training.
  const timer = setInterval(async () => {
    // Mid-run: half of all the checkpoints the threads will write (some skills passed, others still training).
    const counts = a.plan ? [boxCheckpoints()] : [...lastCheckpoint.values()];
    if (counts.reduce((n, c) => n + c, 0) >= (a.plan ? 8 : mid)) {
      clearInterval(timer);
      const tasks = await graph();
      writeFileSync(join(dir, "mid.json"), JSON.stringify({ t: Date.now() - T0, checkpoints: Object.fromEntries([...lastCheckpoint].map(([k, v]) => [label.get(k), v])), tasks }, null, 1));
      say({ event: "mid", tasks: tasks.length });
    }
  }, 50);
  // The orchestrator kills this process at the mid point. A run that settles first never reached it: exit with an
  // error rather than wait for a kill that will not come.
  await submission.wait(context);
  if (!existsSync(join(dir, "mid.json"))) {
    say({ event: "error", message: `the run settled before the mid point (${mid} checkpoints)` });
    process.exit(1);
  }
  await new Promise(() => {});
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
      const tools = own.map((e) => e.model?.[0] as { role?: string; toolName?: string; isError?: boolean } | undefined).filter((m) => m?.role === "toolResult").map((m) => `${m!.toolName}${m!.isError ? "!" : ""}`);
      children.push({ id: r.id, parent: r.parent, owner: r.owner, box: { ...(await tx.doc(RobotBox, r.id)) }, ownEntries: own.length, kinds: own.map((e) => e.kind), tools });
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
