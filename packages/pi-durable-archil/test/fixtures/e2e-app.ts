// An app module for `pi-durable-archil run --app` in the live suite: pi-ai's faux model with pi's coding tools (no
// network, no spend). On every open it reads how far earlier incarnations got, starts a long command through pi's bash
// tool (`sleep 600`, its own process group, as every agent command), asks whether a command can use sudo (no_new_privs
// says no), then commits one tick entry every 500 ms, counting on from the last committed tick. With $PDA_TEST_RUN_MS it
// stops after that long, marks the run done, releases and exits 0. What it sees goes to $PDA_TEST_OUT/<run>.jsonl,
// outside the mount, one JSON object per line.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import type { AppContext, AppOptions } from "../../src/app.ts";
import type { DurableRun } from "../../src/run.ts";
import { ctx, scriptedHarness, startCommand } from "../_run-support.ts";

const TICK = "e2e.tick";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function entries(conversation: Conversation): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  let cursor;
  for (;;) {
    const page = await conversation.entries({}, 500, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all;
    cursor = page.next;
  }
}

/** A command through pi's bash tool in a conversation of its own; resolves with what it wrote to `file`. */
async function shell(run: DurableRun, agent: ReturnType<typeof scriptedHarness>["agent"], command: string, file: string): Promise<string> {
  const conversation = await run.harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
  await conversation.submit({ type: "input", content: `bash: ${command} > '${file}'` }, ctx);
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(20)) {
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text) return text;
    } catch {
      // not written yet
    }
  }
  throw new Error(`${command} wrote nothing to ${file}`);
}

export default async function app(where: AppContext): Promise<AppOptions> {
  const scripted = scriptedHarness();
  const out = join(process.env.PDA_TEST_OUT!, `${where.ref.id}.jsonl`);
  return {
    models: scripted.models,
    registry: scripted.registry,
    async onOpen(run) {
      const unit = String(run.record.holder?.unit ?? run.record.holder?.host ?? "?");
      const note = (ev: string, extra: Record<string, unknown> = {}) =>
        appendFileSync(out, `${JSON.stringify({ ev, t: Date.now(), generation: run.generation, unit, pid: process.pid, ...extra })}\n`);
      const conversation = await run.harness.root(ctx, { agent: scripted.agent });
      const ticks = (await entries(conversation)).filter((e) => e.kind === TICK).map((e) => (e.data as { n: number }).n);
      const from = ticks.length ? Math.max(...ticks) : 0;
      note("opened", { resumedFrom: from, ticks: ticks.length, duplicates: ticks.length - new Set(ticks).size, work: where.work === run.claim.work });
      const commandPid = await startCommand(run, scripted.agent, `long-g${run.generation}`);
      const sudo = await shell(run, scripted.agent, "sudo -n true 2>/dev/null; echo $?", join(run.claim.work, `sudo-g${run.generation}.rc`));
      // What a command can see of the mount token: the instance's stdin and a systemd credential directory.
      const stdin = await shell(run, scripted.agent, 'echo "$(readlink /proc/$PPID/fd/0) creds=${CREDENTIALS_DIRECTORY:-none}"', join(run.claim.work, `token-g${run.generation}.txt`));
      note("long-command", { commandPid, sudoExit: Number(sudo), instanceStdin: stdin });
      const until = process.env.PDA_TEST_RUN_MS ? Date.now() + Number(process.env.PDA_TEST_RUN_MS) : Number.POSITIVE_INFINITY;
      for (let n = from + 1; Date.now() < until; n++) {
        await conversation.commit(async (tx) => {
          await tx.appendEntry(conversation.id, { kind: TICK, data: { n, generation: run.generation } });
        }, ctx);
        note("tick", { n });
        await sleep(500);
      }
      await run.setStatus("done", { reason: "finished" });
      await run.release();
      note("done");
      process.exit(0);
    },
  };
}
