// A run on a plain local directory, for one machine: the claim is the directory itself. Nothing mounts and nothing is
// delegated, so nothing but this machine's owner lock stands between two processes and the run: it is for a laptop, a CI
// job or a test, never for a directory another machine can reach.
//
//   const run = await openDurableRun(ref, { ...localRun("/var/runs/run-1"), harness: { models, registry } });
//
// No mount token is needed (`acquire` is replaced). The claim's barrier does not sync the files the agent wrote: the
// store's own commits are made durable by SQLite, and work/ is the operating system's to flush; a power loss can lose what
// it had not written yet. It refuses once the claim is fenced, as a mount's does.
//
// On macOS, for development: it has no /proc/self/fd and no setpriv, so there the run's root is addressed by its path
// (openClaimDir's `byPath`), commands keep the user's rights and the file tools are not confined (archilEnv's defaults),
// and the commands are recorded from ps (process-table.ts). The README's "On macOS" says what that costs.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AcquireOptions, Claim, RunRef } from "./claim.ts";
import { FencedError } from "./errors.ts";
import { openClaimDir, type ClaimDir } from "./status.ts";

export interface LocalRun {
  /** Takes the claim: the directory, made when it is missing. */
  readonly acquire: (options: AcquireOptions) => Promise<Claim>;
  /** Holds the directory open as the run's root; a local directory is not an Archil mount, so its type is not checked. */
  readonly claimDir: (root: string) => Promise<ClaimDir>;
}

/** `openDurableRun`'s `acquire` and `claimDir` for a run in `root`, a directory on this machine. */
export function localRun(root: string): LocalRun {
  const dir = resolve(root);
  return {
    acquire: async ({ ref }) => {
      await mkdir(dir, { recursive: true });
      return new LocalClaim(ref, dir);
    },
    claimDir: (at) => openClaimDir(at, { fstype: null }),
  };
}

class LocalClaim implements Claim {
  readonly ref: RunRef;
  readonly disk: string;
  readonly root: string;
  readonly work: string;
  readonly store: string;
  /** `<root>/commands`: a local run has no unit cgroup, so the next open ends the commands a killed one left running. */
  readonly commands: string;
  readonly reused = false;
  readonly stray = null;
  readonly forced = false;
  readonly timings = { mountMs: 0, verifyMs: 0 };
  #fence: { cause: unknown } | undefined;

  constructor(ref: RunRef, root: string) {
    this.ref = ref;
    this.disk = ref.disk;
    this.root = root;
    this.work = join(root, "work");
    this.store = join(root, "store");
    this.commands = join(root, "commands");
  }

  get fenced(): boolean {
    return this.#fence !== undefined;
  }

  markFenced(cause?: unknown): void {
    this.#fence ??= { cause };
  }

  async barrier(): Promise<{ ms: number }> {
    if (this.#fence) throw new FencedError(`${this.root} is fenced; nothing is retried on it`, { cause: this.#fence.cause });
    return { ms: 0 };
  }

  async release(): Promise<{ via: "none" }> {
    return { via: "none" };
  }
}
