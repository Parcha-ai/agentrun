// withClaim and readReleased (design: a short exclusive claim on any disk path, and a consistent S3 read of a released
// file) over the fake archil client (test/fixtures/fake-host.mjs) and a fake control API whose delegations are the fake
// host's holders. No Archil, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delegation } from "disk";
import type { ArchilHost } from "../src/claim.ts";
import { ClaimError, EXIT_FENCED, EXIT_HELD, FencedError, HeldError } from "../src/errors.ts";
import { readReleased, withClaim, type ClaimControl } from "../src/with-claim.ts";
import { disposeAfter } from "./_dispose.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-host.mjs", import.meta.url));
const TOKEN = `tok-${"7".repeat(40)}`;
const DISK = "dsk-0000000000000001";
const REGION = "aws-us-east-1";
const PATH = "agents/a1";
const TARGET = `${DISK}:/${PATH}`;
const REMOTE = "remote";

function rig(init: { behave?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pda-with-claim-"));
  const statePath = join(dir, "state.json");
  const procMounts = join(dir, "mounts");
  const proc = join(dir, "proc");
  const mountRoot = join(dir, "mnt");
  const write = (s: Record<string, unknown>) => {
    writeFileSync(statePath, JSON.stringify(s));
    const mounts = s.mounts as Record<string, { source: string }>;
    writeFileSync(procMounts, Object.entries(mounts).map(([mp, m]) => `${m.source} ${mp} fuse.archil rw,allow_other 0 0`).join("\n") + "\n");
  };
  write({ procMounts, proc, daemons: {}, token: TOKEN, mounts: {}, holders: {}, extraMounts: [], behave: init.behave ?? {}, calls: [] });
  const wrap = (tool: string) => {
    const p = join(dir, tool);
    writeFileSync(p, `#!/bin/sh\nexec '${process.execPath}' '${FIXTURE}' '${statePath}' ${tool} "$@"\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const read = () => JSON.parse(readFileSync(statePath, "utf8")) as { holders: Record<string, string>; mounts: Record<string, { fenced: boolean }>; calls: { tool: string; argv: string[] }[] };
  const host: ArchilHost = {
    archil: wrap("archil"),
    fusermount: wrap("fusermount"),
    sudo: false,
    procMounts,
    proc,
    timeoutMs: { mount: 5_000, sync: 5_000, unmount: 5_000, cli: 5_000, staleGrace: 0 },
    fs: { stat: async () => ({}) },
  };
  return {
    dir,
    host,
    mountRoot,
    read,
    set(fn: (s: ReturnType<typeof read>) => void) {
      const s = read();
      fn(s);
      write(s as unknown as Record<string, unknown>);
    },
    archil: (cmd?: string) => read().calls.filter((c) => c.tool === "archil" && (cmd === undefined || c.argv[0] === cmd)),
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  };
}
type Rig = ReturnType<typeof rig>;

const clientOf = (mountpoint: string) => (mountpoint === REMOTE ? "remote-client" : `local:${mountpoint}`);

/**
 * The control API over the fake host: one delegation per held target (orphaned when the target is in `orphaned`), a
 * revoke that drops the holder and fences its mount, S3 objects from `objects`, and a holder's `.claim` from its mount
 * (a local holder) or from `claims` (a remote one). `log` records every call in order, with how many mounts preceded it.
 */
function fakeControl(r: Rig, init: { orphaned?: Set<string>; claims?: Record<string, string | ((n: number) => string)>; objects?: Record<string, { bytes: string; etag: string }>; onList?: (n: number) => void; onHead?: (key: string, n: number) => void; exec?: (command: string) => { exitCode: number; stdout: string } } = {}) {
  const log: string[] = [];
  let lists = 0;
  let heads = 0;
  let claimReads = 0;
  const note = (call: string) => log.push(`${call} (after ${r.archil("mount").length} mounts)`);
  const control: ClaimControl = {
    async addUser() {
      note("addUser");
      return { identifier: "tok-id-1", token: TOKEN };
    },
    async removeUser(_type, identifier) {
      note(`removeUser ${identifier}`);
    },
    async listDelegations(): Promise<Delegation[]> {
      init.onList?.(++lists);
      note("list");
      return Object.entries(r.read().holders).map(([target, mountpoint], i) => ({
        clientId: clientOf(mountpoint),
        inodeId: 100 + i,
        path: target.slice(target.indexOf(":/") + 2),
        isPending: false,
        isOrphaned: init.orphaned?.has(target) ?? false,
      }));
    },
    async revokeDelegation(d) {
      note(`revoke ${d.clientId}`);
      r.set((s) => {
        for (const [target, mountpoint] of Object.entries(s.holders)) {
          if (clientOf(mountpoint) !== d.clientId) continue;
          delete s.holders[target];
          if (s.mounts[mountpoint]) s.mounts[mountpoint].fenced = true;
        }
      });
    },
    async getObject(key) {
      note(`get ${key}`);
      if (key === `${PATH}/.claim`) {
        const holder = r.read().holders[TARGET];
        const scripted = init.claims?.[key];
        const text = holder === REMOTE ? (typeof scripted === "function" ? scripted(++claimReads) : scripted) : holder ? readFileSync(join(holder, ".claim"), "utf8") : undefined;
        if (text !== undefined) return new TextEncoder().encode(text);
      }
      const object = init.objects?.[key];
      if (!object) throw Object.assign(new Error(`NoSuchKey: ${key}`), { name: "NoSuchKey" });
      return new TextEncoder().encode(object.bytes);
    },
    ...(init.exec ? { exec: async (command: string) => (note(`exec ${command}`), init.exec!(command)) } : {}),
    async headObject(key) {
      init.onHead?.(key, ++heads);
      note(`head ${key}`);
      const object = init.objects?.[key];
      return object ? { etag: object.etag, size: object.bytes.length } : null;
    },
  };
  return { control, log };
}

const where = (control: ClaimControl, path = PATH) => ({ control, disk: DISK, region: REGION, path });
const claimText = (deadline: Date) => JSON.stringify({ pid: 4242, host: "elsewhere", at: new Date(deadline.getTime() - 60_000).toISOString(), deadline: deadline.toISOString() });
const held = (code: string) => (error: unknown) => error instanceof HeldError && error.holder === "claim" && error.code === code && error.exitCode === EXIT_HELD;
const claimError = (code: string) => (error: unknown) => error instanceof ClaimError && error.code === code && error.exitCode === 1;

// ---- withClaim --------------------------------------------------------------------------------------------------------

test("withClaim mounts the path at a fresh mountpoint of its own, runs fn there, then barriers, unmounts and gives the token back", async () => {
  const r = disposeAfter(rig());
  const { control, log } = fakeControl(r);
  let seen: { root: string; path: string } | undefined;
  const value = await withClaim(where(control), async (path) => {
    seen = { root: path.root, path: path.path };
    assert.ok(existsSync(path.root), "fn runs with the path mounted at root"); // (the fake mounts nothing to write into)
    return 42;
  }, { mountRoot: r.mountRoot, host: r.host, holdMs: 60_000 });
  assert.equal(value, 42, "fn's value");
  assert.match(seen!.root, new RegExp(`^${r.mountRoot}/runs/${process.pid}-[0-9a-f-]{36}$`), "a mountpoint of this call's own, in the <root>/runs/<name> shape archil-scoped's cleanup takes");
  assert.equal(seen!.path, PATH);
  const [mount] = r.archil("mount");
  assert.deepEqual(mount!.argv.filter((a) => !a.startsWith("--") && a !== REGION), ["mount", TARGET, seen!.root], "the path's own target, at that mountpoint");
  assert.deepEqual(r.archil().map((c) => c.argv[0]).filter((c) => ["mount", "delegations", "sync", "unmount"].includes(c)), ["mount", "delegations", "sync", "unmount"], "mount, verify, barrier, unmount");
  assert.deepEqual(log.filter((l) => /^(addUser|removeUser)/.test(l)), ["addUser (after 0 mounts)", "removeUser tok-id-1 (after 1 mounts)"], "a token minted for the mount and removed after it");
  assert.equal(existsSync(seen!.root), false, "its mountpoint is gone");
  assert.deepEqual(r.read().holders, {}, "nothing holds the path");
});

test("withClaim refuses a path that is not one safe relative path, or that belongs to the runs, before any control call", async () => {
  const r = disposeAfter(rig());
  const { control, log } = fakeControl(r);
  for (const path of ["", "/agents/a1", "agents/../a1", "agents//a1", "./agents/a1", "agents/a1/", "agents/a 1", "runs", "runs/r1", "runs/r1/store"]) {
    await assert.rejects(withClaim(where(control, path), async () => assert.fail("fn ran"), { mountRoot: r.mountRoot, host: r.host }), claimError("INVALID_ARGUMENT"), JSON.stringify(path));
  }
  assert.deepEqual(log, [], "no control call");
  assert.deepEqual(r.archil(), [], "no archil call");
});

test("withClaim takes the agent home's own path, agent/, and never runs/, a run under it, or the disk root", async () => {
  const r = disposeAfter(rig());
  const { control } = fakeControl(r);
  assert.equal(await withClaim({ control, disk: DISK, region: REGION, path: "agent" }, async (held) => held.path, { mountRoot: r.mountRoot, host: r.host }), "agent");
  assert.equal(r.archil("mount")[0]!.argv.includes(`${DISK}:/agent`), true);
  for (const path of ["runs", "runs/x", ""]) {
    await assert.rejects(withClaim({ control, disk: DISK, region: REGION, path }, async () => assert.fail("fn ran"), { mountRoot: r.mountRoot, host: r.host }), claimError("INVALID_ARGUMENT"), JSON.stringify(path));
  }
});

test("withClaim queues behind a live holder within its deadline, and mounts once it lets go", async () => {
  const r = disposeAfter(rig());
  r.set((s) => void (s.holders[TARGET] = REMOTE));
  const { control, log } = fakeControl(r, {
    claims: { [`${PATH}/.claim`]: claimText(new Date(Date.now() + 60_000)) },
    onList: (n) => n === 3 && r.set((s) => void delete s.holders[TARGET]), // the holder releases between the second and third look
  });
  assert.equal(await withClaim(where(control), async () => "mine", { mountRoot: r.mountRoot, host: r.host, waitMs: 10_000 }), "mine");
  assert.equal(log.filter((l) => l.startsWith("revoke")).length, 0, "a live holder within its deadline is never revoked");
  assert.ok(log.filter((l) => l.startsWith("list")).length >= 3, "it looked again until the holder let go");
  assert.equal(r.archil("mount").length, 1);
});

test("withClaim refuses CLAIM_HELD (76) when a live holder keeps the path past waitMs: nothing mounted, no token minted", async () => {
  const r = disposeAfter(rig());
  r.set((s) => void (s.holders[TARGET] = REMOTE));
  const { control, log } = fakeControl(r, { claims: { [`${PATH}/.claim`]: claimText(new Date(Date.now() + 60_000)) } });
  await assert.rejects(withClaim(where(control), async () => assert.fail("fn ran"), { mountRoot: r.mountRoot, host: r.host, waitMs: 600 }), held("CLAIM_HELD"));
  assert.deepEqual(r.archil("mount"), []);
  assert.equal(log.filter((l) => l.startsWith("addUser") || l.startsWith("revoke")).length, 0, "no token, no revoke");
});

test("withClaim revokes an orphaned holder (its client is gone) before it mounts", async () => {
  const r = disposeAfter(rig());
  r.set((s) => void (s.holders[TARGET] = REMOTE));
  const { control, log } = fakeControl(r, { orphaned: new Set([TARGET]) });
  await withClaim(where(control), async () => undefined, { mountRoot: r.mountRoot, host: r.host });
  const revoke = log.find((l) => l.startsWith("revoke"));
  assert.equal(revoke, "revoke remote-client (after 0 mounts)", "revoked, and before any mount");
  assert.equal(r.archil("mount").length, 1);
});

test("withClaim revokes a live holder past its .claim deadline before it mounts, and never one within it", async () => {
  const r = disposeAfter(rig());
  r.set((s) => void (s.holders[TARGET] = REMOTE));
  const { control, log } = fakeControl(r, { claims: { [`${PATH}/.claim`]: claimText(new Date(Date.now() - 1_000)) } });
  await withClaim(where(control), async () => undefined, { mountRoot: r.mountRoot, host: r.host });
  assert.equal(log.find((l) => l.startsWith("revoke")), "revoke remote-client (after 0 mounts)", "a hung holder past its deadline is revoked first");
  assert.ok(log.some((l) => l === `get ${PATH}/.claim (after 0 mounts)`), "its deadline was read over S3");
});

test("withClaim never revokes a live holder by a .claim that is not its own: a descendant's holder, or a new holder still writing its own", async () => {
  const r = disposeAfter(rig());
  // A live holder of agents/a1/cache, under the path; agents/a1/.claim is a stale one from an earlier holder of agents/a1.
  r.set((s) => void (s.holders[`${DISK}:/${PATH}/cache`] = REMOTE));
  const below = fakeControl(r, { claims: { [`${PATH}/.claim`]: claimText(new Date(Date.now() - 60_000)) } });
  await assert.rejects(withClaim(where(below.control), async () => assert.fail("fn ran"), { mountRoot: r.mountRoot, host: r.host, waitMs: 600 }), held("CLAIM_HELD"));
  assert.equal(below.log.filter((l) => l.startsWith("revoke")).length, 0, "the descendant's holder is not revoked by another path's .claim");
  r.set((s) => void (s.holders = { [TARGET]: REMOTE }));
  // A holder of the path that mounted a moment ago: the expired .claim is its predecessor's until its own lands.
  const fresh = fakeControl(r, { claims: { [`${PATH}/.claim`]: (n) => claimText(new Date(Date.now() + (n === 1 ? -60_000 : 60_000))) } });
  await assert.rejects(withClaim(where(fresh.control), async () => assert.fail("fn ran"), { mountRoot: r.mountRoot, host: r.host, waitMs: 4_000 }), held("CLAIM_HELD"));
  assert.equal(fresh.log.filter((l) => l.startsWith("revoke")).length, 0, "a .claim that changed while it was confirmed is not a lost holder's");
});

test("withClaim does nothing for a caller that aborted: no mount and no fn when aborted before, the abort's reason when aborted while queued", async () => {
  const r = disposeAfter(rig());
  const { control, log } = fakeControl(r);
  const before = new AbortController();
  before.abort();
  await assert.rejects(withClaim(where(control), async () => assert.fail("fn ran"), { mountRoot: r.mountRoot, host: r.host, signal: before.signal }), (error: unknown) => error === before.signal.reason);
  assert.deepEqual(r.archil("mount"), []);
  assert.equal(log.filter((l) => l.startsWith("addUser")).length, 0, "no token");
  r.set((s) => void (s.holders[TARGET] = REMOTE));
  const queued = new AbortController();
  const remote = fakeControl(r, { claims: { [`${PATH}/.claim`]: claimText(new Date(Date.now() + 60_000)) } });
  setTimeout(() => queued.abort(), 300);
  await assert.rejects(withClaim(where(remote.control), async () => assert.fail("fn ran"), { mountRoot: r.mountRoot, host: r.host, signal: queued.signal, waitMs: 10_000 }), (error: unknown) => error === queued.signal.reason);
});

test("withClaim releases on a host whose kernel refuses every unmount (Sysbox): checked in, then moved aside by archil-scoped", async () => {
  const r = disposeAfter(rig({ behave: { sysbox: true } }));
  const { control } = fakeControl(r);
  assert.equal(await withClaim(where(control), async () => "done", { mountRoot: r.mountRoot, host: r.host }), "done");
  assert.equal(r.archil("retire").length, 1, "moved aside by the wrapper's retire");
  assert.deepEqual(r.read().holders, {}, "the delegation was checked in");
});

test("withClaim names a path to exec as a relative path, never as an option (a path may begin with -)", async () => {
  const r = disposeAfter(rig());
  const commands: string[] = [];
  const pathless: Delegation = { clientId: "c9", inodeId: 9, path: undefined as unknown as string, isPending: false, isOrphaned: true };
  const { control } = fakeControl(r, { exec: (command) => (commands.push(command), { exitCode: 0, stdout: "" }) });
  const withPathless: ClaimControl = { ...control, listDelegations: async () => [...(await control.listDelegations()), pathless] };
  await withClaim({ control: withPathless, disk: DISK, region: REGION, path: "-agent" }, async () => undefined, { mountRoot: r.mountRoot, host: r.host });
  assert.ok(commands.length > 0, "the pathless delegation was attributed");
  for (const command of commands) {
    assert.match(command, /\.\/-agent/, command);
    assert.doesNotMatch(command, /[ ]-agent/, `no bare -agent argument: ${command}`);
  }
});

test("withClaim still barriers, unmounts and gives the token back when fn throws, and throws fn's own error", async () => {
  const r = disposeAfter(rig());
  const { control, log } = fakeControl(r);
  const boom = new Error("the carry back's commit failed");
  let root = "";
  await assert.rejects(withClaim(where(control), async (path) => {
    root = path.root;
    throw boom;
  }, { mountRoot: r.mountRoot, host: r.host }), (error: unknown) => error === boom);
  assert.equal(r.archil("sync").length, 1);
  assert.equal(r.archil("unmount").length, 1);
  assert.ok(log.some((l) => l.startsWith("removeUser tok-id-1")));
  assert.equal(existsSync(root), false);
});

test("withClaim is FENCED (75) when the claim was revoked from under fn: the barrier refuses, unmount is tried, the token is removed", async () => {
  const r = disposeAfter(rig());
  const { control, log } = fakeControl(r);
  await assert.rejects(withClaim(where(control), async (path) => {
    r.set((s) => void (s.mounts[path.root]!.fenced = true)); // another caller revoked it: the next fsync is EIO
  }, { mountRoot: r.mountRoot, host: r.host }), (error: unknown) => error instanceof FencedError && error.exitCode === EXIT_FENCED);
  assert.equal(r.archil("unmount").length, 1, "unmount is still tried");
  assert.ok(log.some((l) => l.startsWith("removeUser tok-id-1")));
});

test("withClaim fails CONTROL_API_FAILED on a pathless delegation it cannot attribute, and mounts nothing", async () => {
  const r = disposeAfter(rig());
  const { control } = fakeControl(r);
  const pathless: Delegation = { clientId: "c9", inodeId: 9, path: undefined as unknown as string, isPending: false, isOrphaned: false };
  const withPathless: ClaimControl = { ...control, listDelegations: async () => [pathless] }; // and no exec to resolve it
  await assert.rejects(withClaim(where(withPathless), async () => assert.fail("fn ran"), { mountRoot: r.mountRoot, host: r.host }), claimError("CONTROL_API_FAILED"));
  assert.deepEqual(r.archil("mount"), []);
});

test("two withClaim calls on one path in one process never share a mount: the second waits, then has its own", async () => {
  const r = disposeAfter(rig());
  const { control } = fakeControl(r);
  let running = 0;
  let most = 0;
  const roots: string[] = [];
  let firstIn!: () => void;
  const entered = new Promise<void>((resolve) => (firstIn = resolve));
  const body = async (path: { root: string }) => {
    roots.push(path.root);
    most = Math.max(most, ++running);
    firstIn();
    await new Promise((resolve) => setTimeout(resolve, 300));
    running--;
  };
  const options = { mountRoot: r.mountRoot, host: r.host, waitMs: 10_000 };
  const first = withClaim(where(control), body, options);
  await entered;
  await Promise.all([first, withClaim(where(control), body, options)]);
  assert.equal(most, 1, "never two holders at once");
  assert.equal(new Set(roots).size, 2, "two mountpoints");
});

// ---- readReleased -----------------------------------------------------------------------------------------------------

const FILE = `${PATH}/agent.sqlite`;

test("readReleased reads a released file over S3: no delegation before or after, no WAL with content, nothing moved", async () => {
  const r = disposeAfter(rig());
  const { control, log } = fakeControl(r, { objects: { [FILE]: { bytes: "SQLite format 3", etag: "e1" } } });
  const read = await readReleased({ control, path: PATH }, "agent.sqlite", { sqlite: true });
  assert.equal(new TextDecoder().decode(read!.bytes), "SQLite format 3");
  assert.equal(read!.etag, "e1");
  assert.deepEqual(r.archil(), [], "never a mount");
  const order = log.map((l) => l.replace(/ \(after.*/, ""));
  assert.ok(order.indexOf("list") < order.indexOf(`get ${FILE}`) && order.lastIndexOf("list") > order.indexOf(`get ${FILE}`), `delegations looked at before and after the read: ${order.join(", ")}`);
});

test("readReleased refuses CLAIM_HELD (76) while anything holds the path, and reads nothing", async () => {
  const r = disposeAfter(rig());
  r.set((s) => void (s.holders[TARGET] = REMOTE));
  const { control, log } = fakeControl(r, { objects: { [FILE]: { bytes: "x", etag: "e1" } } });
  await assert.rejects(readReleased({ control, path: PATH }, "agent.sqlite", { sqlite: true }), held("CLAIM_HELD"));
  assert.equal(log.some((l) => l.startsWith(`get ${FILE}`)), false);
});

test("readReleased refuses NOT_RELEASED a store whose WAL still has content (its writer did not checkpoint and close)", async () => {
  const r = disposeAfter(rig());
  const { control } = fakeControl(r, { objects: { [FILE]: { bytes: "x", etag: "e1" }, [`${FILE}-wal`]: { bytes: "frames", etag: "w1" } } });
  await assert.rejects(readReleased({ control, path: PATH }, "agent.sqlite", { sqlite: true }), claimError("NOT_RELEASED"));
});

test("readReleased refuses NOT_RELEASED when a writer committed to the WAL during the read, though the database file did not change", async () => {
  const r = disposeAfter(rig());
  const objects: Record<string, { bytes: string; etag: string }> = { [FILE]: { bytes: "SQLite format 3", etag: "e1" } };
  // A writer mounts, commits to the WAL and lets go without a checkpoint, between the first WAL look and the read.
  const { control } = fakeControl(r, { objects, onHead: (key) => key === FILE && (objects[`${FILE}-wal`] = { bytes: "frames", etag: "w1" }) });
  await assert.rejects(readReleased({ control, path: PATH }, "agent.sqlite", { sqlite: true }), claimError("NOT_RELEASED"));
});

test("readReleased retries a read during which the file moved, then refuses CLAIM_HELD", async () => {
  const r = disposeAfter(rig());
  const objects = { [FILE]: { bytes: "x", etag: "e1" } };
  const { control, log } = fakeControl(r, { objects, onHead: (key) => key === FILE && (objects[FILE] = { bytes: "x", etag: `e${Math.random()}` }) });
  await assert.rejects(readReleased({ control, path: PATH }, "agent.sqlite", { sqlite: true, attempts: 3 }), held("CLAIM_HELD"));
  assert.equal(log.filter((l) => l.startsWith(`get ${FILE}`)).length, 3, "one read per attempt");
});

test("readReleased is null when nothing was released there yet", async () => {
  const r = disposeAfter(rig());
  const { control } = fakeControl(r);
  assert.equal(await readReleased({ control, path: PATH }, "agent.sqlite", { sqlite: true }), null);
});
