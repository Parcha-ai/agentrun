// The same agent as the tab's, as the app module a host runs (`pi-durable-disk run --app cloud-app.ts`): its tools on
// the claimed mount (the package's environment), its writing tools followed by the claim's barrier, its model calls
// to DEMO_MODEL_URL. Opening the run resumes whatever the tab left unfinished.
//   DEMO_MODEL_URL  an OpenAI-compatible endpoint (`.../v1`) reachable from this host, or
//   DEMO_LINK_PORT and DEMO_LINK_TOKEN (or DEMO_LINK_TOKEN_FILE), DEMO_LINK_HOST (default 127.0.0.1): listen for the
//                   demo server's link instead, send model calls through it and stream events over it (cloud-link.ts)
//   DEMO_MODEL      the model id
//   DEMO_MODEL_KEY_FILE a file holding the model credential (a sandbox's secret placeholder), sent as a bearer token
//   DEMO_SWITCH_ID, DEMO_SWITCH_FROM, DEMO_SWITCH_PLANNED (DEMO_SWITCH_BY=agent, DEMO_SWITCH_REASON: the agent chose it): the move that brought the run here; its notice is admitted
//                   before the run resumes (environment.ts), described by this host's probe (host-probe.ts)
//   DEMO_DISPLAY    the X display of a desktop this host runs (":1"): the agent gets the computer tool for it (computer-tool.ts)
//   DEMO_APP_EXTRA  a module of the bundle that adds to the app (app-extra.ts): tools, a default tool selection, an environment wrapper
//   DEMO_EVENTS_LOG optional: a file this instance appends one JSON line to when it opens and after each commit it made
//                   (its generation, the commit's sequence, the time), the evidence that no write of it lands after a
//                   takeover
import { appendFileSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AppContext, AppOptions, DurableRun } from "@parcha/pi-durable-disk";
import { vmTrail } from "./vm-trail.ts";
import { agentModels, agentRegistry, rootAgent, SETTINGS } from "./agent.ts";
import { admitNotice } from "./environment.ts";
import { xdotoolDriver } from "./computer-driver.ts";
import { probeHost } from "./host-probe.ts";
import { startCloudLink, type CloudLink } from "./cloud-link.ts";
import type { AppExtra, AppExtraModule } from "./app-extra.ts";
import { pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureCodeRobot, type RobotFiles } from "./build-robot.ts";

