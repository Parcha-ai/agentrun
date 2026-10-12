// The VM that hosts the session for `run.ts --session vm`, the robot demo's way: its VM image (vm/image.ts), its prepare
// script (the package and the app into the image's app directory, archil-scoped, the run user), and the package's
// supervisor (modalHost + ensureRunning) starting `pi-durable-disk run --app gg-vm-app.mjs` on a new run of the Archil
// disk. The keys the app needs go to a directory only the run user reads; the mount token stays on the package's path.
//   MODAL_TOKEN_ID/SECRET, ARCHIL_API_KEY in the environment
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRunTree, ensureRunning, modalHost, removeMountToken } from "@parcha/pi-durable-disk";
import type { DaytonaClient, HostHandle, ModalSdk, RunRef, SandboxInfo } from "@parcha/pi-durable-disk";
import { ModalClient } from "modal";
import { archilControl } from "../../../03-tab-to-cloud/pipe/control.ts";
import { cleanOnFailure } from "./lifecycle.ts";

// The robot demo's VM recipe, prepare script and lease flags, loaded by path at run time: their modules carry WebSocket
// types this example does not depend on.
const robot = async <T>(path: string) => (await import(new URL(path, import.meta.url).href)) as T;
const { vmImageCommands } = await robot<{ vmImageCommands(uid: number, gid: number): string[] }>("../../vm/image.ts");
const { BOX_APP_DIR, BOX_MOUNT_ROOT, BOX_NODE, BOX_PACKAGE, prepareScript } = await robot<{ BOX_APP_DIR: string; BOX_MOUNT_ROOT: string; BOX_NODE: string; BOX_PACKAGE: string; prepareScript(uid: number, gid: number): string }>(
  "../../../03-tab-to-cloud/pipe/daytona.ts",
);
const { CLOUD_LEASE } = await robot<{ CLOUD_LEASE: string[] }>("../../../03-tab-to-cloud/pipe/cloud.ts");

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = join(HERE, "..");
const PACKAGE = join(ROOT, "..", "..", "..");
const APP = "gg-vm-app.mjs";
const KEYS = "/etc/gg-onemore";
const EVENTS = "/var/tmp/gg-vm/events.jsonl";
const UID = 1000;
const DEPENDENCIES = { "@earendil-works/pi-durable": "1.0.4", "@earendil-works/chord": "1.0.4", "@earendil-works/pi-ai": "1.0.4", ws: "8.21.3", disk: "1.7.0" };

type Log = (event: string, data?: Record<string, unknown>) => void;

