// The pipe transport: the server holds each universe's claim (03-tab-to-cloud's RunPipe: the package's lease, the store
// on the mount, write-through, model proxy) and the machine runs the agent through it (universe-remote.ts), for
// machines whose own mount is not durable (gVisor: fsync is acknowledged without the disk). A placement dials the
// machine's waiting runner, invites it, and attaches its socket as the pipe's writer; a takeover attaches the spare's
// socket with a new epoch, and the pipe refuses every later frame of the replaced one. The claim never moves, so a
// takeover needs no revoke and no mount.
//
// The frames a runner sends are the tab's (wire.ts) and go to the pipe as 03's server sends them: Storage calls and
// write-throughs in arrival order, model streams and pings beside them.
import { randomBytes } from "node:crypto";
import { mintMountToken, removeMountToken } from "@parcha/pi-durable-disk";
import type { ArchilHost, HostStatus, OpenRunLeaseOptions, RunRef } from "@parcha/pi-durable-disk";
import WebSocket from "ws";
import type { ModelProxy } from "../../03-tab-to-cloud/pipe/model-proxy.ts";
import { RunPipe, type PipeSocket } from "../../03-tab-to-cloud/pipe/run-pipe.ts";
import type { PipeFrame, TabFrame } from "../../03-tab-to-cloud/wire.ts";
import type { Control, Fleet, Machine, Placed, PlaceResult } from "./multiverse.ts";
import type { UniverseInvite } from "./universe-remote.ts";

/** Where a machine's runner waits: a WebSocket URL and its bearer token. */
export type RunnerAddress = { readonly url: string; readonly bearer: string };

export interface PipeOptions {
  readonly control: Control;
  /** The pipes' mounts on this host go under it (`<mountRoot>/runs/<id>`). */
  readonly mountRoot: string;
  readonly host?: ArchilHost;
  readonly lease?: OpenRunLeaseOptions["lease"];
  /** The universes' model access; its budget spans every universe. */
  readonly model: ModelProxy;
  /** Where `machine`'s runner waits (it was started when the machine was warmed). */
  runner(machine: Machine): Promise<RunnerAddress>;
  /** The machine as its provider sees it, for one that died without a word on its socket. */
  machineStatus?(machine: Machine): Promise<HostStatus>;
  /** Delete the machine once its run is sealed. */
  retire(machine: Machine): Promise<void>;
  readonly tokenPrefix?: string;
  readonly attachTimeoutMs?: number;
  /**
   * How long the pipe waits for a writer's ping before it calls the writer gone. A runner pings only once attached, and
   * an attach ships all of work/ (a trainer's checkpoints and compile cache: seconds), so the pipe's 3 s default would
   * drop a writer mid-attach. A universe's death is seen by its fleet and its socket, not by this grace. Default 30 s.
   */
  readonly writerGraceMs?: number;
  readonly onResource?: (kind: string, id: string, note?: string) => void;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  /** Test seams, passed to the pipe's lease (a claim on a local directory). */
  readonly acquire?: OpenRunLeaseOptions["acquire"];
  readonly claimDir?: OpenRunLeaseOptions["claimDir"];
}

type Held = { pipe: RunPipe; secret: string; token: string };
type PipePlaced = Placed & { readonly ws: WebSocket; readonly socket: PipeSocket; readonly tab: string; readonly switchId: string };

