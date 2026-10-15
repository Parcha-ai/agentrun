// Audit across crashes: a run is killed twice, and what each incarnation did is read back from the store alone.
//
// `beforeResume` hands an app the store the Harness was opened over, read-only (`storage`), and its last committed
// sequence (`head`). A recorder there snapshots every conversation, task, document and transcript entry at that head, so
// the snapshot taken by generation N is the exact state generations 1 to N-1 left behind. Nothing else is logged: the
// account at the end is the difference between consecutive snapshots, and the supervisor's own stdout only counts how many
// times each call ran.
//
// One file, its own supervisor: `node examples/audit-across-crashes/main.ts` starts `main.ts instance` children, kills the
// first two while a `lookup` call is in flight, lets the third finish, then opens the run once more as an auditor whose
// snapshot is the final state.
// No disk, no key: `localRun` is a directory of this machine and pi-ai's faux model answers.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Cursor, DocumentRecord, EntryRecord, Page, Seq, TaskRecord } from "@earendil-works/pi-durable";
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";
import type { BeforeResume, StoreReads } from "@parcha/pi-durable-disk";

const QUESTIONS = ["tides", "granite", "monsoons", "lichen", "basalt", "glaciers"];
/** Generation g is killed while question KILLED_AT[g] is looking something up (the call never returns). */
const KILLED_AT: Record<number, number> = { 1: 2, 2: 4 };
const root = join(process.cwd(), "audit-across-crashes-run");
const snapshots = join(process.cwd(), "audit-across-crashes-snapshots");

interface Snapshot {
  generation: number;
  head: number;
  entries: EntryRecord[];
  tasks: TaskRecord<unknown, unknown, unknown>[];
  documents: unknown[];
}
type Part = { type?: string; text?: string; id?: string; name?: string };
const parts = (entry: EntryRecord): Part[] => (entry.model ?? []).flatMap((message) => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as Part[])));
const textOf = (entry: EntryRecord): string => parts(entry).map((part) => part.text ?? "").join("");

async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

/**
 * Everything the store holds at `head`: the conversations' entries, every task, and every document of every scope. A
 * document that keeps no history reads at "current", which is its state at `head` until the hook commits something.
 */
async function snapshotAt({ storage, harness, head, generation }: BeforeResume): Promise<Snapshot> {
  const conversations = await scanAll((cursor) => storage.scanConversations({}, 100, cursor, ctx));
  const tasks = await scanAll((cursor) => storage.scanTasks({}, 100, cursor, ctx));
  const scopes: DocumentRecord["scope"][] = [{ kind: "session" }, ...conversations.map((c) => ({ kind: "conversation" as const, conversationId: c.id })), ...tasks.map((t) => ({ kind: "task" as const, taskId: t.id }))];
  const documents = [];
  for (const scope of scopes)
    for (const record of await scanAll((cursor) => storage.scanDocuments({ scope, at: head }, 100, cursor, ctx)))
      documents.push(await storage.document(record.id, record.history === "rewindable" ? head : "current", ctx));
  const entries: EntryRecord[] = [];
  for (const { id } of conversations) entries.push(...(await scanAll((cursor) => harness.conversation(id, ctx).then((conversation) => conversation!.entries({}, 100, cursor, ctx)))));
  return { generation, head, entries: entries.sort((a, b) => a.id - b.id), tasks, documents };
}

/** One incarnation of the run: the recorder in `beforeResume`, then (unless it only audits) the questions, one tool call each. */
async function incarnation(audit: boolean): Promise<void> {
  let generation = 0;
  const lookup = defineTool({
    name: "lookup",
    description: "Look a topic up.",
    parameters: Type.Object({ question: Type.Number(), topic: Type.String() }),
    async execute({ question, topic }, api) {
      console.log(`in flight: question ${question} (generation ${generation})`);
      if (KILLED_AT[generation] === question) await new Promise(() => setInterval(() => {}, 1 << 30)); // the host is killed here
      api.output(`notes on ${topic}`); // the result's text: every pi version the peers accept reads it
      return {};
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "research", tools: [lookup] }));
  const reply: FauxResponseFactory = (context) => {
    const last = context.messages.findLast((m) => (m.role as string) !== "system")!;
    const said = typeof last.content === "string" ? last.content : last.content.map((part) => ("text" in part ? part.text : "")).join("");
    if (last.role === "toolResult") return fauxAssistantMessage(last.isError ? `Generation ${generation}: the lookup was cut by a crash, so I will not guess.` : `Generation ${generation}: ${said}.`);
    const question = QUESTIONS.indexOf(/about (\w+)/.exec(said)![1]) + 1;
    return fauxAssistantMessage(fauxToolCall("lookup", { question, topic: QUESTIONS[question - 1] }, { id: `lookup-${question}` }), { stopReason: "toolUse" });
  };
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 100 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const run = await openDurableRun(
    { disk: "local", region: "local", id: "audit" },
    {
      ...localRun(root),
      harness: { models, registry },
      async beforeResume(open: BeforeResume) {
        generation = open.generation;
        writeFileSync(join(snapshots, `${String(generation).padStart(2, "0")}.json`), JSON.stringify(await snapshotAt(open)));
      },
    },
  );
  if (!audit) {
    const conversation = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
    for (const [i, topic] of QUESTIONS.entries()) {
      // The request id admits a question once: a new generation walks the list from the top and sends only what is missing.
      await (await conversation.submit({ type: "input", content: `Tell me about ${topic}`, requestId: `question-${i + 1}` }, ctx)).wait(ctx);
    }
  }
  await run.setStatus("done");
  await run.release();
}