/** The package (npm pack of this checkout's built package), the app bundle and their manifest, as prepareScript unpacks them. */
function appTarball(): Uint8Array {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-vm-app-"));
  try {
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", dir], { cwd: PACKAGE, encoding: "utf8" });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const tgz = packed.stdout.trim().split("\n").at(-1)!;
    copyFileSync(join(ROOT, "dist", APP), join(dir, APP));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "gg-onemore-vm", private: true, type: "module", dependencies: { "@parcha/pi-durable-disk": `file:./${tgz}`, ...DEPENDENCIES } }));
    const tar = spawnSync("tar", ["-czf", "-", "-C", dir, "."], { maxBuffer: 64 << 20 });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    return new Uint8Array(tar.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface VmSession {
  readonly ref: RunRef;
  readonly sandboxId: string;
  /** Root shell in the VM. */
  shell(cmd: string, seconds?: number): Promise<string>;
  /** Stop the instance, remove its mount token and, unless `keep`, the run's tree on the disk. */
  close(keep: boolean): Promise<void>;
}

export async function startVmSession(o: { tunnel: string; keys: { openai: string; serve: string; exec: string }; log: Log; disk?: string; region?: string }): Promise<VmSession> {
  const sdk = new ModalClient();
  const disk = o.disk ?? process.env.PDA_LIVE_DISK ?? "dsk-00000000000baf76";
  const region = o.region ?? process.env.PDA_LIVE_REGION ?? "aws-us-east-1";
  const ref: RunRef = { disk, region, id: `gg-onemore-${Date.now().toString(36)}` };
  const t0 = Date.now();
  const app = await sdk.apps.fromName("pda-gg-onemore", { createIfMissing: true });
  const image = await sdk.images.fromRegistry("ubuntu:24.04").dockerfileCommands(vmImageCommands(UID, UID)).build(app);
  o.log("vm.image", { image: image.imageId, ms: Date.now() - t0 });
  const control = await archilControl({ disk, region, apiKey: process.env.ARCHIL_API_KEY ?? "" });
  const tarball = appTarball();
  const prepare = async (box: SandboxInfo, c: DaytonaClient) => {
    const started = Date.now();
    await c.upload(box, "/tmp/pda-demo-app.tar.gz", tarball);
    const r = await c.exec(box, prepareScript(UID, UID), 900);
    if (r.exitCode !== 0) throw new Error(`preparing the VM failed (${r.exitCode}): ${r.result.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    const mk = await c.exec(box, `install -d -m 0700 -o pda -g pda ${KEYS} && install -d -m 0755 -o pda -g pda ${EVENTS.replace(/\/[^/]+$/, "")}`, 30);
    if (mk.exitCode !== 0) throw new Error(`staging the keys failed: ${mk.result.slice(0, 200)}`);
    for (const [name, value] of Object.entries(o.keys)) await c.upload(box, `${KEYS}/${name}.key`, new TextEncoder().encode(`${value}\n`));
    const own = await c.exec(box, `chown pda:pda ${KEYS}/*.key && chmod 0400 ${KEYS}/*.key`, 30);
    if (own.exitCode !== 0) throw new Error(`staging the keys failed: ${own.result.slice(0, 200)}`);
    o.log("vm.prepared", { ms: Date.now() - started });
  };
  const driver = modalHost({
    sdk: sdk as unknown as ModalSdk,
    appName: "pda-gg-onemore",
    image: image.imageId,
    runtime: "vm",
    cpu: 2,
    memoryMiB: 4096,
    regions: ["us-east"],
    fleet: "gg-onemore",
    namePrefix: "gg-vm-",
    mountRoot: BOX_MOUNT_ROOT,
    node: BOX_NODE,
    packageDir: BOX_PACKAGE,
    user: "pda",
    group: "pda",
    runArgs: ["--app", `${BOX_APP_DIR}/${APP}`, ...CLOUD_LEASE],
    env: { GG_TUNNEL: o.tunnel, GG_KEYS: KEYS, GG_EVENTS: EVENTS },
    stopTimeoutMs: 15_000,
    ttlMinutes: 60,
    startTimeoutMs: 600_000,
    prepare,
  });
  const result = await ensureRunning(ref, driver, { control, demand: true, create: { uid: UID, gid: UID }, tokenPrefix: "gg-onemore-", leaseExpiryMs: 10_000, startGraceMs: 60_000 });
  if (result.action !== "started") throw new Error(`the supervisor did not start the run: ${JSON.stringify(result).slice(0, 300)}`);
  const handle: HostHandle = result.handle;
  const sandboxId = String(handle.sandboxId);
  const close = async (keep: boolean) => {
    await driver.stop(handle).catch((e) => o.log("vm.stop_failed", { error: String(e) }));
    await removeMountToken(control, result.token.identifier).catch((e) => o.log("vm.token_failed", { error: String(e) }));
    if (!keep) {
      const gone = await deleteRunTree(control, ref.id).catch((e) => ({ error: String(e) }));
      o.log("vm.run_deleted", { run: ref.id, ...gone });
    }
    o.log("vm.closed", { run: ref.id });
  };
  // the VM runs from here on: anything that fails before the caller has `close` cleans up first
  return cleanOnFailure(
    () => close(false),
    async () => {
      o.log("vm.started", { run: ref.id, sandbox: sandboxId, startMs: result.startMs, ms: Date.now() - t0 });
      const sandbox = await sdk.sandboxes.fromId(sandboxId);
      return {
        ref,
        sandboxId,
        async shell(cmd: string, seconds = 120) {
          const p = await sandbox.exec(["bash", "-lc", cmd], { mode: "text", timeoutMs: seconds * 1000 });
          const out = await p.stdout.readText();
          await p.wait();
          return out;
        },
        close,
      };
    },
  );
}

export function readKey(path: string): string {
  return readFileSync(path, "utf8").trim();
}
