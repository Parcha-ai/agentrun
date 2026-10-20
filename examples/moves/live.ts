// The live ends of the example: this machine as the local host, a Modal VM as the second host, the Archil disk as the run's home.
// This process holds the runner's own credentials (the disk key, the Modal token that starts VMs and ends sandboxes) and the model
// key for the two local generations, which it hands to a child process by environment (never through systemd's argv, which sudo logs).
// The Modal VM gets its model key and its own Modal token from Modal Secrets that someone else created and this code only names.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { archilControl, deleteRunTree, ensureRunning, localHost, modalHost, readRunStatus } from "@parcha/pi-durable-disk";
import type { EnsureResult, HostHandle, HostDriver, ModalHostOptions, ModalSdk } from "@parcha/pi-durable-disk";
import { removeMountToken } from "@parcha/pi-durable-disk/internals";
import { modalBoxes } from "@parcha/pi-transport/box/modal";
import type { MovesDeps, Started } from "./run.ts";
import type { Where } from "./tools.ts";
import { IMAGE_COMMANDS, prepareVm, VM } from "./vm.ts";

export interface LiveOptions {
  /** A directory the take's log and ledger go in. */
  readonly out: string;
  readonly appPath: string;
  readonly packageTarball: Uint8Array;
  readonly transportTarball: Uint8Array;
  readonly appTarball: Uint8Array;
  /** The Modal Secrets' names, as created in the workspace. Their values are not known here. */
  readonly secrets: readonly string[];
  readonly appName: string;
  readonly env: NodeJS.ProcessEnv;
}

/** What the VM's instance is handed from the Secrets, by name: copied into its environment inside the VM, never written there. */
export const INHERIT = ["ANTHROPIC_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"] as const;


/** The peers and the Modal SDK the VM installs. */
export const PEERS = ["@earendil-works/pi-durable@~1.2.0", "@earendil-works/chord@~1.2.0", "@earendil-works/pi-ai@~1.2.0", "modal@0.11.0"];

/**
 * The Modal host's options. Secrets are named, never valued: the model key and the token pair the VM's session uses come from Modal
 * Secrets someone else made, and the launcher copies them into the instance's environment by name. Nothing here holds a value.
 */