export default async function app(where: AppContext): Promise<AppOptions> {
  const modelId = process.env.DEMO_MODEL;
  if (!modelId) throw new Error("DEMO_MODEL names the model");
  let baseUrl = process.env.DEMO_MODEL_URL;
  let link: CloudLink | undefined;
  const linkToken = process.env.DEMO_LINK_TOKEN ?? (process.env.DEMO_LINK_TOKEN_FILE ? readFileSync(process.env.DEMO_LINK_TOKEN_FILE, "utf8").trim() : undefined);
  if (process.env.DEMO_LINK_PORT && linkToken) {
    link = await startCloudLink({ port: Number(process.env.DEMO_LINK_PORT), host: process.env.DEMO_LINK_HOST ?? "127.0.0.1", token: linkToken });
    baseUrl = link.baseUrl;
  }
  if (!baseUrl) throw new Error("DEMO_MODEL_URL (or DEMO_LINK_PORT and DEMO_LINK_TOKEN_FILE) names how this host reaches a model");
  let extra: AppExtra = {};
  if (process.env.DEMO_APP_EXTRA) {
    const mod = (await import(pathToFileURL(process.env.DEMO_APP_EXTRA).href)) as { default?: AppExtraModule };
    if (typeof mod.default !== "function") throw new Error(`DEMO_APP_EXTRA ${process.env.DEMO_APP_EXTRA} has no default function`);
    extra = await mod.default({ link, work: where.work, log: (event, data = {}) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`) });
  }
  // Code mode (default): the run's work directory starts with a robot that is code (robot/body.mjs and its build), written only where no body exists. DEMO_ROBOT_CODE=0 turns it off.
  if (process.env.DEMO_ROBOT_CODE !== "0") await ensureCodeRobot(nodeFiles(where.work), undefined as never).catch((e) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event: "robot.seed-failed", error: String(e) })}\n`));
  let run: DurableRun | undefined;
  const durable = async () => {
    if (!run) throw new Error("the run is not open");
    await run.claim.barrier();
  };
  // The instance's own trail (slow heartbeat writes, the fence's reason, its health) goes to the server over the link as it happens: a VM that dies leaves it behind.
  const trail = vmTrail((event, data) => link?.trail(event, data));
  const registry = agentRegistry(durable, { ...(link ? { switchChannel: link.switchChannel } : {}), ...(process.env.DEMO_DISPLAY ? { computer: xdotoolDriver() } : {}) });
  extra.install?.(registry);
  return {
    registry,
    ...(extra.wrapEnv ? { wrapEnv: extra.wrapEnv } : {}),
    models: agentModels({ baseUrl, modelId, ...(process.env.DEMO_MODEL_KEY_FILE ? { apiKey: readFileSync(process.env.DEMO_MODEL_KEY_FILE, "utf8").trim() } : {}) }),
    settings: { ...SETTINGS, ...(extra.settings ?? {}) },
    root: { agent: rootAgent(modelId, { registry }) },
    onLease: trail.onLease,
    async beforeResume({ harness }) {
      const id = process.env.DEMO_SWITCH_ID;
      if (!id) return;
      const move = {
        id,
        from: process.env.DEMO_SWITCH_FROM ?? "another host",
        planned: process.env.DEMO_SWITCH_PLANNED !== "0",
        ...(process.env.DEMO_SWITCH_BY === "agent" ? { by: "agent" as const, reason: process.env.DEMO_SWITCH_REASON ?? "" } : {}),
        ...(process.env.DEMO_SWITCH_BY === "placement" ? { by: "placement" as const, reason: process.env.DEMO_SWITCH_REASON ?? "", ...(process.env.DEMO_SWITCH_PROBABILITY ? { probability: Number(process.env.DEMO_SWITCH_PROBABILITY) } : {}), ...(process.env.DEMO_SWITCH_PHASE === "start" ? { phase: "start" as const } : process.env.DEMO_SWITCH_PHASE === "done" ? { phase: "done" as const } : {}) } : {}),
      };
      await admitNotice(harness, rootAgent(modelId, { registry }), await probeHost(), move, ctx);
      // Told to the server (over the link, when there is one): the move is done, and it can time it.
      link?.notifySwitched(id);
      if (process.env.DEMO_EVENTS_LOG) appendFileSync(process.env.DEMO_EVENTS_LOG, `${JSON.stringify({ at: new Date().toISOString(), event: "notice", switchId: id, pid: process.pid })}\n`);
    },
    async onOpen(opened) {
      run = opened;
      const events = process.env.DEMO_EVENTS_LOG;
      const note = (event: string, extra: Record<string, unknown> = {}) => {
        if (events) appendFileSync(events, `${JSON.stringify({ at: new Date().toISOString(), event, run: opened.ref.id, generation: opened.generation, pid: process.pid, ...extra })}\n`);
      };
      note("open");
      trail.startHealth(5_000);
      opened.harness.subscribeCommits((publication) => note("commit", { seq: publication.seq }));
      const root = await opened.harness.root(ctx, { agent: rootAgent(modelId, { registry }) });
      link?.attach(opened.harness, root.id, extra.threadsOf);
    },
  };
}

/** The work directory as the robot's files see it (build-robot.ts): relative paths under `root`. */
function nodeFiles(root: string): RobotFiles {
  return {
    async readTextFile(path) {
      try { return { ok: true, value: await readFile(join(root, path), "utf8") }; } catch (e) { return { ok: false, error: { code: (e as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "io", message: String((e as Error).message) } }; }
    },
    async writeFile(path, content) {
      try { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); return { ok: true }; } catch (e) { return { ok: false, error: { message: String((e as Error).message) } }; }
    },
    async createDir(path) {
      try { await mkdir(join(root, path), { recursive: true }); return { ok: true }; } catch (e) { return { ok: false, error: { code: "io", message: String((e as Error).message) } }; }
    },
  };
}
