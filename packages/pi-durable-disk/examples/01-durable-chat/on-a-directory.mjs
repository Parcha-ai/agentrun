// A durable chat on a directory of this machine: no disk, no key (pi-ai's faux model answers). One process answers the
// first messages and is killed (SIGKILL) after its third answer; a second opens the same run and answers the rest, and
// the transcript, read back from the store, has every message answered once. One machine: the directory is the claim.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";

const MESSAGES = ["Where does your transcript live?", "What happens if this process is killed now?", "Who answers after that?", "What was my first question?", "Are you the same process?", "Say goodbye."];
const root = join(process.cwd(), "chat-run");
const text = (message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));

if (process.argv[2] === "instance") {
  let generation = 0;
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 100 }, () => (context) => {
    const asked = context.messages.filter((message) => message.role === "user");
    return fauxAssistantMessage(`Answer ${asked.length}, by generation ${generation}: "${text(asked.at(-1))}"`);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const run = await openDurableRun({ disk: "local", region: "local", id: "chat" }, { ...localRun(root), harness: { models, registry: createRegistry() } });
  generation = run.generation;
  const model = faux.getModel();
  const chat = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const answers = async () => (await chat.entries({}, 100, undefined, ctx)).items.reverse().filter((entry) => entry.kind === "pi.assistant");
  const before = (await answers()).length;
  console.log(`generation ${generation} opened the run in ${root} (${before} answered before)`);
  for (const [i, content] of MESSAGES.entries()) {
    // The request id makes a message a no-op once it was admitted: a new generation walks the list from the top.
    await (await chat.submit({ type: "input", content, requestId: `message-${i + 1}` }, ctx)).wait(ctx);
    if (i >= before) console.log(`generation ${generation} answered message ${i + 1}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const answer of await answers()) console.log(`  ${text(answer.model[0])}`);
  await run.setStatus("done");
  await run.release();
  process.exit(0);
}

// The supervisor: an instance, killed after its third answer, then another on the same directory (a fresh one each time).
rmSync(root, { recursive: true, force: true });
const start = () => spawn(process.execPath, [fileURLToPath(import.meta.url), "instance"], { stdio: ["ignore", "pipe", "inherit"] });
const first = start();
first.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (/answered message 3\b/.test(String(chunk))) first.kill("SIGKILL");
});
await new Promise((resolve) => first.on("exit", resolve));
console.log("the first process was killed (SIGKILL); a second opens the same run");
let output = "";
const second = start();
second.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
const code = await new Promise((resolve) => second.on("exit", resolve));
const answered = [...output.matchAll(/^ {2}Answer (\d+), by generation (\d+)/gm)].map((match) => ({ n: Number(match[1]), generation: Number(match[2]) }));
const once = MESSAGES.every((_, i) => answered.filter((a) => a.n === i + 1).length === 1) && answered.length === MESSAGES.length;
const generations = [...new Set(answered.map((a) => a.generation))].sort();
if (code !== 0 || !once || generations.length < 2) {
  console.error(`not ok: exit ${code}, answers ${JSON.stringify(answered)}`);
  process.exit(1);
}
console.log(`ok: ${MESSAGES.length} messages answered once each, by generations ${generations.join(" and ")}, from the store in ${root}`);
