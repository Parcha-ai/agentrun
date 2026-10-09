// The direct transport: the machine mounts the run itself (an exclusive Archil mount in the box). A placement is the
// package's `ensureRunning` with the machine's host driver; a takeover first revokes the replaced holder's delegation,
// so the spare's mount never waits on a lease and a holder that is not quite dead is fenced at its next write. The run
// is open once run.json reaches the new generation (the instance wrote it with its holder).
import { ensureRunning, findDelegations, pathlessResolver, readRunStatus, revoke } from "@parcha/pi-durable-disk";
import type { EnsureOptions, HostDriver, HostHandle, HostStatus, PathlessResolver, RunRef } from "@parcha/pi-durable-disk";
import type { Control, Fleet, Machine, Placed, PlaceResult } from "./multiverse.ts";

export interface DirectOptions {
  readonly control: Control;
  /** A host driver whose next start runs the run on `machine` with this environment. */
  driver(machine: Machine, env: Readonly<Record<string, string>>): HostDriver;
  /** Supervisor settings for each start (lease expiry, start grace, token prefix). */
  readonly ensure?: Omit<EnsureOptions, "control" | "demand" | "pathless">;
  /** Each start's mount token, for the caller's ledger. */
  readonly onResource?: (kind: string, id: string, note?: string) => void;
  /** How long a placement waits for the run to open. Default 120 s. */
  readonly openTimeoutMs?: number;
  /** The package calls; replaceable so tests can script the disk. */
  readonly ops?: Partial<{ ensureRunning: typeof ensureRunning; revoke: typeof revoke; readRunStatus: typeof readRunStatus }>;
}

type DirectPlaced = Placed & { readonly driver: HostDriver; readonly handle: HostHandle };

export type DirectPlacement = Pick<Fleet, "transport" | "place" | "status" | "seal"> & {
  /** Attribute the disk's pathless delegations now (one exec), off every start's clock. */
  primeResolver(): Promise<void>;
};

export function directPlacement(o: DirectOptions): DirectPlacement {
  const ops = { ensureRunning, revoke, readRunStatus, ...o.ops };
  // One resolver for every decision: a pathless delegation's run is looked up once (an exec), not once per start.
  const pathless: PathlessResolver = pathlessResolver(o.control);
  const mine = (p: Placed): DirectPlaced => {
    const d = p as Partial<DirectPlaced>;
    if (!d.driver || !d.handle) throw new Error(`${p.run.id} on ${p.machine.id} is not a direct placement`);
    return d as DirectPlaced;
  };

  async function waitOpen(run: RunRef, generation: number): Promise<number> {
    const deadline = Date.now() + (o.openTimeoutMs ?? 120_000);
    for (;;) {
      const record = await ops.readRunStatus(o.control, run.id).catch(() => null);
      if (record && record.status === "running" && record.generation >= generation) return Date.now();
      if (Date.now() > deadline) throw new Error(`${run.id} did not open in ${o.openTimeoutMs ?? 120_000} ms`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    transport: "direct",

    async primeResolver() {
      await findDelegations(o.control, "prime-pathless-resolver", pathless).catch(() => undefined);
    },

    async place(run: RunRef, machine: Machine, env: Readonly<Record<string, string>>, from?: Placed): Promise<PlaceResult> {
      const before = await ops.readRunStatus(o.control, run.id).catch(() => null);
      const revoked = from ? (await ops.revoke(o.control, run.id)).length : 0;
      const driver = o.driver(machine, env);
      const result = await ops.ensureRunning(run, driver, { ...o.ensure, control: o.control, pathless, demand: true });
      if (result.action !== "started") throw new Error(`the supervisor did not start ${run.id}: ${result.action}`);
      o.onResource?.("token", result.token.identifier, result.token.nickname);
      const launchedAt = Date.now();
      const openedAt = await waitOpen(run, (before?.generation ?? 0) + 1);
      const placed: DirectPlaced = { run, machine, driver, handle: result.handle };
      return { placed, revoked, launchedAt, openedAt, ...(result.startMs === undefined ? {} : { startMs: result.startMs }) };
    },

    async status(p: Placed): Promise<HostStatus> {
      const d = mine(p);
      return d.driver.status(d.handle);
    },

    /** The driver's stop drains the instance (it releases: barrier, seal, unmount) and deletes the machine. */
    async seal(p: Placed): Promise<void> {
      const d = mine(p);
      await d.driver.stop(d.handle);
    },
  };
}
