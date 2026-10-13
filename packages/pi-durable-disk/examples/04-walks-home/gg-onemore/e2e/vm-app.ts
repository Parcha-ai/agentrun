// The session as a pi-durable-disk app (`pi-durable-disk run --app`), for a VM that mounts the run's Archil disk: the
// store is on that disk (the package's claim, lease and fence), the agent's shell and workspace on the VM's run directory,
// the pipeline's tools on the GG box's guard (chat/gg-extra.ts), luna called from the VM, the edited model through the
// guard. The beat starts on a run's first open; the events go to $GG_EVENTS and the evidence to the run's work directory on
// the disk. The module is loaded before the disk is mounted, so nothing here touches the run's paths until onOpen.
//   GG_KEYS    a directory with guard-url, serve-key, tools-key and openai-key (the run user's own, 0400); they stay for a restarted process
//   GG_EVENTS  the events file the host follows
//   GG_LUNA    default gpt-6-luna
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";
import { readSecrets } from "../chat/gg-extra.ts";
import { beatMarks } from "./lifecycle.ts";
import { driveSession, sessionParts, SETTINGS } from "./session.ts";

export default async function app(where: AppContext): Promise<AppOptions> {
  const t0 = Date.now();
  const events = process.env.GG_EVENTS ?? "/var/tmp/gg-vm/events.jsonl";
  const log = (event: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ t: Math.round((Date.now() - t0) / 100) / 10, event, ...data });
    console.log(line);
    appendFileSync(events, line + "\n");
  };
  const keys = process.env.GG_KEYS ?? "/etc/gg-onemore";
  const openaiKey = (await readFile(join(keys, "openai-key"), "utf8")).trim();
  const out = join(where.work, "gg-run");
  const host = {
    luna: { baseUrl: "https://api.openai.com/v1", modelId: process.env.GG_LUNA ?? "gpt-6-luna", apiKey: openaiKey },
    secrets: await readSecrets(keys),
    work: where.work,
    out,
    control: true,
    log,
    where: "a Modal VM with the run's Archil disk mounted (the session, its store, workspace and evidence on that disk); the pipeline's tools on the GG box through its guard",
  };
  const parts = await sessionParts(host);
  return {
    models: parts.models,
    registry: parts.registry,
    settings: SETTINGS,
    async onOpen(run) {
      log("vm.open", { run: where.ref.id, generation: run.generation, store: where.store, work: where.work, out });
      const marks = beatMarks(out);
      const state = marks.state();
      if (state === "finished") {
        log("done", { out, note: "the beat finished before this open" });
        return;
      }
      if (state === "interrupted") {
        // the beat's steps after the agent's turns (follow-ups, control, evidence) are plain code and do not resume
        log("vm.error", { error: "the run reopened after the beat started and before it finished: the beat was interrupted and is not resumed" });
        return;
      }
      marks.started();
      // in the background: onOpen returns, and the instance keeps the run while the beat runs in pi's own tasks
      void driveSession(run.harness, parts, host)
        .then((r) => {
          marks.finished();
          log("done", { same_conversation: r.sameConversation, out });
        })
        .catch((e) => log("vm.error", { error: String(e?.stack ?? e).slice(0, 2000) }));
    },
  };
}
