// A claimed run's hands: its Workspace, the computer its place needs and the kernel's tools over them, as a claim opens
// them for any run that works in its folder. An agentic run's spec (adapter-run-spec.ts) and a workflow run whose model
// node names a file tool (workflow-spec.ts) take them the one way, so a workflow node's read, write and edit run on the same
// folder, computer and limits an agentic run's do (main's per-run process bound both from its one run folder: app.ts
// host.coding over where.work).
import type { Context } from "@earendil-works/chord";
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { loadArchilSettings } from "../archil-settings.js";
import type { ComputerSetting } from "../computer-setting.js";
import { INPUTS_DIR, UPLOADS_DIR, Uploads } from "../uploads.js";
import { join } from "node:path";
import { archilClaim, type ArchilClaimOptions, MOUNT_TTL_MS } from "../workspace/archil-claim.js";
import type { ComputerDeps } from "../workspace/computer-deps.js";
import { openRunWorkspace, type RunWorkspace } from "../workspace/run-workspace.js";
import { runTools, type RunTools } from "../workspace/run-tools.js";
import type { ClaimComputer, ComputerForClaim } from "./adapter-run-spec.js";
import type { Claim } from "./loop-contract.js";

/** What a claim's hands are opened with: the runner's store, data directory, environment, seal key and computer seam (the
 *  AdapterSpecDeps fields these read; a test gives its own computer stand-in). */
export interface RunHandsDeps {
  readonly store: Pick<Store, "settings" | "sealedKeys">;
  readonly data: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sealKey?: Buffer;
  readonly log: (message: string) => void;
  readonly computerForClaim: ComputerForClaim;
  readonly computerDeps?: ComputerDeps;
  readonly makeArchilDisk?: ArchilClaimOptions["makeDisk"];
  readonly mountControl?: { readonly baseUrl?: string; readonly fetch?: typeof fetch };
}

/** A claim's hands: the run's mode, its Archil claim (Mode 2), its Workspace, its computer and the kernel's tools over them;
 *  `release` lets them go once the claim writes nothing more through them. */
export interface RunHands {
  readonly mode: 1 | 2;
  readonly archil: Awaited<ReturnType<typeof archilClaim>> | undefined;
  readonly ws: RunWorkspace;
  readonly computer: ClaimComputer;
  readonly tools: RunTools;
  release(): Promise<void>;
}

/** The run's hands for `claim`: its mode, Workspace, uploaded files, computer and tools, as an agentic run's spec opens
 *  them. `launch`: the run's launch (its files, place and computer choice); `runRow`: its agent and revision. */
