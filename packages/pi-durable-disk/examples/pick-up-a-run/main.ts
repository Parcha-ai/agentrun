// Pick up a run: a run is a directory, and whatever process opens it carries on where the last one released it. No disk, no
// key (pi-ai's faux model answers). Three processes, one after another, each open the same run, answer one question of the
// same chat and release it; the last still knows the first question, because the chat is in the directory, not in a process.
// One machine: the directory is the claim.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { localRun, openDurableRun, readLocalRunStatus } from "@parcha/pi-durable-disk";

const QUESTIONS = ["Where does your transcript live?", "Who had this run before you?", "Do you remember my first question?"];
const root = join(process.cwd(), "pick-up-a-run-run");
const text = (message: { content: unknown }): string =>
  typeof message.content === "string" ? message.content : (message.content as { text?: string }[]).map((part) => part.text ?? "").join("");

if (process.argv[2] === "instance") {
  let generation = 0;
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 100 }, () => (context) => {
    const asked = context.messages.filter((message) => message.role === "user");
    return fauxAssistantMessage(`Answer ${asked.length}, by generation ${generation}. You first asked: "${text(asked[0]!)}"`);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const run = await openDurableRun({ disk: "local", region: "local", id: "chat" }, { ...localRun(root), harness: { models, registry: createRegistry() } });
  generation = run.generation;
  const model = faux.getModel();
  const chat = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const answers = async (): Promise<EntryRecord[]> => [...(await chat.entries({}, 100, undefined, ctx)).items].reverse().filter((entry) => entry.kind === "pi.assistant");
  const n = (await answers()).length + 1; // the next question: this process answers one and lets go
  console.log(`generation ${generation} opened the run (${n - 1} answered before)`);
  await (await chat.submit({ type: "input", content: QUESTIONS[n - 1], requestId: `question-${n}` }, ctx)).wait(ctx);
  console.log(`  ${QUESTIONS[n - 1]}\n  ${text((await answers()).at(-1)!.model![0]!)}`);
  await run.setStatus(n === QUESTIONS.length ? "done" : "paused");
  await run.release();
  process.exit(0);
}

// The supervisor: one process per question, one after another, on the same directory. It reads whole lines, and waits for
// `close` (the process gone and all its output read), not `exit`.
rmSync(root, { recursive: true, force: true });
console.log(`the run is ${root}`);
const output: string[] = [];
for (const [i] of QUESTIONS.entries()) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "instance"], { stdio: ["ignore", "pipe", "inherit"] });
  createInterface({ input: child.stdout }).on("line", (line) => {
    console.log(line);
    output.push(line);
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (code !== 0) {
    console.error(`not ok: the process for question ${i + 1} exited ${code}`);
    process.exit(1);
  }
}
const opened = output.flatMap((line) => /^generation (\d+) opened the run \((\d+) answered before\)$/.exec(line)?.slice(1).map(Number) ?? []);
const status = await readLocalRunStatus(root); // the run's record, read from outside, with no process running
const remembered = output.at(-1)?.includes(`You first asked: "${QUESTIONS[0]}"`);
if (opened.join() !== "1,0,2,1,3,2" || !remembered || status?.status !== "done" || status.generation !== 3) {
  console.error(`not ok: opened ${JSON.stringify(opened)}, remembered ${remembered}, status ${JSON.stringify(status && [status.status, status.generation])}`);
  process.exit(1);
}
console.log(`ok: three processes, one run: each picked up where the last released it, the last still knew the first question, and the run reads done at generation 3 (${root})`);
