// Driver conformance for modalHost: a real instance (the e2e app: faux model, a tick commit every 500 ms) in Modal VM
// sandbox A, which mounts the scratch disk through FUSE; A powered off mid-run (the sandbox terminated); the supervisor
// (this process: the instances are remote) revokes and resumes on sandbox B with every acknowledged tick and no duplicate.
// Every sandbox is tagged pda-fleet=md, is in the ledger before its create returns, and is terminated, also on failure.
//   PDA_LIVE=1 MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... ARCHIL_API_KEY=... PDA_LIVE_DISK=dsk-... \
//     node --test test/live/modal.live.test.ts          (Node 22 or later; `npm i --no-save modal` for the SDK)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findDelegations, removeMountToken, type ControlApi, type RunRef } from "../../src/claim.ts";
import { modalHost, modalSandboxes, type ModalSdk } from "../../src/hosts/modal.ts";
import { ensureRunning, readRunStatus, type EnsureOptions, type EnsureResult, type HostDriver, type HostHandle } from "../../src/supervise.ts";
import { REGION, scratchDisk, scratchDiskId } from "./_archil.ts";
import { statePath } from "./_paths.ts";
import { APP_OUT, ARCHIL_WRAPPER, deletePrefix, MOUNT_ROOT, NODE, PACKAGE_DIR, PDA_ID, prepareBox } from "./_p9.ts";

