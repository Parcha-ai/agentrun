// A universe on a machine that does not mount the disk (a gVisor GPU sandbox: its fsync is not durable), run through the
// pipe like browser-demo's remote host (03-tab-to-cloud remote-host.ts): the server's RunPipe holds the run's claim,
// this process runs pi's Harness over the pipe's Storage and the trainer on its own work directory, and every
// checkpoint is written through the pipe (files, then the server's barrier) before progress names it.
//
// It starts when the machine is warmed and waits, modules loaded, for one WebSocket with its bearer token: the server's
// first frame there is the invitation (which run, as which tab, for which switch, and the universe's environment), so a
// takeover costs a dial and an attach, not a process start. It exits when the pipe lets it go.
//   node universe-remote.mjs --port 8080 --token-file F [--work DIR, default ~/work]
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { EnvironmentFacts } from "../../03-tab-to-cloud/environment.ts";
import { nodeWorkspaceFs } from "../../03-tab-to-cloud/host-fs.ts";
import { probeHost } from "../../03-tab-to-cloud/host-probe.ts";
import { PipeClient, type SocketLike } from "../../03-tab-to-cloud/tab/pipe-client.ts";
import { startTab, type TabRuntime } from "../../03-tab-to-cloud/tab/runtime.ts";
import { Workspace } from "../../03-tab-to-cloud/tab/workspace.ts";
import type { PipeFrame } from "../../03-tab-to-cloud/wire.ts";
import { homePolicy, startWorkload, type Workload } from "./workload.ts";

/** The server's first frame: 03's invite plus the universe's environment (UNIVERSE_*, DEMO_ENV_LABEL, ...). */
export type UniverseInvite = { t: "invite"; run: string; token: string; tab: string; switchId?: string; env: Record<string, string> };

const { values } = parseArgs({ options: { port: { type: "string", default: "8080" }, "token-file": { type: "string" }, work: { type: "string", default: join(homedir(), "work") } } });
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const bearer = createHash("sha256").update(`Bearer ${readFileSync(values["token-file"]!, "utf8").trim()}`).digest();
const work = values.work!;
mkdirSync(work, { recursive: true });

/** The machine's probe taken when it was warmed, used only when it is this box's; otherwise probed now. */
function cachedFacts(env: Record<string, string>): Promise<EnvironmentFacts> | EnvironmentFacts {
  if (env.UNIVERSE_FACTS_FILE && env.UNIVERSE_BOX_ID) {
    try {
      const cached = JSON.parse(readFileSync(env.UNIVERSE_FACTS_FILE, "utf8")) as { box?: string; facts?: EnvironmentFacts };
      if (cached.box === env.UNIVERSE_BOX_ID && cached.facts) return cached.facts;
    } catch {
      // not there or unreadable: probe
    }
  }
  return probeHost({ ...process.env, ...env });
}

const wss = new WebSocketServer({
  port: Number(values.port),
  host: "0.0.0.0",
  maxPayload: 64 * 1024 * 1024,
  verifyClient: ({ req }: { req: { headers: Record<string, string | string[] | undefined> } }) => timingSafeEqual(createHash("sha256").update(String(req.headers.authorization ?? "")).digest(), bearer),
});
log("listening", { port: Number(values.port) });

let taken = false;
wss.on("connection", (socket: WebSocket) => {
  if (taken) {
    socket.close(4009, "TAKEN");
    return;
  }
  taken = true;
  socket.once("message", (data) => {
    const invite = JSON.parse(String(data)) as UniverseInvite;
    if (invite.t !== "invite") {
      socket.close(4000, "INVITE_FIRST");
      return;
    }
    void serve(socket, invite).catch((error) => {
      log("failed", { error: (error as Error).message });
      process.exit(1);
    });
  });
});

async function serve(socket: WebSocket, invite: UniverseInvite): Promise<void> {
  const env = invite.env;
  const label = env.DEMO_ENV_LABEL ?? "a cloud host";
  let runtime: TabRuntime | undefined;
  let trainer: Workload | undefined;
  let workspace: Workspace | undefined;
  // One write-through at a time: each diffs against the baseline the previous one accepted. Nothing else here writes
  // through (no agent turn runs in a universe unless someone submits one).
  let line: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    const next = line.then(async () => {
      const { changes, scanned } = await workspace!.changes();
      if (changes.length > 0) await client.syncFiles(changes);
      workspace!.accept(scanned);
    });
    line = next.catch(() => undefined);
    return next;
  };
  const leave = async (code: number) => {
    await trainer?.stop();
    await runtime?.close().catch(() => undefined);
    log("left", { code });
    wss.close();
    process.exit(code);
  };
  const onFrame = (frame: PipeFrame) => {
    if (frame.t !== "drain") return;
    // The collapse or a move: stop training, write through what it wrote, close the agent here, say so; the pipe
    // then releases the run.
    void (async () => {
      await trainer?.stop();
      // Going home (not sealed as a loser): the winner's policy and the getup policy in one file for the tab.
      if (frame.switchId.startsWith("home-")) await homePolicy({ work, env, log }).catch((error: Error) => log("home.policy-failed", { error: error.message }));
      await flush().catch((error: Error) => log("flush.failed", { error: error.message }));
      await runtime?.close().catch(() => undefined);
      runtime = undefined;
      log("drained", { switchId: frame.switchId });
      client.send({ t: "drained", switchId: frame.switchId });
    })();
  };
  const client: PipeClient = new PipeClient({
    socket: socket as unknown as SocketLike,
    run: invite.run,
    token: invite.token,
    tab: invite.tab,
    mode: "write",
    ...(invite.switchId ? { switchId: invite.switchId } : {}),
    onFrame,
    onLost: (code, message) => {
      // Another machine has the run (a takeover) or the pipe lost it: nothing of this one may land any more.
      log("lost", { code, message });
      void leave(0);
    },
  });
  const first = await client.ready;
  if (first.t !== "attached") {
    log("not the writer", { placement: first.placement.where });
    await leave(1);
    return;
  }
  const started = performance.now();
  workspace = new Workspace(nodeWorkspaceFs(work));
  const facts: EnvironmentFacts = {
    ...(await cachedFacts(env)),
    label,
    note: `You are universe ${env.UNIVERSE_ID ?? "?"} of ${env.UNIVERSE_OF ?? "?"} forked from one run; your reward: ${env.UNIVERSE_REWARD ?? "?"}.`,
  };
  const execEnv = new NodeExecutionEnv({ cwd: work, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? work, LANG: "C.UTF-8", TERM: "dumb" } });
  runtime = await startTab({ client, attached: first, env: execEnv, workspace, ...(first.move ? { move: { info: first.move, facts } } : {}) });
  log("running", { epoch: first.epoch, generation: first.generation, ms: Math.round(performance.now() - started), restored: runtime.restored });
  // Each attachment is a new epoch of the pipe: progress written here says which one, as a generation would.
  trainer = startWorkload({ work, env, generation: first.epoch, host: label, checkpointed: flush, log });
  trainer.done.catch((error: unknown) => log("trainer.failed", { error: (error as Error).message }));
}
