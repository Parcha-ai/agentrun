// Slice (a), live: the pipe on a claimed run of a real Archil disk, driven from Node over a real WebSocket.
//   1. pi's storage conformance suite through the pipe, each case on its own store on the mount;
//   2. 200 commits through the pipe (commit p50 against the ping round trip), 20 write-throughs;
//   3. a takeover between two tabs while attached (the old tab's next commit is refused);
//   4. release: run.json sealed with the last commit's sequence, the store re-read after a new claim.
// Every run directory, token user and mount is recorded in the ledger and removed at the end, also on failure.
//   ARCHIL_API_KEY, PDA_LIVE_DISK, PDA_LIVE_REGION (bin/with-archil sets them); DEMO_LEDGER (default ./DEMO-STATE.json)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { EntryId, StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { deleteRunTree, isLeaseFresh } from "@parcha/pi-durable-disk";
import { runConformance } from "../test/_conformance.ts";
import { archilControl, jsonLog, Ledger } from "../pipe/control.ts";
import { createDemoServer } from "../pipe/server.ts";
import { PipeClient, remoteStorage } from "../tab/pipe-client.ts";
import { PipeLostError, toBase64 } from "../wire.ts";

const disk = process.env.PDA_LIVE_DISK!;
const region = process.env.PDA_LIVE_REGION ?? "aws-us-east-1";
const apiKey = process.env.ARCHIL_API_KEY!;
if (!disk || !apiKey) throw new Error("run through bin/with-archil: ARCHIL_API_KEY and PDA_LIVE_DISK are needed");
const ledger = new Ledger(process.env.DEMO_LEDGER ?? "DEMO-STATE.json");
const out = process.env.DEMO_RESULTS ?? "live-pipe-results.json";
const log = jsonLog(process.env.DEMO_LOG);
const mountRoot = "/mnt/pda/demo/pipe";
const stamp = Date.now().toString(36);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : Number(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!.toFixed(2));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const control = await archilControl({ disk, region, apiKey });
const results: Record<string, unknown> = { disk, region, startedAt: new Date().toISOString() };
const created: string[] = [];
const servers: ReturnType<typeof createDemoServer>[] = [];

function server(scratch: boolean) {
  const s = createDemoServer({
    disk,
    region,
    control,
    mountRoot,
    model: { baseUrl: "http://127.0.0.1:9/v1", model: "unused", budgetTokens: 0 },
    lease: { heartbeatMs: 2_000, expiryMs: 10_000, marginMs: 3_000 },
    scratchStores: scratch,
    writerGraceMs: 3_000,
    ledger,
    log,
  });
  servers.push(s);
  return s;
}

