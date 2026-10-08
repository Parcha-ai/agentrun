// An app module for `pi-durable-disk run --app` in the P8 live suite: the lifecycle app of test/_lifecycle.ts (a
// flaky model that errors once, tools that block until the run stops, a gate tool) on pi-ai's faux model. Its counters
// survive incarnations through $PDA_TEST_OUT/<run>.jsonl, outside the mount: every change is one JSON line
// `{"ev":"count","field":...,"value":...,"pid":...,"t":...}`, and each open adds `{"ev":"opened",...}`.
//   PDA_TEST_RETRY_MS  the flaky model's retry backoff (default 5 minutes)
//   PDA_TEST_WAKE      "refuse": the wake hook refuses, so a parking run must stay up
// The gate tool returns once $PDA_TEST_OUT/<run>.gate exists. Each open also writes work/notes/opened-g<n>.txt and points
// the symlink work/latest at it, so the workspace has something to carry (a fork copies it).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext, AppOptions } from "../../src/app.ts";
import { lifecycleApp, newCounters, type Counters } from "../_lifecycle.ts";

export default async function app(where: AppContext): Promise<AppOptions> {
  const out = join(process.env.PDA_TEST_OUT!, `${where.ref.id}.jsonl`);
  const note = (line: Record<string, unknown>) => appendFileSync(out, `${JSON.stringify({ ...line, pid: process.pid, t: Date.now() })}\n`);
  const start = newCounters();
  if (existsSync(out)) {
    for (const l of readFileSync(out, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(l) as { ev: string; field?: keyof Counters; value?: number };
      if (e.ev === "count" && e.field) start[e.field] = e.value!;
    }
  }
  const counters = new Proxy(start, {
    set(target, field: keyof Counters, value: number) {
      target[field] = value;
      note({ ev: "count", field, value });
      return true;
    },
  });
  const gateFile = join(process.env.PDA_TEST_OUT!, `${where.ref.id}.gate`);
  const gate = new Promise<void>((resolve) => {
    const t = setInterval(() => existsSync(gateFile) && (clearInterval(t), resolve()), 100);
    t.unref();
  });
  const retryMs = Number(process.env.PDA_TEST_RETRY_MS ?? 300_000);
  const { models, registry, settings, agent } = lifecycleApp(counters, { retryMs, gate });
  return {
    models,
    registry,
    settings,
    root: { agent },
    ...(process.env.PDA_TEST_WAKE === "refuse" ? { wake: async () => Promise.reject(new Error("the wake source refused (test)")) } : {}),
    onOpen(run) {
      mkdirSync(join(run.claim.work, "notes"), { recursive: true });
      writeFileSync(join(run.claim.work, "notes", `opened-g${run.generation}.txt`), `generation ${run.generation} of ${where.ref.id}\n`);
      rmSync(join(run.claim.work, "latest"), { force: true });
      symlinkSync(`notes/opened-g${run.generation}.txt`, join(run.claim.work, "latest"));
      note({ ev: "opened", generation: run.generation, unit: run.record.holder?.unit ?? null, serve: run.record.holder?.serve ?? null });
    },
  };
}
