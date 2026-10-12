// The session as a pi-durable-disk app (`pi-durable-disk run --app`), for a VM that mounts the run's Archil disk: the
// store is on that disk (the package's claim, lease and fence), the agent's tools run on the GG box through its guard
// (e2e/http-box.ts), luna is called from the VM, the edited model through the guard. The beat starts on a run's first
// open; the events go to $GG_EVENTS and the evidence to the run's work directory on the disk. The module is loaded before
// the disk is mounted, so nothing here touches the run's paths until onOpen.
//   GG_TUNNEL  the GG box's tunnel (https://...)
//   GG_KEYS    a directory with openai.key, serve.key, exec.key (the run user's own, 0400)
//   GG_EVENTS  the events file the host follows
//   GG_LUNA    default gpt-6-luna
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RemoteEnv } from "@parcha/pi-durable-disk";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";
import { boxShell, httpBox } from "./http-box.ts";
import { driveSession, sessionParts, SETTINGS } from "./session.ts";

export default async function app(where: AppContext): Promise<AppOptions> {
  const t0 = Date.now();
  const events = process.env.GG_EVENTS ?? "/var/tmp/gg-vm/events.jsonl";
  const log = (event: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ t: Math.round((Date.now() - t0) / 100) / 10, event, ...data });
    console.log(line);
    appendFileSync(events, line + "\n");
  };
  const key = (name: string) => readFileSync(join(process.env.GG_KEYS ?? "/etc/gg-onemore", `${name}.key`), "utf8").trim();
  const tunnel = (process.env.GG_TUNNEL ?? "").replace(/\/+$/, "");
  if (!tunnel) throw new Error("GG_TUNNEL names the GG box");
  const box = httpBox({ url: tunnel, key: key("exec") });
  const out = join(where.work, "gg-run");
  const host = {
    luna: { baseUrl: "https://api.openai.com/v1", modelId: process.env.GG_LUNA ?? "gpt-6-luna", apiKey: key("openai") },
    steered: { baseUrl: `${tunnel}/v1`, apiKey: key("serve"), modelId: "qwen3.5-27b" },
    shell: boxShell(box),
    out,
    control: true,
    log,
    where: "a Modal VM with the run's Archil disk mounted (the session, its store and evidence on that disk); the agent's tools on the GG box",
    toolEnv: new RemoteEnv({ box, root: "/workspace" }),
  };
  const parts = sessionParts(host);
  return {
    models: parts.models,
    registry: parts.registry,
    settings: SETTINGS,
    async onOpen(run) {
      log("vm.open", { run: where.ref.id, generation: run.generation, store: where.store, work: where.work, out });
      if (existsSync(join(out, "timeline.started"))) {
        log("vm.resumed", { note: "the beat already started in this run" });
        return;
      }
      mkdirSync(out, { recursive: true });
      appendFileSync(join(out, "timeline.started"), `${new Date().toISOString()}\n`);
      // in the background: onOpen returns, and the instance keeps the run while the beat runs in pi's own tasks
      void driveSession(run.harness, parts, host).then(
        (r) => log("done", { same_conversation: r.sameConversation, out }),
        (e) => log("vm.error", { error: String(e?.stack ?? e).slice(0, 2000) }),
      );
    },
  };
}
