// A host that cannot mount the disk (a GPU sandbox: its runner gives containers no FUSE) runs the agent the way the
// tab does, through the pipe: the server's pipe holds the claim, this host runs pi's Harness over the pipe's Storage,
// the agent's tools on its own filesystem (WORK), the write-through after every writing tool, and model calls through
// the pipe. The server reaches it, not the other way round: it listens for one WebSocket with its bearer token, the
// server's first frame there is the invitation (which run, as which tab, for which switch), and from then on that
// socket is a tab's connection to the pipe. It exits when the pipe lets it go.
//   node remote-host.ts --port 8080 --token-file F --work DIR
//   DEMO_ENV_LABEL, DEMO_ENV_CLASS: how this host's notice names it (host-probe.ts)
import { readFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { timingSafeEqual, createHash } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { watchEvents } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { probeHost } from "./host-probe.ts";
import { nodeWorkspaceFs } from "./host-fs.ts";
import { PipeClient, type Attached, type SocketLike } from "./tab/pipe-client.ts";
import { finishStep, startTab, type TabRuntime } from "./tab/runtime.ts";
import { Workspace } from "./tab/workspace.ts";
import type { PipeFrame } from "./wire.ts";

/** The server's first frame on the socket. */
export type Invite = { t: "invite"; run: string; token: string; tab: string; switchId?: string };

const { values } = parseArgs({ options: { port: { type: "string", default: "8080" }, "token-file": { type: "string" }, work: { type: "string", default: "/home/pda/work" } } });
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const token = readFileSync(values["token-file"]!, "utf8").trim();
const expected = createHash("sha256").update(`Bearer ${token}`).digest();
const work = values.work!;
mkdirSync(work, { recursive: true });

const wss = new WebSocketServer({
  port: Number(values.port),
  host: "0.0.0.0",
  maxPayload: 64 * 1024 * 1024,
  verifyClient: ({ req }: { req: { headers: Record<string, string | string[] | undefined> } }) => timingSafeEqual(createHash("sha256").update(String(req.headers.authorization ?? "")).digest(), expected),
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
    const invite = JSON.parse(String(data)) as Invite;
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

async function serve(socket: WebSocket, invite: Invite): Promise<void> {
  let runtime: TabRuntime | undefined;
  let stopView: (() => Promise<void>) | undefined;
  const unview = async () => {
    const stop = stopView;
    stopView = undefined;
    await stop?.().catch(() => undefined);
  };
  const leave = async (code: number) => {
    await unview();
    await runtime?.close().catch(() => undefined);
    runtime = undefined;
    log("left", { code });
    wss.close();
    process.exit(code);
  };
  const onFrame = (frame: PipeFrame) => {
    if (frame.t === "want-snapshot" && runtime) {
      const r = runtime;
      void watchEvents(r.harness, r.root.id, ctx).then(async (stream) => {
        client.view({ kind: "snapshot", event: stream.snapshot });
        await stream.stop();
      });
    } else if (frame.t === "submit" && runtime) {
      void runtime.root.submit({ type: "input", content: frame.text, requestId: frame.requestId }, ctx).catch((error: Error) => log("submit.failed", { error: error.message }));
    } else if (frame.t === "drain") {
      // Finish the step in progress, close the agent here, say so; the pipe then releases the run.
      void (async () => {
        const how = runtime ? await finishStep(runtime.harness, 8_000).catch(() => "timeout" as const) : "idle";
        log("drained", { switchId: frame.switchId, step: how });
        await unview();
        await runtime?.close().catch(() => undefined);
        runtime = undefined;
        client.send({ t: "drained", switchId: frame.switchId });
      })();
    }
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
  const attached: Attached = first;
  const started = performance.now();
  const env = new NodeExecutionEnv({ cwd: work, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? work, LANG: "C.UTF-8", TERM: "dumb" } });
  const facts = await probeHost();
  runtime = await startTab({ client, attached, env, workspace: new Workspace(nodeWorkspaceFs(work)), ...(attached.move ? { move: { info: attached.move, facts } } : {}) });
  if (attached.move) client.send({ t: "switched", switchId: attached.move.id });
  log("running", { generation: attached.generation, ms: Math.round(performance.now() - started), restored: runtime.restored, gpu: facts.gpu });
  const stream = await watchEvents(runtime.harness, runtime.root.id, ctx);
  client.view({ kind: "snapshot", event: stream.snapshot });
  stream.start(async (events) => client.view({ kind: "events", events: [...events] }));
  stopView = async () => void (await stream.stop());
}