export function modalHostOptions(p: { sdk: ModalSdk; image: ModalHostOptions["image"]; appName: string; runId: string; uid: number; gid: number; secrets: readonly string[]; prepare: ModalHostOptions["prepare"] }): ModalHostOptions {
  return {
    sdk: p.sdk,
    appName: p.appName,
    image: p.image,
    runtime: "vm",
    cpu: 4,
    memoryMiB: 8192,
    regions: ["us-east"],
    fleet: "moves",
    namePrefix: `moves-${p.runId.slice(-6)}-`,
    labels: { run: p.runId },
    mountRoot: VM.mountRoot,
    node: VM.node,
    packageDir: VM.packageDir,
    archil: VM.archil,
    user: String(p.uid),
    group: String(p.gid),
    runArgs: ["--app", VM.app],
    env: { MOVES_HOST: "modal" },
    ttlMinutes: 90,
    startTimeoutMs: 900_000,
    stopTimeoutMs: 60_000,
    prepare: p.prepare,
    secrets: [...p.secrets],
    inheritEnv: [...INHERIT],
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function liveDeps(options: LiveOptions): Promise<{ deps: MovesDeps; runId: string; sensitive: string[] }> {
  const { env } = options;
  for (const name of ["ARCHIL_API_KEY", "PDA_LIVE_DISK", "PDA_LIVE_REGION", "ANTHROPIC_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]) if (!env[name]) throw new Error(`${name} is not set`);
  const uid = process.getuid!();
  const gid = process.getgid!();
  const runId = `moves-${Date.now().toString(36)}`;
  const ref = { disk: env.PDA_LIVE_DISK!, region: env.PDA_LIVE_REGION!, id: runId };
  mkdirSync(options.out, { recursive: true });
  /** Exact ids only, written before the call that creates the thing returns. */
  const ledger = (op: "open" | "close", kind: string, id: string) => appendFileSync(join(options.out, "ledger.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), op, kind, id })}\n`);
  const say = (line: string) => {
    console.log(line);
    appendFileSync(join(options.out, "moves-log.txt"), `${line}\n`);
  };

  const control = await archilControl({ apiKey: env.ARCHIL_API_KEY!, disk: ref.disk, region: ref.region });
  const { ModalClient } = (await import("modal" as string)) as { ModalClient: new () => ModalSdk };
  const modal = new ModalClient(); // the runner's own token, from its environment
  const sdk: ModalSdk = {
    apps: modal.apps,
    images: modal.images,
    secrets: modal.secrets,
    sandboxes: {
      create: async (app, image, params) => {
        ledger("open", "sandbox-name", params.name);
        const box = await modal.sandboxes.create(app, image, params);
        ledger("open", "sandbox", box.sandboxId);
        return box;
      },
      fromId: (id) => modal.sandboxes.fromId(id),
      fromName: (app, name) => modal.sandboxes.fromName(app, name),
      list: (p) => modal.sandboxes.list(p),
    },
  };

  const local = localHost({
    mode: "child",
    hostName: "local",
    mountRoot: VM.mountRoot,
    runArgs: ["--app", options.appPath],
    env: { MOVES_HOST: "local", ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY! },
  });
  const modalOptions = modalHostOptions({
    sdk,
    image: () => (modal.images as unknown as { fromRegistry(tag: string): { dockerfileCommands(c: string[]): unknown } }).fromRegistry("ubuntu:24.04").dockerfileCommands([...IMAGE_COMMANDS]),
    appName: options.appName,
    runId,
    uid,
    gid,
    secrets: options.secrets,
    prepare: prepareVm({ uid, gid, packageTarball: options.packageTarball, transportTarball: options.transportTarball, appTarball: options.appTarball, peers: PEERS }),
  });
  const modalVm: HostDriver = modalHost(modalOptions);

  const hostOf = (where: Where): HostDriver => (where === "local" ? local : modalVm);
  const tokens: string[] = [];
  const deps: MovesDeps = {
    sleep,
    say,
    async startOn(where, demand) {
      const host = hostOf(where);
      const result = await ensureRunning(ref, host, { control, demand, create: { uid, gid, mode: 0o755 }, tokenTtl: "2h", tokenPrefix: "pda-moves-" });
      if (result.action !== "started") throw new Error(`the ${where} host did not start the run: ${JSON.stringify(result)}`);
      const done = result as Extract<EnsureResult, { action: "started" }>;
      tokens.push(done.token.identifier);
      ledger("open", "token", done.token.identifier);
      const handle = done.handle as HostHandle;
      const id = String(handle.sandboxId ?? handle.tag ?? handle.unit);
      ledger("open", where === "local" ? "local-instance" : "vm", id);
      const one: Started = { where, id, handle: { host, handle, token: done.token.identifier } };
      return one;
    },
    status: () => readRunStatus(control, runId),
    async stop(one) {
      const { host, handle, token } = one.handle as { host: HostDriver; handle: HostHandle; token: string };
      await host.stop(handle);
      ledger("close", one.where === "local" ? "local-instance" : "vm", one.id);
      await removeMountToken(control, token).catch(() => {});
    },
    async work(name) {
      return new TextDecoder().decode(await control.getObject(`runs/${runId}/work/${name}`));
    },
    async cleanup() {
      const removed: string[] = [];
      const left: string[] = [];
      // The sandboxes the VM's transport made for the threads: found by the run label, ended by exact id.
      try {
        const boxes = modalBoxes(modal as never, { appName: "agentrun-moves" });
        const listed = await boxes.list({ run: runId }, ctx);
        if (listed.ok) {
          for (const ref2 of listed.value) {
            const found = await boxes.attach(ref2.id, ctx);
            if (found.ok && found.value) {
              await found.value.destroy(ctx);
              ledger("close", "thread-sandbox", ref2.id);
              removed.push(`thread sandbox ${ref2.id}`);
            }
          }
        }
      } catch (error) {
        left.push(`thread sandboxes could not be listed: ${(error as Error).message}`);
      }
      for (const token of tokens) await removeMountToken(control, token).catch(() => {});
      await deleteRunTree(control, runId).then(
        () => removed.push(`run ${runId}`),
        (error: unknown) => left.push(`run tree: ${(error as Error).message}`),
      );
      return { removed, left };
    },
  };
  return { deps, runId, sensitive: [env.ANTHROPIC_API_KEY!, env.MODAL_TOKEN_ID!, env.MODAL_TOKEN_SECRET!, env.ARCHIL_API_KEY!] };
}