if (process.argv[2] === "instance") {
  await incarnation(false);
  process.exit(0);
}

// The supervisor: instances on one directory, the first two killed mid-call, then the auditor.
rmSync(root, { recursive: true, force: true });
rmSync(snapshots, { recursive: true, force: true });
mkdirSync(snapshots, { recursive: true });
console.log(`the run is ${root}`);
const ran: string[] = [];
for (let generation = 1; ; generation++) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "instance"], { stdio: ["ignore", "pipe", "inherit"] });
  let killed = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    console.log(line);
    if (line.startsWith("in flight: ")) ran.push(line.replace(/ \(.*/, ""));
    if (line === `in flight: question ${KILLED_AT[generation]} (generation ${generation})`) child.kill("SIGKILL"), (killed = true);
  });
  const code = await new Promise((resolve) => child.on("close", (status, signal) => resolve(signal ?? status)));
  if (code === 0) break;
  if (!killed) {
    console.error(`not ok: generation ${generation} exited by itself (${code})`);
    process.exit(1);
  }
  console.log(`generation ${generation} was killed (${code})`);
}
await incarnation(true);

// The account: what a generation did is what its successor's snapshot holds that its own did not.
const taken: Snapshot[] = readdirSync(snapshots).sort().map((file) => JSON.parse(readFileSync(join(snapshots, file), "utf8")));
if (taken.length !== 4) {
  console.error(`not ok: expected one snapshot per generation (three instances and the auditor), found ${taken.length}`);
  process.exit(1);
}
const callsInFlight = (snapshot: Snapshot) => snapshot.tasks.filter((task) => task.kind === "pi.tool" && task.state.status !== "terminal").map((task) => (task.input as { callId: string }).callId);
const interrupted = (entry: EntryRecord) => (entry.data as { diagnostics?: { code: string }[] } | undefined)?.diagnostics?.some((d) => d.code === "interrupted") === true;
const lineOf = (entry: EntryRecord): string => {
  const call = parts(entry).find((part) => part.type === "toolCall");
  if (entry.kind === "pi.user") return `question: ${textOf(entry)}`;
  if (entry.kind === "pi.assistant") return call ? `called ${call.name} as ${call.id}` : `answered: ${textOf(entry)}`;
  return `${(entry.model?.[0] as { toolCallId?: string })?.toolCallId ?? entry.kind} ${interrupted(entry) ? "settled as interrupted, never run again" : `returned: ${textOf(entry)}`}`;
};
console.log(`\nthe account, read from ${taken.length} snapshots the store gave before each resume (the last is the auditor's):`);
const by: { generation: number; entries: EntryRecord[]; cut: string[] }[] = [];
for (const [i, snapshot] of taken.slice(0, -1).entries()) {
  const seen = new Set(snapshot.entries.map((entry) => entry.id));
  const next = taken[i + 1];
  // The system prompt entry is the Harness's, not something a generation did.
  by.push({ generation: snapshot.generation, entries: next.entries.filter((entry) => !seen.has(entry.id) && entry.kind !== "pi.system"), cut: callsInFlight(next) });
}
for (const { generation, entries, cut } of by) {
  console.log(`generation ${generation}:`);
  for (const entry of entries) console.log(`  ${lineOf(entry)}`);
  if (cut.length) console.log(`  killed with ${cut.join(", ")} in flight`);
}

const failures: string[] = [];
const expect = (ok: boolean, what: string) => ok || failures.push(what);
const answers = (entries: EntryRecord[]) => entries.filter((entry) => entry.kind === "pi.assistant" && !parts(entry).some((part) => part.type === "toolCall"));
const final = taken.at(-1)!.entries;
expect(taken.length === 4 && taken.every((s, i) => s.generation === i + 1 && (i === 0 || s.head > taken[i - 1].head)), `four snapshots, one per generation, heads increasing: ${taken.map((s) => `${s.generation}@${s.head}`)}`);
expect(taken[0].entries.length === 0, "generation 1 opened an empty store");
expect(JSON.stringify(by.map((g) => g.cut)) === JSON.stringify([["lookup-2"], ["lookup-4"], []]), `calls in flight at each kill: ${JSON.stringify(by.map((g) => g.cut))}`);
expect(QUESTIONS.every((_, i) => final.filter((e) => e.kind === "pi.user" && textOf(e).endsWith(QUESTIONS[i])).length === 1), "every question is in the transcript once");
expect(JSON.stringify(final.filter(interrupted).map((e) => (e.model?.[0] as { toolCallId: string }).toolCallId)) === '["lookup-2","lookup-4"]', "exactly the two cut calls are interrupted");
expect(by[1].entries.some((e) => interrupted(e) && lineOf(e).startsWith("lookup-2")) && by[2].entries.some((e) => interrupted(e) && lineOf(e).startsWith("lookup-4")), "each cut call was settled by the next generation");
expect(JSON.stringify(by.map((g) => answers(g.entries).length)) === "[1,2,3]", `answers committed by each generation: ${JSON.stringify(by.map((g) => answers(g.entries).length))}`);
expect(by.every((g) => answers(g.entries).every((entry) => textOf(entry).startsWith(`Generation ${g.generation}:`))), "each answer is in the account of the generation that wrote it");
expect(QUESTIONS.every((_, i) => ran.filter((line) => line === `in flight: question ${i + 1}`).length === 1), `each call ran once: ${ran}`);
if (failures.length) {
  console.error(`not ok: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("ok: the store alone shows three generations, two calls cut mid-flight, each settled as interrupted by the next generation and never run again");
