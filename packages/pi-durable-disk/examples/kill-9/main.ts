// A coding agent that survives kill -9, on a directory of this machine: no disk, no key (pi-ai's faux model plays the
// agent). The agent writes files in work/, is refused a write outside work/, and runs a long bash command. The process is
// SIGKILLed in the middle of that command. A second process opens the same run: the open ends the command the first left
// running, the files are intact, the cut command comes back `interrupted` and is never run again, and the agent goes on to the end.
//
//   node examples/kill-9/main.ts     (from packages/pi-durable-disk, after `npm run build` at the repository root)
//
// One file is both the supervisor (no argument) and the agent process (`instance`). One machine: the directory is the claim.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import { ArchilCodingTools, localRun, openDurableRun } from "@parcha/pi-durable-disk";

const root = join(process.cwd(), "kill-9-run");
const work = join(root, "work");
const TASK = "Write the plan and the notes, then run the long job and report how it went.";
// The long command: it notes its pid, logs that it started, sleeps far longer than this example runs, and would log that it finished.
const LONG_JOB = "echo $$ > job.pid; echo started >> progress.log; sleep 120; echo finished >> progress.log";
const FINISHED = "The job was cut and never rerun; the plan and the notes are intact.";

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";

/** The conversation's entries, oldest first. */
async function transcript(conversation: Conversation): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  for (let cursor: JsonObject | undefined; ; ) {
    const page = await conversation.entries({}, 500, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all.reverse();
    cursor = page.next;
  }
}

/** What each tool call came to, read from the store: the tool, whether it failed, and its text. */
async function toolResults(conversation: Conversation): Promise<{ name: string; isError: boolean; text: string }[]> {
  return (await transcript(conversation))
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => {
      const result = (entry as unknown as { model: { toolName: string; isError: boolean; content: unknown }[] }).model[0]!;
      return { name: result.toolName, isError: result.isError, text: textOf(result.content) };
    });
}

/** The agent's last answer, read from the store. */
async function lastAnswer(conversation: Conversation): Promise<string> {
  const answers = (await transcript(conversation)).filter((entry) => entry.kind === "pi.assistant");
  return textOf((answers.at(-1) as unknown as { model: { content: unknown }[] } | undefined)?.model[0]?.content);
}

if (process.argv[2] === "instance") {
  // The scripted agent decides each step from what the conversation holds, so a process that opens the run later goes on
  // from the same place: it counts the tool results it has been given.
  const steps = [
    () => fauxToolCall("write", { path: "plan.txt", content: "1. write the notes\n2. run the long job\n3. report\n" }, { id: "call-plan" }),
    () => fauxToolCall("write", { path: "notes.txt", content: "the notes the job will read\n" }, { id: "call-notes" }),
    () => fauxToolCall("write", { path: "../escaped.txt", content: "outside work/" }, { id: "call-escape" }), // the file tools stay in work/
    () => fauxToolCall("bash", { command: LONG_JOB }, { id: "call-job" }),
  ];
  const reply: FauxResponseFactory = (context) => {
    const done = context.messages.filter((message) => message.role === "toolResult").length;
    const step = steps[done];
    return step ? fauxAssistantMessage(step(), { stopReason: "toolUse" }) : fauxAssistantMessage(FINISHED);
  };
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 100 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(ArchilCodingTools);
  const run = await openDurableRun({ disk: "local", region: "local", id: "kill-9" }, { ...localRun(root), harness: { models, registry } });
  const model = faux.getModel();
  const agent = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  console.log(`generation ${run.generation} opened the run in ${root} (${(await toolResults(agent)).length} tool results before)`);
  // The request id admits the task once: a process that opens the run again does not start it a second time, it waits for it.
  const submission = await agent.submit({ type: "input", content: TASK, requestId: "task-1" }, ctx);
  await submission.wait(ctx);
  for (const result of await toolResults(agent)) console.log(`  ${result.name}${result.isError ? " [error]" : ""}: ${result.text.replace(/<\/?harness>/g, "").replace(/\s+/g, " ").trim().slice(0, 140)}`);
  console.log(`agent: ${await lastAnswer(agent)}`);
  await run.setStatus("done");
  await run.release();
  process.exit(0);
}

