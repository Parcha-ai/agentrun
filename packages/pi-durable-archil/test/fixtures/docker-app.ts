// The app the docker live suite runs inside a container (`run --app` through dockerHost): pi-ai's faux model with pi's
// coding tools. On every open it records how far earlier incarnations got (the highest tick each generation committed),
// then what a command can and cannot reach inside the container: its uid, a file pi's write tool created (owned by the
// run user, so a command can append to it), the archil daemon's environment (it holds the mount token), the store,
// `run.json` and the run's root. It starts a long command (`sleep 600`), then commits one tick every 500 ms, counting on
// from the last committed tick. With $PDA_TEST_RUN_MS it marks the run done after that long, releases and exits 0. What it
// sees goes to $PDA_TEST_OUT/<run>.jsonl, a directory the test bind-mounts from the host.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import type { AppContext, AppOptions } from "../../src/app.ts";
import { ArchilCodingTools } from "../../src/env.ts";
import type { DurableRun } from "../../src/run.ts";
import { ctx, startCommand } from "../_run-support.ts";

const TICK = "docker.tick";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("") : "";

/** "bash: <command>" calls pi's bash tool, "write: <path>" its write tool; anything else (a tool result) answers "ok". */
const reply: FauxResponseFactory = (context) => {
  const last = context.messages.findLast((m) => (m.role as string) !== "system");
  const text = last?.role === "user" ? textOf(last.content) : "";
  const bash = /^bash: ([\s\S]*)$/.exec(text);
  if (bash) return fauxAssistantMessage(fauxToolCall("bash", { command: bash[1]! }, { id: `bash-${process.pid}-${++calls}` }), { stopReason: "toolUse" });
  const write = /^write: (\S+)$/.exec(text);
  if (write) return fauxAssistantMessage(fauxToolCall("write", { path: write[1]!, content: "written by pi's write tool\n" }, { id: `write-${process.pid}-${++calls}` }), { stopReason: "toolUse" });
  return fauxAssistantMessage("ok");
};

async function entries(conversation: Conversation): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  for (let cursor; ; ) {
    const page = await conversation.entries({}, 500, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all;
    cursor = page.next;
  }
}

async function waitForFile(file: string): Promise<string> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await sleep(20)) {
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text) return text;
    } catch {
      // not written yet
    }
  }
  throw new Error(`nothing written to ${file}`);
}

