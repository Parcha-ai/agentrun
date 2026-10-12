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
import { TRAIN_SOP } from "../sop.ts";
import { RobotBox, SKILLS, teachSkills, threadsOf, type TrainProgress } from "../teach-skills.ts";
import { EXAMPLES, FakeArtifacts, FakeBoxEnv, FakePool, MAX_CHECKPOINTS, PASS_AT } from "./fake-cluster.ts";

const { values: a } = parseArgs({ options: { dir: { type: "string" }, mode: { type: "string" }, tick: { type: "string", default: "700" }, capacity: { type: "string", default: "8" }, "done-before": { type: "string" }, "assemble-fails": { type: "boolean", default: false }, plan: { type: "boolean", default: false }, "deadline-ms": { type: "string" }, "status-throws": { type: "boolean", default: false }, "new-skill": { type: "boolean", default: false } } });
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
  a["new-skill"]
    ? { name: "wag-tail", brief: "Wag the tail side to side while standing: a tail swing of at least 0.3 rad with 8 side changes. Stop after 2 runs." }
    : { name: "wave", brief: "Lift one front leg and wave it while standing on the others for 3 s. Stop after 2 runs." },
];
/** For a skill the library does not have, the library skill a thread starts from (train-skill.md step 2). */
const CLOSEST: Readonly<Record<string, string>> = { "wag-tail": "wave" };
const planThread = (msgs: { role: string; toolName?: string; content?: unknown }[]) => {
  let u = -1;
  msgs.forEach((m, i) => { if (m.role === "user") u = i; });
  const skill = /Your skill: ([\w-]+)/.exec(u >= 0 ? textOf(msgs[u]!) : "")?.[1];
  if (!skill) return undefined;
  const after = msgs.slice(u + 1);
  const results = after.filter((m) => m.role === "toolResult") as { role: string; toolName?: string; isError?: boolean; content?: unknown }[];
  const texts = results.map((r) => textOf(r));
  // TRAIN_SOP's steps with D2's library: copy the worked skill and train (or write a new one and compile first), train at 12M, read why a try did not pass, train
  // at 40M if it was still changing, --check a pass, read the trainer's skill.json, report.
  const run = `pi-run ${skill} -- train-skill --skill-dir /workspace/skills/${skill} --body /workspace/robot --out /workspace/runs/${skill} --init-from ''`;
  const bash = (command: string) => toolUse("bash", { command });
  const example = EXAMPLES[skill];
  if (example !== undefined) {
    // One of the library's worked skills: its files are the skill. Copy them and train; nothing is written or edited.
    if (results.length === 0) return bash(`mkdir -p skills && cp -r /opt/pda/train/skills/${example} skills/${skill}`);
  } else {
    // Not in the library: copy the closest library skill, then edit its skill.json and test.py and add one reward term.
    const from = CLOSEST[skill] ?? "walk";
    const edits = results.filter((r) => r.toolName === "edit").length;
    const writes = results.filter((r) => r.toolName === "write").length;
    if (results.length === 0) return bash(`mkdir -p skills && cp -r /opt/pda/train/skills/${EXAMPLES[from]} skills/${skill}`);
    if (edits === 0) return toolUse("edit", { path: `skills/${skill}/skill.json`, edits: [{ oldText: `"name":"${from}","label":"${from}"`, newText: `"name":"${skill}","label":"wag its tail"` }, { oldText: '"reward_scales":{"feet_air_time":1}', newText: '"reward_scales":{"feet_air_time":0,"tail_wag":3}' }] });
    if (edits === 1) return toolUse("edit", { path: `skills/${skill}/test.py`, edits: [{ oldText: `    return r.fell_at is None, {"name": "${from}", "value": 0, "unit": "", "target": ">= 1.0"}`, newText: '    a = r.joint("tail0_j")[100:]\n    a = a - a.mean()\n    swings = int(((a[1:] > 0) != (a[:-1] > 0)).sum())\n    amp = float(a.max() - a.min())\n    ok = r.fell_at is None and amp >= 0.3 and swings >= 8 and r.total_mps() <= 0.15\n    return ok, {"name": "tail swing", "value": round(amp, 2), "unit": "rad", "target": ">= 0.3"}' }] });
    if (writes === 0) return toolUse("write", { path: `skills/${skill}/reward.py`, content: 'import jax.numpy as jp\n\n\ndef terms(s):\n    target = 0.3 * jp.sin(2 * jp.pi * 1.0 * s.time)\n    return {"tail_wag": jp.exp(-((s.joint("tail0_j") - target) / 0.3) ** 2)}\n' });
  }
  // A command the host's restart interrupted is run again (pi-run stops the old one on the box first).
  const last = results[results.length - 1];
  if (last?.toolName === "bash" && last.isError && /interrupt/i.test(textOf(last)) && results.length < 16) {
    const call = [...after].reverse().find((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as { type: string }[]).some((c) => c.type === "toolCall"));
    const command = ((call?.content as { type: string; arguments?: { command?: string } }[] | undefined) ?? []).find((c) => c.type === "toolCall")?.arguments?.command;
    if (command) return bash(command);
  }
  // A library skill trains at once; a skill of its own compiles first.
  if (example === undefined && !texts.some((t) => /^compiled/m.test(t))) return bash(`${run} --compile-only`);
  const tries = texts.filter((t) => /"event":"skill\.done"/.test(t));
  const lastTry = tries[tries.length - 1];
  if (lastTry === undefined) return bash(`${run} --steps 12M --stop-after-passing 2`);
  const readSince = texts.slice(texts.lastIndexOf(lastTry) + 1);
  if (/"passed":true/.test(lastTry)) {
    if (!readSince.some((t) => /"event":"skill\.check"/.test(t))) return bash(`${run} --check /workspace/runs/${skill}/policy.json`);
  } else {
    const skillJson = readSince.find((t) => /"status"/.test(t));
    if (skillJson === undefined) return bash(`cat /workspace/runs/${skill}/skill.json`);
    if (/still changing/.test(skillJson) && tries.length < 2) return bash(`${run} --steps 40M --stop-after-passing 2`);
    if (example !== undefined && tries.length < 2) {
      // The library skill's one other retry: one reward_scales weight, edited (not rewritten), then 12M again.
      const after = results.slice(results.length - readSince.length);
      if (!after.some((r) => r.toolName === "edit")) return toolUse("edit", { path: `skills/${skill}/skill.json`, edits: [{ oldText: '"feet_air_time":1}', newText: '"feet_air_time":2}' }] });
      return bash(`${run} --steps 12M --stop-after-passing 2`);
    }
    return fauxAssistantMessage(fauxText(`I wrote ${skill}'s skill files and trained them ${tries.length} times; it never passed its test.`));
  }
  if (!readSince.some((t) => /"status"/.test(t))) return bash(`cat /workspace/runs/${skill}/skill.json`);
  return fauxAssistantMessage(fauxText(`I wrote ${skill}'s skill files, trained them, and checked the policy.`));
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
          threadInstructions: TRAIN_SOP, // the real SOP text; the scripted model follows its steps
          ...(a["deadline-ms"] ? { threadDeadlineMs: Number(a["deadline-ms"]) } : {}),
          // The outcome from the trainer's own file, as mirrored home; never from the thread's words.
          status: async ({ skill }) => {
            if (a["status-throws"]) throw new Error("skill.json is unreadable");
            const file = join(dir, "work", "skills", skill, "skill.json");
            if (!existsSync(file)) return undefined;
            const s = JSON.parse(readFileSync(file, "utf8"));
            // D2's skill.json in --out (v12): passed_at is the first passing checkpoint, an object, or null. A run that
            // never passed says why in `diagnosis`; a refused skill dir or body, or a crash, says it in `error`.
            const at = s.passed_at as { checkpoint?: number; t?: number } | null | undefined;
            if (typeof at?.checkpoint === "number") return { status: "passed" as const, checkpoint: at.checkpoint, seconds: Math.round(s.wall_s ?? at.t ?? 0) };
            if (s.status === "refused" || (s.status === "failed" && s.error)) return { status: "error" as const, reason: String(s.error) };
            if (s.status === "failed") return { status: "never-passed" as const, ...(s.diagnosis ? { reason: String(s.diagnosis) } : {}) };
            return undefined; // still training, or only compiled
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
    // Code mode mirrors the trainer's --out folder (runs/<skill>); train_skill's trainer writes into skills/<skill>.
    const sync = new FakeArtifacts(join(pool.boxDir(boxId), "workspace", a.plan ? "runs" : "skills", skill), join(dir, "work", "skills", skill));
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
    const skills = join(boxes, b, "workspace", a.plan ? "runs" : "skills");
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
      const threads = await threadsOf(harness, context); // what a viewer lists mid-run
      writeFileSync(join(dir, "mid.json"), JSON.stringify({ t: Date.now() - T0, checkpoints: Object.fromEntries([...lastCheckpoint].map(([k, v]) => [label.get(k), v])), tasks, threads }, null, 1));
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
    threads_of: await threadsOf(harness, context, { conversation: root.id }),
    tasks_after: await graph(),
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(out, null, 1));
  say({ event: "done", children: report.children.length });
  await harness.close(context);
  process.exit(0);
}