try {
  // 1. Conformance, each case on a fresh store on the mount.
  {
    const s = server(true);
    const port = await s.listen(0);
    const { id, secret } = await s.createRun(`demo-conf-${stamp}`);
    created.push(id);
    let n = 0;
    const started = Date.now();
    const report = await runConformance(async (use) => {
      const client = new PipeClient({ url: `ws://127.0.0.1:${port}/ws`, run: id, token: secret, tab: `case-${++n}`, mode: "write", takeover: true });
      await client.ready;
      try {
        await use(remoteStorage(client));
      } finally {
        client.close();
      }
    });
    results.conformance = { ...report, passed: report.total - report.failed.length, ms: Date.now() - started };
    log("conformance", results.conformance as Record<string, unknown>);
    await s.close();
  }

  // 2-4. One run: commits, write-throughs, a takeover, a release and a re-read.
  {
    const s = server(false);
    const port = await s.listen(0);
    const url = `ws://127.0.0.1:${port}/ws`;
    const { id, secret } = await s.createRun(`demo-pipe-${stamp}`);
    created.push(id);
    const t0 = performance.now();
    const a = new PipeClient({ url, run: id, token: secret, tab: "tab-a", mode: "write", pingMs: 200 });
    await a.ready;
    results.attachMs = Math.round(performance.now() - t0);
    const sa = remoteStorage(a);
    await sa.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], ctx);
    const pad = "x".repeat(256);
    let lastSeq = 0;
    for (let n = 0; n < 200; n++) {
      const entryId = await sa.mintId<EntryId>();
      const writes: StorageWrite[] = [{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "demo.chunk", data: { n, pad } } }];
      lastSeq = Number(await sa.commit(writes, ctx));
    }
    for (let n = 0; n < 20; n++) {
      await a.syncFiles([{ path: `notes/file-${n}.txt`, op: "write", data: toBase64(new TextEncoder().encode(`line ${n}\n`.repeat(50))) }]);
    }
    const commitClient = a.timings.commit.slice(1).map((t) => t.client);
    const commitServer = a.timings.commit.slice(1).map((t) => t.server);
    results.commits = {
      n: commitClient.length,
      clientP50: pct(commitClient, 50),
      clientP95: pct(commitClient, 95),
      serverP50: pct(commitServer, 50),
      rttP50: pct(a.rtts, 50),
      lastSeq,
    };
    results.writeThrough = { n: a.timings.files.length, clientP50: pct(a.timings.files.map((t) => t.client), 50), serverP50: pct(a.timings.files.map((t) => t.server), 50) };
    log("commits", results.commits as Record<string, unknown>);

    // 3. Takeover while attached: tab B takes the run; tab A's next commit and write are refused.
    const b = new PipeClient({ url, run: id, token: secret, tab: "tab-b", mode: "write", takeover: true, pingMs: 200 });
    const tb = performance.now();
    const attachedB = await b.ready;
    const takeoverMs = Math.round(performance.now() - tb);
    let refusedCommit = false;
    try {
      const entryId = await sa.mintId<EntryId>();
      await sa.commit([{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "demo.zombie", data: {} } }], ctx);
    } catch (error) {
      refusedCommit = error instanceof PipeLostError;
    }
    let refusedWrite = false;
    try {
      await a.syncFiles([{ path: "zombie.txt", op: "write", data: toBase64(new TextEncoder().encode("zombie")) }]);
    } catch (error) {
      refusedWrite = error instanceof PipeLostError;
    }
    const sb = remoteStorage(b);
    const entryB = await sb.mintId<EntryId>();
    const seqB = Number(await sb.commit([{ type: "entry", value: { id: entryB, conversationId: ROOT_CONVERSATION_ID, kind: "demo.after-takeover", data: {} } }], ctx));
    results.takeover = { ms: takeoverMs, restoredFiles: attachedB.t === "attached" ? attachedB.files.length : null, oldCommitRefused: refusedCommit, oldWriteRefused: refusedWrite, newSeq: seqB };
    log("takeover", results.takeover as Record<string, unknown>);

    // 4. Release (tab B closes and stops pinging), then a new claim reads what was committed.
    b.close();
    a.close();
    const tr = Date.now();
    while (s.runs.get(id)!.placement.where !== "parked" && Date.now() - tr < 20_000) await sleep(100);
    results.releaseAfterCloseMs = Date.now() - tr;
    results.mountedAfterRelease = readFileSync("/proc/mounts", "utf8").includes(` ${join(mountRoot, "runs", id)} `);
    const c = new PipeClient({ url, run: id, token: secret, tab: "tab-c", mode: "write", pingMs: 200 });
    const attachedC = await c.ready;
    const sc = remoteStorage(c);
    const page = await sc.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 500, undefined, ctx);
    const kinds = page.items.map((e) => e.kind);
    const runJson = JSON.parse(readFileSync(join(mountRoot, "runs", id, "run.json"), "utf8"));
    results.reread = {
      generation: runJson.generation,
      entries: page.items.length,
      zombieEntries: kinds.filter((k) => k === "demo.zombie").length,
      afterTakeover: kinds.filter((k) => k === "demo.after-takeover").length,
      chunks: kinds.filter((k) => k === "demo.chunk").length,
      files: attachedC.t === "attached" ? attachedC.files.filter((f) => f.kind === "file").length : null,
      zombieFile: attachedC.t === "attached" ? attachedC.files.some((f) => f.path === "zombie.txt") : null,
      leaseFresh: isLeaseFresh(runJson),
    };
    log("reread", results.reread as Record<string, unknown>);
    c.close();
    await s.close();
  }
} catch (error) {
  results.error = (error as Error).stack ?? String(error);
  log("failed", { error: (error as Error).message });
} finally {
  for (const s of servers) await s.close().catch((error) => log("server.close-failed", { error: (error as Error).message }));
  for (const id of created) {
    try {
      const deleted = await deleteRunTree(control, id);
      ledger.close("run-dir", id, `deleted ${deleted.objects} objects, revoked ${deleted.revoked}`);
    } catch (error) {
      log("cleanup.failed", { run: id, error: (error as Error).message });
    }
  }
  const mounts = readFileSync("/proc/mounts", "utf8").split("\n").filter((l) => l.includes(" /mnt/pda/demo/"));
  results.leftoverMounts = mounts.length;
  results.openLedgerRows = ledger.openRows();
  results.finishedAt = new Date().toISOString();
  writeFileSync(out, `${JSON.stringify(results, null, 1)}\n`);
  log("done", { results: out, openLedgerRows: (results.openLedgerRows as unknown[]).length, leftoverMounts: mounts.length });
  process.exit(results.error ? 1 : 0);
}