export async function claimRunHands(deps: RunHandsDeps, claim: Pick<Claim, "runId" | "epoch">, launch: RunLaunch, runRow: { readonly agentId: string; readonly revisionId: string }, context?: Context, signal?: AbortSignal): Promise<RunHands> {
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const ctx = context ?? BACKGROUND_CONTEXT;
  const log = deps.log;
  // The run's mode is the server's: Mode 2 where its Archil settings are saved (archil-settings.ts), the run's folder then
  // on the claim's Archil disk (archil-claim.ts: its keys from the store's sealed rows, under the runner's seal key, in this
  // claim's memory only); else Mode 1, the run's local folder. The same for the pi and the CLI spec.
  const archilSettings = await loadArchilSettings(deps.store as never);
  const mode: 1 | 2 = archilSettings === undefined ? 1 : 2;
  const archil = archilSettings === undefined
    ? undefined
    // The run's mount credential is minted per run the first time a computer's mount asks (archil-mount-credential.ts), on
    // the account key from the server's environment first, then the sealed row; named for the run and this claim's epoch, with
    // a 24 h ttl as the safety net if revoke never comes (revoke normally runs at the run's end, below). A run with no
    // mounting computer never mints one.
    // The mint is lazy (archil-claim.ts token(), k2's run-tools.ts): only a mounting computer asks for it, so a Mode 2 run
    // with no computer makes no control-plane call. mountControl (a test's loopback control-plane fake) is spread into the
    // mount, so no test reaches the real control plane. MOUNT_TTL_MS is the credential's safety net (its computer's 24 h bound), not its lifetime.
    // `signal`, the claim's (aborted on a lost claim or the runner's shutdown, never on a person's stop): archilClaim drops its
    // values and removes the credential on it at once; the release still revokes on every other outcome (idempotent).
    : await archilClaim({ settings: archilSettings, keys: deps.store.sealedKeys, sealKey: deps.sealKey as Buffer, signal: signal ?? new AbortController().signal, env: deps.env, mount: { runId: claim.runId, epoch: claim.epoch, ttlMs: MOUNT_TTL_MS, ...(deps.mountControl ?? {}) }, ...(deps.makeArchilDisk ? { makeDisk: deps.makeArchilDisk } : {}) } as never);
  // The run's Workspace at the claim: Mode 1 the run's local folder (made here, the server's start made it before); Mode 2
  // the run's folder on the disk.
  const ws = archil === undefined
    ? await openRunWorkspace({ mode: 1, agentId: runRow.agentId, runId: claim.runId, data: deps.data, log })
    : await openRunWorkspace({ mode: 2, agentId: runRow.agentId, runId: claim.runId, archil, log });

  // The run's uploaded files, copied into its work/inputs/ before the first turn, as the server's start copied them before
  // the per-run process ran (uploads.copyInto). Once per run: a fresh run has no inputs/ yet; a resumed claim finds them
  // copied and skips, so the copy's name-collision suffixes never duplicate a file across claims.
  if (launch.files?.length) {
    const copied = await ws.workspace.list(INPUTS_DIR).then(() => true, () => false);
    if (!copied) {
      const uploads = new Uploads(join(deps.data, UPLOADS_DIR));
      await uploads.copyInto(ws.workspace, await uploads.readyFiles(launch.files));
    }
  }

  // The run's computer, from the one shared claim-time function (the CLI spec takes the same): none for a runner place, a
  // Docker container for a sandbox, under the claim's epoch (the one fence). It throws computer_unavailable (nothing made)
  // when the computer cannot be had: the run fails in its words.
  const computer = await deps.computerForClaim(
    { runId: claim.runId, epoch: claim.epoch, revisionId: runRow.revisionId, place: launch.place, ...((launch as { computer?: ComputerSetting }).computer !== undefined ? { computer: (launch as { computer?: ComputerSetting }).computer } : {}) },
    deps.store as never,
    // revokeMount removes the run's Archil mount credential when the computer is released (and if a start fails after a mint);
    // the run's end revokes it too (below), so it goes on every outcome even when no computer is made. Idempotent.
    { ...deps.computerDeps, mode, workspace: ws.workspace, sealKey: deps.sealKey, ...(archil ? { revokeMount: () => archil.revoke() } : {}) } as never,
  );

  // The run's mode bounds its shell: 600 s locally or on a computer, 295 s on Archil's serverless exec (Mode 2, none).
  const tools = await runTools(ws.workspace, computer.computer, { mode, context: ctx });

  return {
    mode, archil, ws, computer, tools,
    // The hands go once the claim writes nothing more through them: its tools' end (background processes ended, scratch
    // swept), its computer let go, then its Workspace's end (Mode 2 sweeps the exec spill).
    release: async () => {
      await tools.end().catch((error: unknown) => log(`the run's tools' end failed: ${(error as Error)?.message ?? String(error)}`));
      await computer.release().catch((error: unknown) => log(`the run's computer could not be let go: ${(error as Error)?.message ?? String(error)}`));
      // The run's Archil mount credential, revoked at its end on every outcome, even with no computer (the computer's release
      // revokes it too; revoke is idempotent, so a second call is a no-op). A run that minted none revokes nothing.
      await archil?.revoke().catch((error: unknown) => log(`the run's Archil mount credential could not be revoked: ${(error as Error)?.message ?? String(error)}`));
      await ws.end().catch((error: unknown) => log(`the run's workspace end failed: ${(error as Error)?.message ?? String(error)}`));
    },
  };
}