// The supervisor. pi starts each command as the leader of its own process group, so a bare `kill -9` of the agent's process
// leaves the command running. On a host the unit's cgroup ends it; on a local directory the package does, at the next open
// (the run's `commands/` records what each instance started). The supervisor kills the instance process and nothing else; the
// instances stay in the supervisor's own process group, so whatever ends the supervisor's group ends them too.
rmSync(root, { recursive: true, force: true });
console.log(`the run lives in ${root}`);
const start = (): ChildProcess => spawn(process.execPath, [fileURLToPath(import.meta.url), "instance"], { stdio: ["ignore", "pipe", "inherit"] });
const eachLine = (child: ChildProcess, onLine: (line: string) => void): void => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    console.log(line);
    onLine(line);
  });
};
const closed = (child: ChildProcess) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
const started: ChildProcess[] = [];
/** Ends every process this example started, and the long command (its pid is in work/job.pid): on success, on failure and when this process is killed. */
const endAll = (): void => {
  for (const child of started) {
    child.kill("SIGKILL");
  }
  try {
    process.kill(-Number(readFileSync(join(work, "job.pid"), "utf8")), "SIGKILL");
  } catch {
    // no command started, or it is already gone
  }
};
process.on("exit", endAll);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(signal === "SIGINT" ? 130 : 143)); // the exit hook ends everything this example started
const fail = (message: string): never => {
  console.error(`not ok: ${message}`);
  process.exit(1);
};

const first = start();
started.push(first);
eachLine(first, () => undefined);
const firstClosed = closed(first);
// The long command has started once the file it writes first has a line in it, and the package has recorded it (the instance
// notes the commands it runs a tenth of a second after they start; a kill before that could miss one).
const progress = join(work, "progress.log");
const recorded = () => existsSync(join(root, "commands")) && readdirSync(join(root, "commands")).some((name) => name.endsWith(".json"));
for (let waited = 0; !(existsSync(progress) && readFileSync(progress, "utf8").includes("started") && recorded()); waited += 25) {
  if (waited > 30_000) fail("the long command never started");
  await new Promise((resolve) => setTimeout(resolve, 25));
}
console.log("the long command is running: SIGKILL to the first process (its command is not touched)");
first.kill("SIGKILL");
const cut = await firstClosed;
const job = Number(readFileSync(join(work, "job.pid"), "utf8"));
/** Whether the command's process group still has a live member: a zombie waiting for a parent that does not reap (a container's pid 1) is not running. */
const running = (): boolean => {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(join("/proc", entry, "stat"), "utf8");
      const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "pid (comm) ": state, ppid, pgrp
      if (Number(group) === job && state !== "Z") return true;
    } catch {
      // the process ended while it was read
    }
  }
  return false;
};
console.log(`the first process ended (${cut.signal ?? `exit ${cut.code}`}); its command is ${running() ? "still running: a bare kill -9 does not end it" : "gone"}; a second process opens the same run`);

const lines: string[] = [];
const second = start();
started.push(second);
eachLine(second, (line) => lines.push(line));
const secondClosed = closed(second);
// A command that was run again would sleep for two minutes: the second process gets one.
const timer = setTimeout(endAll, 60_000);
const ended = await secondClosed;
clearTimeout(timer);

const results = lines.flatMap((line) => {
  const match = /^ {2}(\w+)( \[error\])?: (.*)$/.exec(line);
  return match ? [{ name: match[1]!, isError: match[2] !== undefined, text: match[3]! }] : [];
});
const bash = results.filter((result) => result.name === "bash");
const generation = /^generation (\d+) opened/.exec(lines[0] ?? "")?.[1];
const read = (file: string) => (existsSync(join(work, file)) ? readFileSync(join(work, file), "utf8") : null);
const problems = [
  cut.signal !== "SIGKILL" && `the first process was not killed by SIGKILL (${cut.signal ?? `exit ${cut.code}`})`,
  ended.code !== 0 && `the second process exited ${ended.code ?? ended.signal}`,
  generation !== "2" && `the second process opened generation ${generation}`,
  read("plan.txt") !== "1. write the notes\n2. run the long job\n3. report\n" && "plan.txt is not intact",
  read("notes.txt") !== "the notes the job will read\n" && "notes.txt is not intact",
  read("progress.log") !== "started\n" && `progress.log is ${JSON.stringify(read("progress.log"))}: the long command ran again, or finished`,
  running() && "the cut command was still running after the second open",
  bash.length !== 1 && `${bash.length} bash results in the store, expected 1`,
  !(bash[0]?.isError && /interrupted/.test(bash[0].text)) && `the cut command did not come back interrupted (${JSON.stringify(bash[0])})`,
  existsSync(join(root, "escaped.txt")) && "a file was written outside work/",
  !results.some((result) => result.name === "write" && result.isError) && "the write outside work/ was not refused",
  !lines.includes(`agent: ${FINISHED}`) && "the agent did not finish",
].filter((problem): problem is string => typeof problem === "string");
if (problems.length > 0) fail(problems.join("; "));
console.log(`ok: after kill -9 the files were intact, the next open ended the cut command and it came back interrupted without a rerun, the agent finished in generation 2, and its file tools stayed in work/`);
