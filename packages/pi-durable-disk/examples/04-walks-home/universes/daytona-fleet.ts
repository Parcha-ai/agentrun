// Universes on Daytona: each machine is a sandbox from the demo's runtime snapshot (Node, the archil client, the package,
// the agent's modules and the run user; 03-tab-to-cloud/scripts/daytona-snapshot.ts builds it). `warm` creates the box
// and installs the universe app into it, so a later start only uploads the launch spec and the mount token and launches
// the instance (the package's `daytonaHost`, handed this box instead of creating one).
//
// Every box carries `pda-fleet=<fleet>` and the `<namePrefix>` name, is recorded in the ledger before its create call,
// and is closed in the ledger when deleted; this client refuses to touch any box that is not one it created.
import { daytonaHost, LABEL_FLEET, LABEL_RUN, type CreateSandboxBody, type DaytonaClient, type HostDriver, type SandboxInfo } from "@parcha/pi-durable-disk";
import type { Fleet, Machine } from "./multiverse.ts";

/** The runtime snapshot's layout (03-tab-to-cloud/pipe/daytona.ts). */
export const BOX_APP_DIR = "/usr/local/lib/pda-demo";
export const BOX_PACKAGE = `${BOX_APP_DIR}/node_modules/@parcha/pi-durable-disk`;
export const BOX_NODE = "/opt/node24/bin/node";
export const BOX_MOUNT_ROOT = "/mnt/archil";
export const BOX_UNIVERSE_APP = `${BOX_APP_DIR}/universe-app.mjs`;

/** Daytona's on-demand list prices: per vCPU hour, per GiB hour, per GPU hour by type. */
const PRICE = { vcpu: 0.0504, gib: 0.0162, gpu: { "rtx-4090": 0.99, "rtx-5090": 1.29, "rtx-pro-6000": 3.03, h100: 3.95, h200: 4.54 } as Record<string, number> };

export interface LedgerLike {
  open(kind: string, id: string, note?: string): void;
  close(kind: string, id: string, note?: string): void;
}

