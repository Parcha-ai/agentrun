// Universes on Daytona: each machine is a sandbox from the demo's runtime snapshot (Node, the archil client, the package,
// the agent's modules and the run user; 03-tab-to-cloud/scripts/daytona-snapshot.ts builds it). `warm` creates the box
// and installs the universe app into it, so a later start only uploads the launch spec and the mount token and launches
// the instance (the package's `daytonaHost`, handed this box instead of creating one).
//
// Every box carries `pda-fleet=<fleet>` and the `<namePrefix>` name, is recorded in the ledger before its create call,
// and is closed in the ledger when deleted; this client refuses to touch any box that is not one it created.
//
// The fleet only needs a `DaytonaClient`, so the same fleet runs on Modal: `modalSandboxes(sdk, { image, runtime })`
// is that client over Modal sandboxes (the package's modalHost), given an image with the runtime snapshot's layout,
// with `kind` "vm" or "gpu", a label and Modal's rate.
import { randomBytes } from "node:crypto";
import { daytonaHost, LABEL_FLEET, LABEL_RUN, sandboxStatus, type CreateSandboxBody, type DaytonaClient, type HostDriver, type HostStatus, type SandboxInfo } from "@parcha/pi-durable-disk";
import type { RunnerAddress } from "./pipe.ts";
import type { Fleet, Machine } from "./multiverse.ts";

/** The runtime snapshot's layout (03-tab-to-cloud/pipe/daytona.ts). */
export const BOX_APP_DIR = "/usr/local/lib/pda-demo";
export const BOX_PACKAGE = `${BOX_APP_DIR}/node_modules/@parcha/pi-durable-disk`;
export const BOX_NODE = "/opt/node24/bin/node";
export const BOX_MOUNT_ROOT = "/mnt/archil";
export const BOX_UNIVERSE_APP = `${BOX_APP_DIR}/universe-app.mjs`;
/** The self-contained bundles (probe, pipe runner): they need only Node and the run user. */
export const BOX_UNIVERSE_DIR = "/usr/local/lib/pda-universe";
export const BOX_PROBE = `${BOX_UNIVERSE_DIR}/universe-probe.mjs`;
/**
 * The probe the box took when it was warmed, with the box's id: root-owned, readable by the run user (the instance runs
 * as it), on the box's tmpfs so it goes with the box. The notice uses it only when the id is this box's.
 */
export const BOX_FACTS = "/run/pda-universe/probe.json";
/** The pipe transport's runner, its bearer token (the run user's own) and its output. */
export const BOX_RUNNER = `${BOX_UNIVERSE_DIR}/universe-remote.mjs`;
export const BOX_RUNNER_TOKEN = "/run/pda-universe/runner.token";
export const BOX_RUNNER_LOG = "/var/tmp/pda-universe-remote.log";
/** daytonaHost's launcher directory, where each instance's output goes (`<name>.log`). */
const BOX_LAUNCH_DIR = "/run/pda";

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
  /** The universe app for the direct transport, bundled (build.mjs): installed at `BOX_UNIVERSE_APP`; it needs the snapshot's app. */
  readonly app?: Uint8Array;
  /** The machine probe, bundled: run once at warm time, its facts left at `BOX_FACTS` for the notice. */
  readonly probe?: Uint8Array;
  /** `run` flags after `--app` (lease periods). */
  readonly runArgs?: readonly string[];
  /** The machine's label in the notice and on the stage, from the box. */
  readonly label?: (box: SandboxInfo, short: string) => string;
  /** What kind of machine the stage draws. Default "sandbox". */
  readonly kind?: Machine["kind"];
  /** List price per hour of one box. Default: Daytona's rates for the box's resources. */
  readonly ratePerHour?: (box: SandboxInfo) => number;
  readonly ttlMinutes?: number;
  readonly ledger?: LedgerLike;
  /** The ledger's kind for a box. Default "daytona-box". */
  readonly ledgerKind?: string;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  /**
   * The box-side runner for the pipe transport (universe-remote.ts, bundled): started as the run user when a box is
   * warmed, waiting on `port` for the server's dial through a signed preview URL of that port.
   */
  readonly runner?: { readonly bundle: Uint8Array; readonly port: number; previewUrl(boxId: string, port: number): Promise<string> };
  /**
   * Work a machine does once it is warm and before it is ready, as the run user in its home: these files are put under
   * `~/warmup/` and `command` runs there (a trainer's compile of the run's exact program, so a universe started or taken
   * over there starts from a warm cache). A warm-up that fails leaves the machine usable, cold.
   */
  readonly warmup?: { readonly files: Readonly<Record<string, Uint8Array>>; readonly command: string; readonly timeoutSec?: number };
  /** How runs reach the boxes: `directPlacement` (the box mounts the run) or `pipePlacement` (the server holds it). */
  readonly placement: (access: MachineAccess) => Pick<Fleet, "transport" | "place" | "status" | "seal">;
}

