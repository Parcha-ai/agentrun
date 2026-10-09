// One pi-durable-disk instance on a real Archil mount, driven by the live suites over stdin and reporting on stdout,
// one JSON object per line. It holds only a single-use mount token, never the API key. The model is pi-ai's faux
// provider scripted by `scriptedReply`: "turn <n>" calls `mark_tool`, whose execute() appends one line to
// PDA_P4_EXECLOG (a file outside the mount) so a test can tell which instance ran which call; "sleeper" has pi's `bash`
// tool run `sleep 600` in a conversation of its own.
//
// Commands: {op:"mark",n} {op:"marks",from,count} {op:"turn",n,gate?} {op:"go"} {op:"sleeper"} {op:"list"}
//           {op:"idle"} {op:"release",status?} {op:"exit"}
// Environment: PDA_P4_TOKEN PDA_P4_DISK PDA_P4_REGION PDA_P4_RUN PDA_P4_MOUNT_ROOT PDA_P4_WRITER PDA_P4_EXECLOG
//              PDA_P4_LEASE (JSON LeaseOptions) PDA_P4_BLOCK_HEARTBEAT=1 (every run.json write after open hangs)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { exitCodeFor } from "../../src/errors.ts";
import { openDurableRun, type DurableRun } from "../../src/run.ts";
import { persistRecord } from "../../src/status.ts";
import { ctx, scriptedHarness, startCommand } from "../_run-support.ts";

const env = process.env;
const writer = env.PDA_P4_WRITER ?? "?";
const execLog = env.PDA_P4_EXECLOG!;
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ writer, t: Date.now(), ...event })}\n`);

// The gate holds a call between its creation and its intent commit (a `beforeTool` hook runs before intent).
let gate: { n: number; open: () => void; opened: Promise<void> } | undefined;
const markTool = defineTool({
  name: "mark_tool",
  description: "Record that this instance executed call n.",
  parameters: Type.Object({ n: Type.Number() }),
  async execute(args, api) {
    appendFileSync(execLog, `${JSON.stringify({ writer, n: args.n, callId: api.callId, pid: process.pid, t: Date.now() })}\n`);
    return { content: [{ type: "text", text: `marked ${args.n} by ${writer}` }], details: { n: args.n, writer } };
  },
});
const marks = defineExtension({
  name: "p4-marks",
  tools: [markTool],
  hooks: [
    hook(ToolTask, {
      beforeTool: async (call) => {
        const n = (call.arguments as { n?: number }).n;
        if (gate && gate.n === n) {
          emit({ ev: "gated", n });
          await gate.opened;
        }
        return undefined;
      },
    }),
  ],
});

const scripted = scriptedHarness();
scripted.registry.install(marks);

let blocked = false;
let lastSeq = 0;
const steps: Record<string, number> = {};
const t0 = performance.now();
let run: DurableRun;
try {
  run = await openDurableRun(
    { disk: env.PDA_P4_DISK!, region: env.PDA_P4_REGION!, id: env.PDA_P4_RUN! },
    {
      mountToken: env.PDA_P4_TOKEN!,
      mountRoot: env.PDA_P4_MOUNT_ROOT!,
      harness: { models: scripted.models, registry: scripted.registry },
      ...(env.PDA_P4_LEASE ? { lease: JSON.parse(env.PDA_P4_LEASE) } : {}),
      persist: (root, text, signal) => (blocked ? new Promise<void>(() => {}) : persistRecord(root, text, signal)),
      onStep: (step, ms) => void (steps[step] = Math.round(ms * 100) / 100),
    },
  );
} catch (error) {
  const e = error as { code?: string; message?: string };
  emit({ ev: "open-failed", code: e.code, exitCode: exitCodeFor(error), message: e.message, steps });
  process.exit(exitCodeFor(error));
}
delete env.PDA_P4_TOKEN;
run.harness.subscribeCommits((publication) => void (lastSeq = Math.max(lastSeq, publication.seq)));
const conversation: Conversation = await run.harness.root(ctx, { agent: scripted.agent });
if (env.PDA_P4_BLOCK_HEARTBEAT === "1") blocked = true;
emit({ ev: "open", generation: run.generation, openMs: Math.round(performance.now() - t0), steps, record: run.record, pid: process.pid });

async function mark(n: number): Promise<void> {
  await conversation.commit(async (tx) => {
    await tx.appendEntry(conversation.id, { kind: "p4.mark", data: { n, writer, generation: run.generation } });
  }, ctx);
  emit({ ev: "marked", n, seq: lastSeq });
}

async function entries(): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  let cursor;
  for (;;) {
    const page = await conversation.entries({}, 500, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all;
    cursor = page.next;
  }
}

async function handle(command: { op: string; n?: number; from?: number; count?: number; gate?: boolean; status?: "done" | "paused" }): Promise<void> {
  switch (command.op) {
    case "mark":
      return mark(command.n!);
    case "marks":
      for (let i = 0; i < command.count!; i++) await mark(command.from! + i);
      return;
    case "turn": {
      const n = command.n!;
      if (command.gate) {
        let open!: () => void;
        const opened = new Promise<void>((resolve) => (open = resolve));
        gate = { n, open, opened };
      }
      const submission = await conversation.submit({ type: "input", content: `turn ${n}` }, ctx);
      emit({ ev: "submitted", n, seq: lastSeq });
      void submission.wait(ctx).then(
        (settled) => emit({ ev: "turned", n, status: settled.status }),
        (error: unknown) => emit({ ev: "turn-failed", n, message: String(error) }),
      );
      return;
    }
    case "go":
      emit({ ev: "going" });
      gate?.open();
      return;
    case "sleeper":
      return void emit({ ev: "sleeper", pid: await startCommand(run, scripted.agent, `sleeper-${writer}`) });
    case "list": {
      const items = await entries();
      const integrity = await run.store.database.get<{ integrity_check: string }>("PRAGMA integrity_check");
      emit({
        ev: "list",
        marks: items.filter((e) => e.kind === "p4.mark").map((e) => e.data),
        toolResults: items.filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model ?? e.data)),
        integrity: integrity?.integrity_check,
        seq: lastSeq,
      });
      return;
    }
    case "idle":
      await run.harness.waitForIdle(ctx);
      return void emit({ ev: "idle", seq: lastSeq });
    case "release": {
      if (command.status) await run.setStatus(command.status);
      const r0 = performance.now();
      await run.release();
      emit({ ev: "released", record: run.record, releaseMs: Math.round(performance.now() - r0) });
      process.exit(0);
    }
    case "exit":
      process.exit(0);
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const command = JSON.parse(line) as Parameters<typeof handle>[0];
  handle(command).catch((error: unknown) => emit({ ev: "error", op: command.op, code: (error as { code?: string }).code, message: String(error) }));
}