export interface DaytonaFleetOptions {
  readonly client: DaytonaClient;
  readonly snapshot: string;
  readonly target: string;
  /** The `pda-fleet` label of every box ("demo-d1"). */
  readonly fleet: string;
  /** Every box's name starts with it ("pda-demo-d1-"). */
  readonly namePrefix: string;
  /** The universe app, bundled (build.mjs): installed into each box at `BOX_UNIVERSE_APP`. */
  readonly app: Uint8Array;
  /** `run` flags after `--app` (lease periods). */
  readonly runArgs?: readonly string[];
  /** The machine's label in the notice and on the stage, from the box. */
  readonly label?: (box: SandboxInfo, short: string) => string;
  readonly ttlMinutes?: number;
  readonly ledger?: LedgerLike;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function daytonaFleet(o: DaytonaFleetOptions): Fleet & { boxes(): SandboxInfo[]; sweep(): Promise<string[]> } {
  const log = o.log ?? (() => {});
  const ours = new Map<string, SandboxInfo>();
  const removed = new Set<string>();
  const byMachine = new Map<string, SandboxInfo>();
  const ttlMinutes = o.ttlMinutes ?? 120;

  const check = (box: SandboxInfo | null): SandboxInfo | null => {
    if (box && (box.labels?.[LABEL_FLEET] !== o.fleet || !box.name.startsWith(o.namePrefix) || !ours.has(box.id))) throw new Error(`refusing to touch sandbox ${box.id}: not this fleet's`);
    return box;
  };

  /** The fleet's client: only its own boxes, every delete in the ledger. */
  const client: DaytonaClient = {
    async create(body: CreateSandboxBody) {
      if (body.labels[LABEL_FLEET] !== o.fleet || !body.name.startsWith(o.namePrefix)) throw new Error("a fleet box carries the fleet's label and name prefix");
      o.ledger?.open("daytona-box", body.name, body.labels[LABEL_RUN]);
      const box = await o.client.create(body);
      ours.set(box.id, box);
      return box;
    },
    get: async (id) => check(await o.client.get(id)),
    list: async (labels) => (await o.client.list({ ...labels, [LABEL_FLEET]: o.fleet })).filter((b) => ours.has(b.id) && !removed.has(b.id)),
    async stop(id, force) {
      check(await o.client.get(id));
      await o.client.stop(id, force);
    },
    async remove(id) {
      if (removed.has(id)) return;
      const box = check(await o.client.get(id));
      await o.client.remove(id);
      removed.add(id);
      const name = box?.name ?? ours.get(id)?.name;
      if (name) o.ledger?.close("daytona-box", name, "deleted");
    },
    exec: async (box, command, timeoutSec) => o.client.exec(check(box)!, command, timeoutSec),
    upload: async (box, path, content) => o.client.upload(check(box)!, path, content),
  };

  const rateOf = (box: SandboxInfo): number => {
    const b = box as SandboxInfo & { cpu?: number; memory?: number; gpu?: number };
    const gpuType = /-gpu-([a-z0-9-]+)-[0-9a-f]{12}$/.exec(o.snapshot)?.[1];
    return (b.cpu ?? 1) * PRICE.vcpu + (b.memory ?? 1) * PRICE.gib + (b.gpu ?? 0) * (PRICE.gpu[gpuType ?? "h100"] ?? PRICE.gpu.h200!);
  };

  return {
    async warm(name: string): Promise<Machine> {
      const t0 = Date.now();
      const stamp = `${t0.toString(36).slice(-4)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
      const full = `${o.namePrefix}${name}-${stamp}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 63);
      let box = await client.create({
        name: full,
        snapshot: o.snapshot,
        target: o.target,
        labels: { [LABEL_FLEET]: o.fleet, [LABEL_RUN]: "spare" },
        autoStopInterval: 0,
        autoDeleteInterval: 0,
        ttlMinutes,
      });
      const created = Date.now();
      try {
        for (let i = 0; box.state !== "started"; i++) {
          if (box.state === "error" || box.state === "build_failed" || i > 600) throw new Error(`sandbox ${full} is ${box.state}${box.errorReason ? `: ${box.errorReason}` : ""}`);
          await sleep(250);
          box = (await client.get(box.id)) ?? box;
        }
        const started = Date.now();
        const stage = "/tmp/pda-universe-stage";
        const mk = await client.exec(box, `umask 077 && mkdir -p ${stage} && test -f ${BOX_APP_DIR}/.prepared`, 30);
        if (mk.exitCode !== 0) throw new Error(`${full} lacks the runtime snapshot's app (${mk.result.trim().slice(0, 200)})`);
        await client.upload(box, `${stage}/universe-app.mjs`, o.app);
        const r = await client.exec(box, `sudo -n install -o root -g root -m 0644 ${stage}/universe-app.mjs ${BOX_UNIVERSE_APP} && rm -f ${stage}/universe-app.mjs && nproc && free -g | awk '/Mem:/ {print $2}'`, 30);
        if (r.exitCode !== 0) throw new Error(`installing the universe app in ${full} failed: ${r.result.trim().slice(0, 200)}`);
        const short = full.slice(o.namePrefix.length);
        const machine: Machine = { id: full, label: o.label?.(box, short) ?? `Daytona sandbox ${short}`, kind: "sandbox", ratePerHour: rateOf(box), since: created };
        byMachine.set(full, box);
        log("daytona.warm", { box: full, createMs: created - t0, startedMs: started - t0, readyMs: Date.now() - t0, state: box.state });
        return machine;
      } catch (error) {
        await client.remove(box.id).catch(() => {});
        throw error;
      }
    },

    driver(machine: Machine, env: Readonly<Record<string, string>>): HostDriver {
      const box = byMachine.get(machine.id);
      if (!box) throw new Error(`${machine.id} is not a warm machine of this fleet`);
      // The driver's create hands back this box: the universe runs on the machine the stage already shows.
      const adopt: DaytonaClient = { ...client, create: async () => box };
      return daytonaHost({
        client: adopt,
        snapshot: o.snapshot,
        target: o.target,
        fleet: o.fleet,
        namePrefix: o.namePrefix,
        mountRoot: BOX_MOUNT_ROOT,
        node: BOX_NODE,
        packageDir: BOX_PACKAGE,
        user: "pda",
        group: "pda",
        runArgs: ["--app", BOX_UNIVERSE_APP, ...(o.runArgs ?? [])],
        env,
        stopTimeoutMs: 15_000,
        ttlMinutes,
        startTimeoutMs: 120_000,
      });
    },

    async kill(machine: Machine): Promise<void> {
      const box = byMachine.get(machine.id);
      if (!box) return;
      // SIGKILL power-off: no drain, the FUSE client dies with the box. A box made with autoDeleteInterval 0 deletes
      // itself once stopped; off the kill's clock, the ledger closes when it is gone, and a box still there is deleted.
      await client.stop(box.id, true);
      void (async () => {
        for (let i = 0; i < 60; i++) {
          if ((await o.client.get(box.id).catch(() => undefined)) === null) {
            removed.add(box.id);
            o.ledger?.close("daytona-box", machine.id, "deleted itself after the kill");
            return;
          }
          await sleep(1_000);
        }
        await client.remove(box.id).catch((error: unknown) => log("daytona.remove-failed", { box: machine.id, error: (error as Error).message }));
      })();
    },

    async retire(machine: Machine): Promise<void> {
      const box = byMachine.get(machine.id);
      if (box) await client.remove(box.id);
    },

    boxes: () => [...ours.values()].filter((b) => !removed.has(b.id)),

    /** Delete every box of this fleet still listed (the end of a run, or after a crash). */
    async sweep(): Promise<string[]> {
      const left = await o.client.list({ [LABEL_FLEET]: o.fleet });
      const deleted: string[] = [];
      for (const b of left) {
        if (b.labels?.[LABEL_FLEET] !== o.fleet || !b.name.startsWith(o.namePrefix)) continue;
        await o.client.remove(b.id).then(
          () => {
            deleted.push(b.name);
            o.ledger?.close("daytona-box", b.name, "swept");
          },
          () => {},
        );
      }
      return deleted;
    },
  };
}