const LIVE = process.env.PDA_LIVE === "1" && Boolean(process.env.MODAL_TOKEN_ID) && Boolean(process.env.MODAL_TOKEN_SECRET) && Boolean(process.env.ARCHIL_API_KEY);
const FLEET = "md";
// Names the app and the sandboxes of this suite; set PDA_MODAL_APP to put them under your own prefix.
const APP = process.env.PDA_MODAL_APP ?? "pda-live-modal";
const NAME_PREFIX = `${APP}-`;
const LEDGER = statePath("PDA_MODAL_STATE", "MODAL-STATE.json");
const RESULTS = statePath("PDA_MODAL_RESULTS", "MODAL-RESULTS.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = { at: new Date().toISOString() };
const tokens: string[] = [];
const sandboxes: { id: string; terminate: () => Promise<void> }[] = [];
let runId = "";

/** Identifiers only, appended before the call that creates the thing returns. */
const ledger = (op: "open" | "close", kind: string, id: string, note = "") => {
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify({ t: Date.now(), op, kind, id, note })}\n`);
};

type AppEvent = { ev: string; generation: number; n?: number; resumedFrom?: number; duplicates?: number };

after(async () => {
  if (!LIVE) return;
  const cleanup: Record<string, unknown> = {};
  for (const s of sandboxes) await s.terminate().then(() => ledger("close", "sandbox", s.id), (e: unknown) => ((cleanup.terminateErrors ??= []) as unknown[]).push(String(e)));
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  for (const t of tokens) await removeMountToken(control, t).then(() => ledger("close", "token", t), (e: unknown) => ((cleanup.tokenErrors ??= []) as unknown[]).push(String(e)));
  if (runId) {
    for (const d of (await control.listDelegations()).filter((d) => d.path?.replace(/^\/+/, "").startsWith(`runs/${runId}`))) {
      await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId }).catch(() => {});
    }
    cleanup.prefix = await deletePrefix(disk as never, `runs/${runId}/`).catch((e: unknown) => ({ error: (e as Error).message }));
    ledger("close", "subdir", `runs/${runId}/`, JSON.stringify(cleanup.prefix));
  }
  results.cleanup = cleanup;
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
});

test("modalHost: power-off of VM sandbox A mid-run, resume on VM sandbox B with every acknowledged tick", { skip: !LIVE, timeout: 20 * 60_000 }, async () => {
  const { ModalClient } = (await import("modal" as string)) as { ModalClient: new () => { images: { fromRegistry(tag: string): { dockerfileCommands(c: string[]): unknown } } } & ModalSdk };
  const modal = new ModalClient();
  // Every sandbox is recorded the moment the SDK returns it, and terminated in `after` whatever happened.
  const sdk: ModalSdk = {
    apps: modal.apps,
    images: modal.images,
    sandboxes: {
      create: async (app, image, params) => {
        ledger("open", "sandbox", params.name, "create");
        const box = await modal.sandboxes.create(app, image, params);
        ledger("open", "sandbox", box.sandboxId, params.name);
        ledger("close", "sandbox", params.name, `recorded as ${box.sandboxId}`);
        sandboxes.push({ id: box.sandboxId, terminate: () => box.terminate() });
        return box;
      },
      fromId: (id) => modal.sandboxes.fromId(id),
      fromName: (app, name) => modal.sandboxes.fromName(app, name),
      list: (p) => modal.sandboxes.list(p),
    },
  };
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const stamp = Date.now().toString(36);
  runId = `md-live-${stamp}`;
  const ref: RunRef = { disk: scratchDiskId(), region: REGION, id: runId };
  const image = () => modal.images.fromRegistry("ubuntu:24.04").dockerfileCommands(["RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends sudo curl ca-certificates xz-utils >/dev/null && rm -rf /var/lib/apt/lists/*"]);
  const client = modalSandboxes(sdk, { appName: APP, image, runtime: "vm", cpu: 2, memoryMiB: 4096 });
  const prepared: Record<string, unknown>[] = [];
  const driver: HostDriver = modalHost({
    sdk,
    appName: APP,
    image,
    runtime: "vm",
    cpu: 2,
    memoryMiB: 4096,
    fleet: FLEET,
    namePrefix: NAME_PREFIX,
    labels: { "pda-md": stamp },
    mountRoot: MOUNT_ROOT,
    node: NODE,
    packageDir: PACKAGE_DIR,
    archil: ARCHIL_WRAPPER,
    user: "pda",
    runArgs: [`--app=${PACKAGE_DIR}/test/fixtures/e2e-app.ts`, "--heartbeat-ms=1000", "--lease-expiry-ms=600000", "--lease-margin-ms=0"],
    env: { PDA_TEST_OUT: APP_OUT },
    ttlMinutes: 30,
    startTimeoutMs: 300_000,
    stopTimeoutMs: 5_000,
    prepare: async (box, c) => void prepared.push({ box: box.id, ...(await prepareBox(c, box)) }),
  });
  const opts: EnsureOptions = { control: disk as never, leaseExpiryMs: 6_000, stonithTimeoutMs: 30_000, tokenTtl: "1h", tokenPrefix: "pda-md-", create: { uid: PDA_ID, gid: PDA_ID } };
  const events = async (h: HostHandle): Promise<AppEvent[]> => {
    const b = await client.get(String(h.sandboxId));
    if (!b || b.state !== "started") return [];
    const r = await client.exec(b, `cat ${APP_OUT}/${runId}.jsonl 2>/dev/null || true`, 20);
    return r.result.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as AppEvent);
  };
  const acked = (evs: AppEvent[]) => evs.filter((e) => e.ev === "tick").map((e) => e.n!);
  const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1_000): Promise<T> => {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(everyMs)) {
      const v = await fn();
      if (v) return v;
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const tickUntilStarted = async (what: string, timeoutMs = 240_000) => {
    const t0 = Date.now();
    const r = await waitFor(what, async () => {
      const x = await ensureRunning(ref, driver, opts);
      if (x.action === "started") {
        tokens.push(x.token.identifier);
        ledger("open", "token", x.token.identifier, what);
        return x as Extract<EnsureResult, { action: "started" }>;
      }
      return null;
    }, timeoutMs, 2_000);
    return { r, decidedMs: Date.now() - t0 };
  };

  try {
    const a = await tickUntilStarted("start on A");
    if (a.r.created) ledger("open", "subdir", `runs/${runId}/`, "created by ensureRunning");
    const hA = a.r.handle;
    results.startA = { reason: a.r.reason, startMs: a.r.startMs, prepared: prepared[0], handle: hA };
    assert.equal(hA.driver, "modal");
    assert.equal(a.r.reason, "none");
    assert.equal(await driver.status(hA), "running");
    const openedA = await waitFor("A to commit 8 ticks", async () => {
      const evs = await events(hA);
      return acked(evs).length >= 8 ? evs : null;
    }, 240_000, 2_000);
    const ackedA = acked(await events(hA));
    results.instanceA = openedA.find((e) => e.ev === "opened");

    const tKill = Date.now();
    await (await modal.sandboxes.fromId(String(hA.sandboxId))).terminate();
    ledger("close", "sandbox", String(hA.sandboxId), "power-off");

    const b = await tickUntilStarted("takeover on B");
    const hB = b.r.handle;
    results.takeoverB = { reason: b.r.reason, revoked: b.r.revoked, startMs: b.r.startMs, killToDecisionMs: Date.now() - tKill - b.r.startMs, prepared: prepared[1] };
    assert.ok(b.r.reason === "orphaned" || b.r.reason === "lease-expired", `takeover reason ${b.r.reason}`);
    const openedB = await waitFor("B to open and tick", async () => {
      const evs = await events(hB);
      return evs.some((e) => e.ev === "tick") ? evs : null;
    }, 240_000, 1_000);
    const oB = openedB.find((e) => e.ev === "opened")!;
    results.instanceB = { opened: oB, killToFirstTickObservedMs: Date.now() - tKill, ackedOnABeforeKill: ackedA.length, lastAckedOnA: Math.max(...ackedA) };
    assert.equal(oB.generation, 2);
    assert.equal(oB.duplicates, 0, "no tick committed twice");
    assert.ok(oB.resumedFrom! >= Math.max(...ackedA), `B resumed from ${oB.resumedFrom}, A had acknowledged ${Math.max(...ackedA)}`);
    // Modal reports a terminated sandbox as exited a moment after the call returns.
    const tGone = Date.now();
    await waitFor("A gone", async () => (await driver.status(hA)) === "gone", 60_000, 500);
    results.goneAfterTerminateMs = Date.now() - tGone;

    // The agent left a program running with its working directory on the run's mount (a server it started, a browser): it has
    // detached from the instance, which cannot end it, and it would keep the mount busy past the instance's release.
    const boxB = (await client.get(String(hB.sandboxId)))!;
    await client.exec(boxB, `sudo -n -u pda -H bash -c 'cd ${MOUNT_ROOT}/runs/${runId} && setsid -f sleep 3000 </dev/null >/dev/null 2>&1'; pgrep -u pda -x sleep`, 20);
    const tStop = Date.now();
    await driver.stop(hB);
    await waitFor("B gone", async () => (await driver.status(hB)) === "gone", 60_000, 500);
    results.stopToGoneMs = Date.now() - tStop;
    // A planned stop is drain, release, then terminate: the run is paused on the disk and nothing holds its claim. Only a death
    // (A above) may leave a claim for the next takeover. The sleep above held the mount busy: the stop ended it first.
    const record = await readRunStatus(control as never, runId);
    const held = await findDelegations(control, runId);
    results.afterPlannedStop = { status: record?.status, delegations: held.map((d) => ({ orphaned: d.isOrphaned })) };
    assert.ok(["paused", "sleeping"].includes(String(record?.status)), `the run is released, not running (${record?.status})`);
    assert.equal(held.length, 0, "a planned stop leaves no delegation held");
  } finally {
    results.preparedAll = prepared;
  }
});