export type PipePlacement = Pick<Fleet, "transport" | "place" | "status" | "seal"> & {
  /** Release every pipe still held (sealed paused) and remove its token: the end of a run of the multiverse. */
  releaseAll(): Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A WebSocket as the pipe's socket. */
function adapt(ws: WebSocket, id: string): PipeSocket {
  return {
    id,
    send: (frame: PipeFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    },
    close: (code: number, reason: string) => ws.close(code, reason),
  };
}

export function pipePlacement(o: PipeOptions): PipePlacement {
  const log = o.log ?? (() => {});
  const held = new Map<string, Held>();
  const opening = new Map<string, Promise<Held>>();

  /** The run's pipe: opened on its first placement (the claim taken here), kept across takeovers. */
  function hold(run: RunRef): Promise<Held> {
    const h = held.get(run.id);
    if (h) return Promise.resolve(h);
    let p = opening.get(run.id);
    if (!p) {
      p = (async () => {
        const t = await mintMountToken(o.control, { nickname: `${o.tokenPrefix ?? "pda-"}pipe-${run.id}`.slice(0, 200), ttl: "24h" });
        o.onResource?.("token", t.identifier, `pipe ${run.id}`);
        try {
          const pipe = await RunPipe.open({
            ref: run,
            mountToken: t.token,
            mountRoot: o.mountRoot,
            ...(o.host ? { host: o.host } : {}),
            ...(o.lease ? { lease: o.lease } : {}),
            model: o.model,
            writerGraceMs: o.writerGraceMs ?? 30_000,
            ...(o.acquire ? { acquire: o.acquire } : {}),
            ...(o.claimDir ? { claimDir: o.claimDir } : {}),
            onLost: (_p, error) => log("pipe.lost", { run: run.id, error: error.message }),
            log,
          });
          const h: Held = { pipe, secret: randomBytes(18).toString("base64url"), token: t.identifier };
          held.set(run.id, h);
          return h;
        } catch (error) {
          await removeMountToken(o.control, t.identifier).then(() => o.onResource?.("token-removed", t.identifier), () => {});
          throw error;
        } finally {
          opening.delete(run.id);
        }
      })();
      opening.set(run.id, p);
    }
    return p;
  }

  /** Dial the runner; it may still be binding its port right after a warm. */
  async function dial(address: RunnerAddress, deadline: number): Promise<WebSocket> {
    for (let attempt = 1; ; attempt++) {
      const ws = new WebSocket(address.url, { headers: { authorization: `Bearer ${address.bearer}` }, maxPayload: 64 * 1024 * 1024 });
      const opened = await new Promise<Error | null>((resolve) => {
        ws.once("open", () => resolve(null));
        ws.once("error", (error) => resolve(error));
        ws.once("unexpected-response", (_req, res) => resolve(new Error(`HTTP ${res.statusCode}`)));
      });
      if (!opened) return ws;
      ws.terminate();
      if (Date.now() > deadline) throw new Error(`the runner at ${new URL(address.url).host} did not answer: ${opened.message}`);
      await sleep(Math.min(100 * attempt, 500));
    }
  }

  /** Serve the runner's socket as a tab's on `h.pipe`, after its hello names the run, the secret and the invited tab. */
  function bridge(ws: WebSocket, socket: PipeSocket, h: Held, expect: { run: string; tab: string }, attach: () => Promise<"writer" | "viewer">): Promise<number> {
    const pipe = h.pipe;
    return new Promise<number>((resolve, reject) => {
      let hello: Promise<void> | undefined;
      let queue: Promise<void> = Promise.resolve();
      const failed = (error: unknown) => log("frame.failed", { run: expect.run, error: (error as Error).message });
      const handle = async (frame: TabFrame) => {
        switch (frame.t) {
          case "rpc":
            return pipe.rpc(socket, frame.id, frame.method, frame.args);
          case "files":
            return pipe.files(socket, frame.id, frame.changes);
          case "model":
            return pipe.model(socket, frame.id, frame.path, frame.body);
          case "model-abort":
            return pipe.modelAbort(socket, frame.id);
          case "view":
            return pipe.view(socket, frame.event);
          case "ping":
            return pipe.ping(socket, frame.at);
          case "drained":
            return pipe.drained(socket, frame.switchId);
          case "bye":
            return void ws.close(1000, "bye");
          default:
            return;
        }
      };
      ws.on("message", (data) => {
        let frame: TabFrame;
        try {
          frame = JSON.parse(String(data)) as TabFrame;
        } catch {
          ws.close(4000, "BAD_FRAME");
          return;
        }
        if (frame.t === "hello") {
          if (hello) return;
          hello = queue = queue.then(async () => {
            if (frame.run !== expect.run || frame.token !== h.secret || frame.tab !== expect.tab || frame.mode !== "write") {
              socket.send({ t: "error", message: "not the invited runner" } as PipeFrame);
              ws.close(4003, "NOT_INVITED");
              return reject(new Error("the runner's hello did not match its invitation"));
            }
            const role = await attach();
            if (role !== "writer") return reject(new Error(`the runner attached as ${role}`));
            resolve(Date.now());
          });
          hello.catch(reject);
          return;
        }
        if (!hello) {
          ws.close(4003, "HELLO_FIRST");
          return;
        }
        // Storage calls and write-throughs run in arrival order; model streams and pings must not wait behind them.
        if (frame.t === "model" || frame.t === "ping" || frame.t === "model-abort") void hello.then(() => handle(frame)).catch(failed);
        else queue = queue.then(() => handle(frame)).catch(failed);
      });
      ws.on("close", () => {
        pipe.detach(socket);
        reject(new Error("the runner's socket closed before it attached"));
      });
    });
  }

  const mine = (p: Placed): PipePlaced => {
    const d = p as Partial<PipePlaced>;
    if (!d.ws || !d.socket) throw new Error(`${p.run.id} on ${p.machine.id} is not a pipe placement`);
    return d as PipePlaced;
  };

  return {
    transport: "pipe",

    async place(run: RunRef, machine: Machine, env: Readonly<Record<string, string>>, from?: Placed): Promise<PlaceResult> {
      const deadline = Date.now() + (o.attachTimeoutMs ?? 60_000);
      const [h, address] = await Promise.all([hold(run), o.runner(machine)]);
      const tab = `box-${machine.id}`;
      const switchId = env.DEMO_SWITCH_ID ?? `place-${run.id}-${Date.now().toString(36)}`;
      const ws = await dial(address, deadline);
      const socket = adapt(ws, `${machine.id}-${randomBytes(3).toString("hex")}`);
      const move = { id: switchId, from: env.DEMO_SWITCH_FROM ?? "another machine", planned: env.DEMO_SWITCH_PLANNED !== "0" };
      // A takeover attaches with a new epoch: the replaced runner is told it lost the run and every later frame of it is
      // refused, after the frames it already sent have settled.
      const attached = bridge(ws, socket, h, { run: run.id, tab }, () => h.pipe.attach(socket, tab, from !== undefined, { environments: [], move, env: "universes" }));
      const invite: UniverseInvite = { t: "invite", run: run.id, token: h.secret, tab, switchId, env: { ...env } };
      ws.send(JSON.stringify(invite));
      const launchedAt = Date.now();
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${machine.label} did not attach in time`)), Math.max(0, deadline - Date.now())).unref());
      const openedAt = await Promise.race([attached, timeout]).catch((error: unknown) => {
        ws.terminate();
        throw error;
      });
      if (from) mine(from).ws.terminate();
      const placed: PipePlaced = { run, machine, ws, socket, tab, switchId };
      return { placed, revoked: 0, launchedAt, openedAt };
    },

    async status(p: Placed): Promise<HostStatus> {
      const d = mine(p);
      const h = held.get(p.run.id);
      if (h?.pipe.lost) return "failed";
      if (d.ws.readyState !== WebSocket.OPEN) return "gone";
      if (h && h.pipe.writerTab !== d.tab) return "stopped";
      return (await o.machineStatus?.(p.machine).catch(() => "unknown" as const)) ?? "running";
    },

    /** Drain the runner (it stops training and writes through), release the pipe (barrier, seal), delete the machine. */
    async seal(p: Placed): Promise<void> {
      const d = mine(p);
      const h = held.get(p.run.id);
      try {
        if (h && h.pipe.writerTab === d.tab) await h.pipe.drainWriter(`seal-${p.run.id}`, 15_000);
        if (h) {
          await h.pipe.release();
          held.delete(p.run.id);
          await removeMountToken(o.control, h.token).then(() => o.onResource?.("token-removed", h.token), () => {});
        }
      } finally {
        d.ws.terminate();
        await o.retire(p.machine).catch((error: unknown) => log("retire.failed", { machine: p.machine.id, error: (error as Error).message }));
      }
    },

    async releaseAll(): Promise<void> {
      for (const [id, h] of held) {
        await h.pipe.release().catch((error: unknown) => log("pipe.release-failed", { run: id, error: (error as Error).message }));
        await removeMountToken(o.control, h.token).then(() => o.onResource?.("token-removed", h.token), () => {});
        held.delete(id);
      }
    },
  };
}
