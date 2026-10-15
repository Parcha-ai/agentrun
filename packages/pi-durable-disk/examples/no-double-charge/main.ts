// A paid call that never double-charges, across a kill -9. No disk, no key: a run in a directory of this machine
// (`localRun`) and pi-ai's faux model.
//
//   node examples/no-double-charge/main.ts
//
// A fake payment server (payments.ts) counts every charge it receives. An agent charges four invoices, one `charge`
// tool call each. The server holds invoice 2's charge without answering, and this process kills the agent (SIGKILL)
// while that charge is in flight. A second process opens the same run: pi-durable recorded the call before it went
// out, and `charge` is not replay-safe, so the cut call comes back `interrupted` instead of being sent again. The agent
// charges the rest, and the server ends with exactly one charge per invoice.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { localRun, openDurableRun } from "@parcha/pi-durable-disk";
import { startPayments } from "./payments.ts";

const INVOICES = 4;
const CUT = 2;
const root = join(process.cwd(), "no-double-charge-run");

/** A message's text. A tool result keeps its blocks in `content` up to pi 1.1 and in `output` from 1.2. */
function textOf(message: unknown): string {
  const m = message as { content?: unknown; output?: unknown };
  const blocks = m.output ?? m.content;
  return typeof blocks === "string" ? blocks : Array.isArray(blocks) ? blocks.map((b: { text?: string }) => b.text ?? "").join("") : "";
}

async function transcript(conversation: Conversation): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  for (let cursor; ; ) {
    const page = await conversation.entries({}, 500, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all.reverse();
    cursor = page.next;
  }
}

if (process.argv[2] === "instance") {
  const payments = process.argv[3]!;
  let generation = 0;
  const charge = defineTool({
    name: "charge",
    description: "Charge an invoice. Costs real money: call it once per invoice.",
    parameters: Type.Object({ invoice: Type.Number(), amount: Type.Number() }),
    // No `replay: "safe"`: a call cut in flight comes back interrupted on the next open and is never run again.
    async execute(args, api) {
      console.log(`generation ${generation}: charging invoice ${args.invoice}`);
      // The call's id is recorded before the call starts and is the same in every process: the idempotency key.
      const response = await fetch(`${payments}/charges`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": api.callId },
        body: JSON.stringify(args),
      });
      const { id } = (await response.json()) as { id: string };
      console.log(`generation ${generation}: invoice ${args.invoice} charged (${id})`);
      // The result's text, as output: pi 1.0 and 1.1 read a result's `content`, 1.2 its `output`.
      api.output(`charged invoice ${args.invoice}: ${id}`);
      return {};
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "billing", tools: [charge] }));

  // The faux model: "Charge invoice k" calls `charge` once, with a call id of its own; a result it reports, and a
  // charge that did not complete it does not try again.
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 100 }, () => (context: { messages: Message[] }) => {
    // pi 1.0 adds a system message after the user's, so the last message that counts is the last non-system one.
    const last = context.messages.findLast((m) => (m.role as string) !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage(last.isError ? `Invoice not charged: ${textOf(last)}. I will not charge it again.` : textOf(last));
    const invoice = Number(/(\d+)$/.exec(textOf(last))?.[1]);
    return fauxAssistantMessage(fauxToolCall("charge", { invoice, amount: invoice * 25 }, { id: `charge-${invoice}` }), { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const run = await openDurableRun({ disk: "local", region: "local", id: "no-double-charge" }, { ...localRun(root), harness: { models, registry } });
  generation = run.generation;
  console.log(`generation ${generation} opened the run in ${root}`);
  const agent = await run.harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  for (let invoice = 1; invoice <= INVOICES; invoice++) {
    // The request id admits an invoice once: a new generation walks the list from the top and adds only what is missing.
    await (await agent.submit({ type: "input", content: `Charge invoice ${invoice}`, requestId: `invoice-${invoice}` }, ctx)).wait(ctx);
  }
  // What the store says happened to each charge: its committed result, or `interrupted`.
  for (const entry of await transcript(agent)) {
    if (entry.kind !== "pi.tool-result") continue;
    const result = (Array.isArray(entry.model) ? entry.model[0] : entry.model) as { toolCallId: string; isError: boolean };
    const text = textOf(result).replace(/\s+/g, " ").trim();
    // An error is `interrupted` only when pi says so: any other error is not the cut call coming back.
    const outcome = !result.isError ? "charged" : /\binterrupted\b/.test(text) ? "interrupted" : "error";
    console.log(`  ${result.toolCallId}: ${outcome} (${text})`);
  }
  await run.setStatus("done");
  await run.release();
  process.exit(0);
}

// The supervisor: the payment server, an instance killed while invoice 2's charge is in flight, then a second instance on
// the same directory. It reads whole lines, waits for `close` (the process gone and its output read), not `exit`, and
// kills whatever it started if anything goes wrong.
const children = new Set<ChildProcess>();
function fail(problem: string): never {
  for (const child of children) child.kill("SIGKILL");
  console.error(`not ok: ${problem}`);
  process.exit(1);
}
setTimeout(() => fail("the example took more than 90 s"), 90_000).unref();
process.on("uncaughtException", (error) => fail(String(error)));
process.on("unhandledRejection", (error) => fail(String(error)));

rmSync(root, { recursive: true, force: true });
const payments = await startPayments(`charge-${CUT}`);
/** An instance: its output echoed a line at a time to `onLine`, and its exit code once it is gone and its output read. */
function start(onLine: (line: string) => void = () => {}): { child: ChildProcess; closed: Promise<number | null> } {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "instance", payments.url], { stdio: ["ignore", "pipe", "inherit"] });
  children.add(child);
  createInterface({ input: child.stdout! }).on("line", (line) => {
    console.log(line);
    onLine(line);
  });
  const closed = new Promise<number | null>((resolve) => child.on("close", (code) => {
    children.delete(child);
    resolve(code);
  }));
  return { child, closed };
}

const first = start();
const held = await Promise.race([payments.held, first.closed.then(() => undefined)]);
if (!held) fail(`the first process ended before invoice ${CUT}'s charge reached the payment server`);
console.log(`payment server: charge #${held.seq} for invoice ${held.invoice} received, held with no answer; killing generation 1 (SIGKILL)`);
first.child.kill("SIGKILL");
await first.closed;

const outcomes = new Map<string, string>();
const code = await start((line) => {
  const match = /^ {2}(charge-\d+): (charged|interrupted|error) /.exec(line);
  if (match) outcomes.set(match[1]!, match[2]!);
}).closed;
const charges = payments.charges.map((c) => ({ ...c }));
await payments.close();

console.log("payment server, every charge received:");
for (const c of charges) console.log(`  #${c.seq} invoice ${c.invoice}, key ${c.key}, ${c.state}`);
const problems: string[] = [];
if (code !== 0) problems.push(`the second process exited ${code}`);
for (let invoice = 1; invoice <= INVOICES; invoice++) {
  const key = `charge-${invoice}`;
  const received = charges.filter((c) => c.key === key).length;
  if (received !== 1) problems.push(`invoice ${invoice} reached the server ${received} times`);
  const expected = invoice === CUT ? "interrupted" : "charged";
  if (outcomes.get(key) !== expected) problems.push(`the run recorded ${key} as ${outcomes.get(key) ?? "nothing"}, not ${expected}`);
}
if (problems.length) fail(problems.join("; "));
console.log(`ok: no invoice was charged twice, and the charge cut by the kill came back interrupted, not sent again (${INVOICES} invoices, ${charges.length} charges at the server, invoice ${CUT} interrupted)`);
process.exit(0);