export default async function app(where: AppContext): Promise<AppOptions> {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 5_000 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const agent = { model: { provider: model.provider, modelId: model.id } };
  const registry = createRegistry();
  registry.install(ArchilCodingTools);
  const out = join(process.env.PDA_TEST_OUT!, `${where.ref.id}.jsonl`);

  /** One tool call in a conversation of its own, so the root conversation's ticks are not held up. */
  const call = async (run: DurableRun, content: string) => {
    const conversation = await run.harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
    await conversation.submit({ type: "input", content }, ctx);
  };
  // The output lands under its final name only once the command is done, so a reader never sees half of it.
  const shell = async (run: DurableRun, command: string, name: string) => {
    const file = join(run.claim.work, `${name}-g${run.generation}.out`);
    await call(run, `bash: { ${command} ; } > '${file}.part' 2>&1; mv '${file}.part' '${file}'`);
    return waitForFile(file);
  };

  return {
    models,
    registry,
    async onOpen(run) {
      const note = (ev: string, extra: Record<string, unknown> = {}) =>
        appendFileSync(out, `${JSON.stringify({ ev, t: Date.now(), generation: run.generation, host: hostname(), pid: process.pid, uid: process.getuid?.(), ...extra })}\n`);
      const conversation = await run.harness.root(ctx, { agent });
      const ticks = (await entries(conversation)).filter((e) => e.kind === TICK).map((e) => e.data as { n: number; generation: number });
      const ns = ticks.map((t) => t.n);
      const byGeneration: Record<string, number> = {};
      for (const t of ticks) byGeneration[t.generation] = Math.max(byGeneration[t.generation] ?? 0, t.n);
      const from = ns.length ? Math.max(...ns) : 0;
      note("opened", { resumedFrom: from, ticks: ns.length, duplicates: ns.length - new Set(ns).size, byGeneration });

      // What a command reaches inside the container.
      const dir = `w-g${run.generation}`;
      await call(run, `write: ${dir}/sub/by-write.txt`);
      const written = join(run.claim.work, dir, "sub", "by-write.txt");
      await waitForFile(written);
      const ownerOf = (p: string) => `${statSync(p).uid}:${statSync(p).gid}`;
      const probes = {
        commandUid: await shell(run, "id -u", "uid"),
        writeToolOwner: { dir: ownerOf(join(run.claim.work, dir)), sub: ownerOf(join(run.claim.work, dir, "sub")), file: ownerOf(written) },
        appendToWritten: await shell(run, `echo appended >> ${dir}/sub/by-write.txt && echo ok`, "append"),
        daemonEnviron: await shell(run, 'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = archil ] && { cat $p/environ >/dev/null 2>&1 && echo "read $p" || echo "denied $p"; }; done; true', "environ"),
        instanceStdin: await shell(run, 'readlink /proc/$PPID/fd/0 || echo "denied"', "stdin"),
        tokenDir: await shell(run, "ls /run/pda 2>&1 || true", "tokendir"),
        writeStore: await shell(run, "touch ../store/x 2>&1; echo rc=$?", "store"),
        appendRunJson: await shell(run, "echo x >> ../run.json 2>&1; echo rc=$?", "runjson"),
        removeRunJson: await shell(run, "rm -f ../run.json 2>&1; echo rc=$?", "rmrunjson"),
        sudo: await shell(run, "sudo -n true 2>&1; echo rc=$?", "sudo"),
        noNewPrivs: await shell(run, "grep NoNewPrivs /proc/self/status", "nnp"),
        caps: await shell(run, "grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb):' /proc/self/status | tr -s '\\t' ' ' | tr '\\n' ';'", "caps"),
        // The container holds SYS_ADMIN for the mount; none of it reaches a command.
        mount: await shell(run, "mkdir -p mnt-probe && mount -t tmpfs none mnt-probe 2>&1; echo rc=$?", "mount"),
        unshareMount: await shell(run, "unshare -m true 2>&1; echo rc=$?", "unshare-m"),
        unshareUser: await shell(run, "unshare -U -r sh -c 'mount -t tmpfs none /tmp 2>&1; echo inner=$?' 2>&1; echo rc=$?", "unshare-u"),
        nsenter: await shell(run, "nsenter -t 1 -m true 2>&1; echo rc=$?", "nsenter"),
        // A hard link to a root-owned file of the run would put it inside work/, where the file tools may write.
        protectedHardlinks: await shell(run, "cat /proc/sys/fs/protected_hardlinks", "hardlinks"),
        linkStore: await shell(run, "ln ../store/run.sqlite store-link 2>&1; echo rc=$?", "link-store"),
        linkRunJson: await shell(run, "ln ../run.json runjson-link 2>&1; echo rc=$?", "link-runjson"),
      };
      const commandPid = await startCommand(run, agent, `long-g${run.generation}`);
      note("probes", { probes, commandPid });

      const until = process.env.PDA_TEST_RUN_MS ? Date.now() + Number(process.env.PDA_TEST_RUN_MS) : Number.POSITIVE_INFINITY;
      for (let n = from + 1; Date.now() < until; n++) {
        const t0 = performance.now();
        await conversation.commit(async (tx) => {
          await tx.appendEntry(conversation.id, { kind: TICK, data: { n, generation: run.generation } });
        }, ctx);
        note("tick", { n, commitMs: Math.round((performance.now() - t0) * 100) / 100 });
        await sleep(500);
      }
      await run.setStatus("done", { reason: "finished" });
      await run.release();
      note("done");
      process.exit(0);
    },
  };
}