/** What a transport may do with this fleet's boxes. */
export interface MachineAccess {
  /** A host driver whose next start runs the run on this box (direct). */
  driver(machine: Machine, env: Readonly<Record<string, string>>): HostDriver;
  /** Where the box's runner waits (pipe). */
  runner(machine: Machine): Promise<RunnerAddress>;
  /** The box as Daytona reports it. */
  status(machine: Machine): Promise<HostStatus>;
  retire(machine: Machine): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function daytonaFleet(o: DaytonaFleetOptions): Fleet & { boxes(): SandboxInfo[]; sweep(): Promise<string[]>; logs(machine: Machine): Promise<string>; box(machine: Machine): SandboxInfo | undefined } {
  const log = o.log ?? (() => {});
  const ours = new Map<string, SandboxInfo>();
  const removed = new Set<string>();
  const ledgerName = new Map<string, string>();
  const byMachine = new Map<string, SandboxInfo>();
  const ttlMinutes = o.ttlMinutes ?? 120;
  const kindOf = o.ledgerKind ?? "daytona-box";

  const check = (box: SandboxInfo | null): SandboxInfo | null => {
    if (box && (box.labels?.[LABEL_FLEET] !== o.fleet || !box.name.startsWith(o.namePrefix) || !ours.has(box.id))) throw new Error(`refusing to touch sandbox ${box.id}: not this fleet's`);
    return box;
  };

  /** The fleet's client: only its own boxes, every delete in the ledger. */
  const client: DaytonaClient = {
    async create(body: CreateSandboxBody) {
      if (body.labels[LABEL_FLEET] !== o.fleet || !body.name.startsWith(o.namePrefix)) throw new Error("a fleet box carries the fleet's label and name prefix");
      o.ledger?.open(kindOf, body.name, body.labels[LABEL_RUN]);
      const box = await o.client.create(body);
      ours.set(box.id, box);
      // The ledger row is the name asked for; a provider may place it under another (a fallback class's).
      ledgerName.set(box.id, body.name);
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
      const name = ledgerName.get(id) ?? box?.name ?? ours.get(id)?.name;
      if (name) o.ledger?.close(kindOf, name, "deleted");
    },
    exec: async (box, command, timeoutSec) => o.client.exec(check(box)!, command, timeoutSec),
    upload: async (box, path, content) => o.client.upload(check(box)!, path, content),
  };

  const rateOf = (box: SandboxInfo): number => {
    const b = box as SandboxInfo & { cpu?: number; memory?: number; gpu?: number };
    const gpuType = /-gpu-([a-z0-9-]+)-[0-9a-f]{12}$/.exec(o.snapshot)?.[1];
    return (b.cpu ?? 1) * PRICE.vcpu + (b.memory ?? 1) * PRICE.gib + (b.gpu ?? 0) * (PRICE.gpu[gpuType ?? "h100"] ?? PRICE.gpu.h200!);
  };

  /** A driver whose next start runs the run on this box (its create hands back the box the stage already shows). */
  function driver(machine: Machine, env: Readonly<Record<string, string>>): HostDriver {
    const box = byMachine.get(machine.id);
    if (!box) throw new Error(`${machine.id} is not a warm machine of this fleet`);
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
      env: o.probe ? { UNIVERSE_FACTS_FILE: BOX_FACTS, UNIVERSE_BOX_ID: box.id, ...env } : env,
      stopTimeoutMs: 15_000,
      ttlMinutes,
      startTimeoutMs: 120_000,
    });
  }
  const runners = new Map<string, RunnerAddress>();
  async function runner(machine: Machine): Promise<RunnerAddress> {
    const r = runners.get(machine.id);
    if (!r) throw new Error(`${machine.id} has no runner (the fleet has no runner bundle)`);
    return r;
  }
  async function boxStatus(machine: Machine): Promise<HostStatus> {
    const box = byMachine.get(machine.id);
    if (!box || removed.has(box.id)) return "gone";
    const now = await o.client.get(box.id);
    if (!now) return "gone";
    const s = sandboxStatus(now.state);
    return s === "check" ? "running" : s;
  }
  async function retire(machine: Machine): Promise<void> {
    const box = byMachine.get(machine.id);
    if (box) await client.remove(box.id);
  }
  const placement = o.placement({ driver, runner, status: boxStatus, retire });

  return {
    ...placement,
    box: (machine: Machine) => byMachine.get(machine.id),

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
        const mk = await client.exec(box, `umask 077 && mkdir -p ${stage}${o.app ? ` && test -f ${BOX_APP_DIR}/.prepared` : ""}`, 30);
        if (mk.exitCode !== 0) throw new Error(`${full} lacks the runtime snapshot's app (${mk.result.trim().slice(0, 200)})`);
        // The direct transport's app runs from the snapshot's app directory (its node_modules); the probe and the pipe's
        // runner are self-contained and need only Node and the run user.
        const p0 = Date.now();
        if (o.app) await client.upload(box, `${stage}/universe-app.mjs`, o.app);
        if (o.probe) await client.upload(box, `${stage}/universe-probe.mjs`, o.probe);
        const install = [
          ...(o.app ? [`sudo -n install -o root -g root -m 0644 ${stage}/universe-app.mjs ${BOX_UNIVERSE_APP}`] : []),
          ...(o.probe
            ? [
                `sudo -n install -D -o root -g root -m 0644 ${stage}/universe-probe.mjs ${BOX_PROBE}`,
                `printf '{"box":"%s","facts":%s}\\n' '${box.id}' "$(${BOX_NODE} ${BOX_PROBE})" > ${stage}/facts.json`,
                `sudo -n install -D -o root -g root -m 0644 ${stage}/facts.json ${BOX_FACTS}`,
              ]
            : []),
          `rm -f ${stage}/*`,
        ].join(" && ");
        const r = await client.exec(box, install, 60);
        if (r.exitCode !== 0) throw new Error(`installing the universe app in ${full} failed: ${r.result.trim().slice(0, 200)}`);
        log("fleet.installed", { box: full, ms: Date.now() - p0, app: Boolean(o.app), probe: Boolean(o.probe) });
        if (o.runner) {
          const r0 = Date.now();
          const bearer = randomBytes(24).toString("base64url");
          await client.upload(box, `${stage}/universe-remote.mjs`, o.runner.bundle);
          await client.upload(box, `${stage}/runner.token`, new TextEncoder().encode(`${bearer}\n`));
          const start = [
            `sudo -n install -D -o root -g root -m 0644 ${stage}/universe-remote.mjs ${BOX_RUNNER}`,
            `sudo -n install -D -o pda -g pda -m 0600 ${stage}/runner.token ${BOX_RUNNER_TOKEN}`,
            `rm -f ${stage}/*`,
            `sudo -n -u pda -H sh -c 'mkdir -p "$HOME/work" && cd "$HOME" && nohup ${BOX_NODE} ${BOX_RUNNER} --port ${o.runner.port} --token-file ${BOX_RUNNER_TOKEN} --work "$HOME/work" > ${BOX_RUNNER_LOG} 2>&1 &'`,
            `for i in $(seq 150); do grep -q '"listening"' ${BOX_RUNNER_LOG} 2>/dev/null && exit 0; sleep 0.1; done; tail -5 ${BOX_RUNNER_LOG}; exit 1`,
          ].join(" && ");
          const [ran, url] = await Promise.all([client.exec(box, start, 60), o.runner.previewUrl(box.id, o.runner.port)]);
          if (ran.exitCode !== 0) throw new Error(`the runner in ${full} did not start: ${ran.result.trim().slice(-300)}`);
          runners.set(full, { url: url.replace(/^http/, "ws"), bearer });
          log("fleet.runner", { box: full, ms: Date.now() - r0 });
        }
        if (o.warmup) {
          const w0 = Date.now();
          const names = Object.keys(o.warmup.files);
          for (const [i, name] of names.entries()) await client.upload(box, `${stage}/warmup-${i}`, o.warmup.files[name]!);
          const place = names.map((name, i) => `sudo -n install -D -o pda -g pda -m 0644 ${stage}/warmup-${i} ~pda/warmup/${name}`);
          const run = `sudo -n -u pda -H sh -c 'cd "$HOME/warmup" && ${o.warmup.command.replace(/'/g, "'\\''")}' > /var/tmp/pda-universe-warmup.log 2>&1; echo "warmup=$?"`;
          const r = await client.exec(box, [...place, `rm -f ${stage}/*`, run].join(" && "), o.warmup.timeoutSec ?? 600).catch((e: Error) => ({ exitCode: -1, result: e.message }));
          log("fleet.warmup", { box: full, ms: Date.now() - w0, result: r.result.trim().split("\n").at(-1)?.slice(0, 120) });
        }
        const short = full.slice(o.namePrefix.length);
        const machine: Machine = { id: full, label: o.label?.(box, short) ?? `Daytona sandbox ${short}`, kind: o.kind ?? "sandbox", ratePerHour: (o.ratePerHour ?? rateOf)(box), since: created };
        byMachine.set(full, box);
        log("fleet.warm", { box: full, createMs: created - t0, startedMs: started - t0, readyMs: Date.now() - t0, state: box.state });
        return machine;
      } catch (error) {
        await client.remove(box.id).catch(() => {});
        throw error;
      }
    },

    async kill(machine: Machine): Promise<void> {
      const box = byMachine.get(machine.id);
      if (!box) return;
      // SIGKILL power-off: no drain, the FUSE client dies with the box. A box made with autoDeleteInterval 0 deletes
      // itself once stopped; off the kill's clock, the ledger closes when it is gone, and a box still there is deleted.
      await client.stop(box.id, true);
      void (async () => {
        for (let i = 0; i < 60; i++) {
          const now = await o.client.get(box.id).catch(() => undefined);
          if (now === null) {
            removed.add(box.id);
            o.ledger?.close(kindOf, machine.id, "deleted itself after the kill");
            return;
          }
          if (now && (now.state === "stopped" || sandboxStatus(now.state) === "gone")) break;
          await sleep(1_000);
        }
        // Stopped but still there (a provider that keeps stopped boxes): delete it. The id is this fleet's own.
        await o.client.remove(box.id).then(
          () => {
            removed.add(box.id);
            o.ledger?.close(kindOf, machine.id, "deleted after the kill");
          },
          (error: unknown) => log("fleet.remove-failed", { box: machine.id, error: (error as Error).message }),
        );
      })();
    },

    async retire(machine: Machine): Promise<void> {
      const box = byMachine.get(machine.id);
      if (box) await client.remove(box.id);
    },

    async logs(machine: Machine): Promise<string> {
      const box = byMachine.get(machine.id);
      if (!box || removed.has(box.id)) return "";
      const r = await client.exec(box, `sudo -n sh -c 'cat ${BOX_LAUNCH_DIR}/*.log ${BOX_RUNNER_LOG} 2>/dev/null'; true`, 30).catch(() => null);
      return r?.result ?? "";
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
            o.ledger?.close(kindOf, ledgerName.get(b.id) ?? b.name, "swept");
          },
          () => {},
        );
      }
      return deleted;
    },
  };
}
