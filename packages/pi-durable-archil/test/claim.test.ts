// Claim unit tests over a fake archil client (test/fixtures/fake-host.mjs) and a fake control API. No Archil, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delegation } from "disk";
import {
  acquire,
  CLAIM_PROBE,
  createRunDir,
  findDelegations,
  mintMountToken,
  parseTokenNickname,
  removeMountToken,
  revoke,
  runInode,
  runPath,
  takeOver,
  tokenNickname,
  unmountClaim,
  type ArchilHost,
  type ControlApi,
} from "../src/claim.ts";
import { archilEnv, type ArchilEnvClaim } from "../src/env.ts";
import { ClaimError, EXIT_FENCED, EXIT_HELD, exitCodeFor, FencedError, HeldError, ownWriteFenced, PdaError } from "../src/errors.ts";
import { disposeAfter } from "./_dispose.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-host.mjs", import.meta.url));
const TOKEN = `tok-${"7".repeat(40)}`;
const API_KEY_SENTINEL = "api-key-that-must-not-reach-children";
const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1", id: "r1" };
const TARGET = `${REF.disk}:/runs/r1`;

type FakeMount = { source: string; alive: boolean; fenced: boolean; delegation: string | null };
type FakeState = {
  procMounts: string;
  proc: string;
  daemons: Record<string, string[]>;
  token: string;
  mounts: Record<string, FakeMount>;
  holders: Record<string, string>;
  extraMounts: string[];
  behave: Record<string, unknown>;
  calls: { tool: string; argv: string[]; envKeys: string[]; envHasToken: boolean; argvHasToken: boolean; stdin?: "token" | "empty" | "other" }[];
};

function rig(init: { behave?: Record<string, unknown>; sudo?: boolean; extraMounts?: string[]; persist?: ArchilHost["fs"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pda-claim-"));
  const statePath = join(dir, "state.json");
  const procMounts = join(dir, "mounts");
  const proc = join(dir, "proc");
  const mountRoot = join(dir, "mnt");
  const root = join(mountRoot, "runs", REF.id);
  const state: FakeState = { procMounts, proc, daemons: {}, token: TOKEN, mounts: {}, holders: {}, extraMounts: init.extraMounts ?? [], behave: init.behave ?? {}, calls: [] };
  const write = (s: FakeState) => {
    writeFileSync(statePath, JSON.stringify(s));
    rmSync(proc, { recursive: true, force: true });
    for (const [pid, argv] of Object.entries(s.daemons)) {
      mkdirSync(join(proc, pid), { recursive: true });
      writeFileSync(join(proc, pid, "cmdline"), argv.join("\0") + "\0");
    }
    const lines = [...s.extraMounts, ...Object.entries(s.mounts).map(([mp, m]) => `${m.source} ${mp} fuse.archil rw,allow_other 0 0`)];
    writeFileSync(procMounts, lines.join("\n") + "\n");
  };
  write(state);
  const wrap = (tool: string) => {
    const p = join(dir, tool);
    writeFileSync(p, `#!/bin/sh\nexec '${process.execPath}' '${FIXTURE}' '${statePath}' ${tool} "$@"\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const dead = new Set<string>();
  const host: ArchilHost = {
    archil: wrap("archil"),
    fusermount: wrap("fusermount"),
    sudo: init.sudo ? wrap("sudo") : false,
    procMounts,
    proc,
    timeoutMs: { mount: 5_000, sync: 5_000, unmount: 5_000, cli: 5_000, staleGrace: 0 },
    fs: {
      stat: async (p: string) => {
        if (dead.has(p)) throw Object.assign(new Error(`ENOTCONN: socket is not connected, stat '${p}'`), { code: "ENOTCONN" });
        return {};
      },
      ...init.persist,
    },
  };
  const read = () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
  return {
    dir,
    host,
    mountRoot,
    root,
    read,
    set(fn: (s: FakeState) => void) {
      const s = read();
      fn(s);
      write(s);
    },
    calls: (tool: string, cmd?: string) => read().calls.filter((c) => c.tool === tool && (cmd === undefined || c.argv[0] === cmd)),
    dead,
    opts: { ref: REF, token: TOKEN, mountRoot, host },
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type Rig = ReturnType<typeof rig>;

function liveMount(r: Rig, mp = r.root) {
  mkdirSync(mp, { recursive: true });
  r.set((s) => {
    s.mounts[mp] = { source: `${TARGET}[${REF.region}]`, alive: true, fenced: false, delegation: "Active" };
    s.holders[TARGET] = mp;
  });
}

function fakeControl(dels: Delegation[] = [], fail: { list?: Error; revoke?: Error; put?: unknown; add?: Error; addEmpty?: boolean; remove?: Error } = {}, onRevoke?: (d: Pick<Delegation, "clientId" | "inodeId">) => void) {
  const calls = { put: [] as unknown[][], add: [] as unknown[], remove: [] as unknown[][], revoke: [] as unknown[] };
  let held = [...dels];
  const control: ControlApi = {
    async putObject(key, body, options) {
      calls.put.push([key, body, options]);
      if (fail.put) throw fail.put;
    },
    async addUser(user) {
      calls.add.push(user);
      if (fail.add) throw fail.add;
      return fail.addEmpty ? {} : { identifier: "tok-id-1", token: TOKEN };
    },
    async removeUser(type, identifier) {
      calls.remove.push([type, identifier]);
      if (fail.remove) throw fail.remove;
    },
    async listDelegations() {
      if (fail.list) throw fail.list;
      return held;
    },
    async revokeDelegation(d) {
      calls.revoke.push(d);
      if (fail.revoke) throw fail.revoke;
      held = held.filter((x) => !(x.clientId === d.clientId && x.inodeId === d.inodeId));
      onRevoke?.(d);
    },
  };
  return { control, calls };
}

const del = (path: string | undefined, clientId = "c1", inodeId = 1): Delegation => ({ clientId, inodeId, path, isPending: false, isOrphaned: false });

// ---- errors -----------------------------------------------------------------------------------------------------------

test("errors carry their exit codes, codes and causes", () => {
  const cause = new Error("x");
  const fenced = new FencedError("lost", { cause });
  assert.equal(fenced.code, "FENCED");
  assert.equal(fenced.exitCode, EXIT_FENCED);
  assert.equal(fenced.cause, cause);
  assert.equal(fenced.name, "FencedError");
  assert.ok(fenced instanceof PdaError);
  const claim = new HeldError("claim", "held");
  const lock = new HeldError("owner-lock", "held");
  assert.deepEqual([claim.code, claim.exitCode, claim.holder], ["CLAIM_HELD", EXIT_HELD, "claim"]);
  assert.deepEqual([lock.code, lock.exitCode, lock.holder], ["OWNER_LOCK_HELD", 76, "owner-lock"]);
  assert.equal(new ClaimError("MOUNT_FAILED", "no").exitCode, 1);
  assert.deepEqual([fenced, claim, new ClaimError("MOUNT_FAILED", "x"), new Error("x"), "x"].map(exitCodeFor), [75, 76, 1, 1, 1]);
});

test("any error writing a file the claim owns is a fence, whatever its errno", () => {
  const causes: unknown[] = [
    ...["EIO", "EROFS", "ENOENT", "EACCES", "ENOTCONN", "ENOSPC"].map((code) => Object.assign(new Error(`${code}: on write`), { code })),
    Object.assign(new Error("unable to open database file"), { code: "ERR_SQLITE_ERROR", errcode: 14 }),
    "not even an Error",
  ];
  for (const cause of causes) {
    const err = ownWriteFenced("/mnt/archil/runs/r1/run.json", cause);
    assert.ok(err instanceof FencedError && err.exitCode === 75, String(cause));
    assert.equal(err.cause, cause);
    assert.match(err.message, /run\.json/);
  }
});

// ---- supervisor side --------------------------------------------------------------------------------------------------

test("run ids are one safe path segment", () => {
  assert.equal(runPath("r1"), "runs/r1");
  assert.equal(runPath("a.B-c_9"), "runs/a.B-c_9");
  for (const bad of ["", ".", "..", "a/b", "../x", "-x", ".x", "a b", "x".repeat(129)]) {
    assert.throws(() => runPath(bad), (e: unknown) => e instanceof ClaimError && e.code === "INVALID_ARGUMENT");
  }
});

test("createRunDir puts the slash-terminated marker with uid, gid and mode; 409 means held", async () => {
  const { control, calls } = fakeControl();
  await createRunDir(control, "r1", { uid: 1000, gid: 1000 });
  await createRunDir(control, "r2", { uid: 1001, gid: 1002, mode: 0o750 });
  assert.deepEqual(calls.put, [
    ["runs/r1/", "", { uid: 1000, gid: 1000, mode: 0o755 }],
    ["runs/r2/", "", { uid: 1001, gid: 1002, mode: 0o750 }],
  ]);
  const held = fakeControl([], { put: Object.assign(new Error("409 OperationAborted"), { status: 409 }) });
  await assert.rejects(createRunDir(held.control, "r1", { uid: 1, gid: 1 }), (e: unknown) => e instanceof HeldError && e.exitCode === 76);
  const broken = fakeControl([], { put: Object.assign(new Error("500"), { status: 500 }) });
  await assert.rejects(createRunDir(broken.control, "r1", { uid: 1, gid: 1 }), (e: unknown) => e instanceof ClaimError && e.code === "CONTROL_API_FAILED");
  await assert.rejects(createRunDir(control, "../x", { uid: 1, gid: 1 }), (e: unknown) => (e as ClaimError).code === "INVALID_ARGUMENT");
});

test("tokenNickname and parseTokenNickname round-trip a run id with dashes and dots; anything else parses to null", () => {
  const at = 1_791_300_123_456;
  for (const id of ["r1", "p5-mux6-t6", "run.v2-g7-x", "a"]) {
    const nick = tokenNickname(id, 12, at);
    assert.deepEqual(parseTokenNickname(nick), { runId: id, attempt: 12, at }, nick);
  }
  assert.deepEqual(parseTokenNickname(tokenNickname("r1", 0, at, "pda-p5-"), "pda-p5-"), { runId: "r1", attempt: 0, at });
  for (const bad of ["pda-r1", "other-r1-g1-abc", "pda--g1-abc", "pda-r1-gx-abc", "pda-../x-g1-abc", "pda-r1-g1-ABC"]) assert.equal(parseTokenNickname(bad), null, bad);
  assert.throws(() => tokenNickname("../x", 1), (e: unknown) => (e as ClaimError).code === "INVALID_ARGUMENT");
  assert.throws(() => tokenNickname("r1", -1), (e: unknown) => (e as ClaimError).code === "INVALID_ARGUMENT");
});

test("mintMountToken mints a reusable 24 h token by default, named after its run and attempt; removeMountToken removes it", async () => {
  const { control, calls } = fakeControl();
  assert.deepEqual(await mintMountToken(control, { nickname: "pda-r1" }), { token: TOKEN, identifier: "tok-id-1", nickname: "pda-r1" });
  await mintMountToken(control, { nickname: "pda-r1b", ttl: "2h", oneUse: true });
  const named = await mintMountToken(control, { run: { id: "r1", attempt: 3 }, now: () => 1_791_300_000_000 });
  assert.equal(named.nickname, `pda-r1-g3-${(1_791_300_000_000).toString(36)}`);
  assert.deepEqual(calls.add, [
    { type: "token", nickname: "pda-r1", ttl: "24h", oneUse: false },
    { type: "token", nickname: "pda-r1b", ttl: "2h", oneUse: true },
    { type: "token", nickname: named.nickname, ttl: "24h", oneUse: false },
  ]);
  await assert.rejects(mintMountToken(control, {}), (e: unknown) => (e as ClaimError).code === "INVALID_ARGUMENT");
  await removeMountToken(control, "tok-id-1");
  assert.deepEqual(calls.remove, [["token", "tok-id-1"]]);
  const isApi = (e: unknown) => e instanceof ClaimError && e.code === "CONTROL_API_FAILED";
  await assert.rejects(mintMountToken(fakeControl([], { addEmpty: true }).control, { nickname: "n", ttl: "1h" }), isApi);
  await assert.rejects(mintMountToken(fakeControl([], { add: new Error("boom") }).control, { nickname: "n", ttl: "1h" }), isApi);
  await assert.rejects(removeMountToken(fakeControl([], { remove: new Error("boom") }).control, "x"), isApi);
});

test("revoke takes the run's delegation and its children by path, never a sibling or a parent", async () => {
  const dels = [del("runs/r1", "a", 1), del("/runs/r1/store/run.sqlite", "b", 2), del("runs/r10", "c", 3), del("runs", "d", 4), del(undefined, "e", 5), del("runs/r2", "f", 6)];
  const { control, calls } = fakeControl(dels);
  assert.deepEqual((await findDelegations(control, "r1")).map((d) => d.clientId), ["a", "b"]);
  assert.deepEqual((await revoke(control, "r1")).map((d) => d.clientId), ["a", "b"]);
  assert.deepEqual(calls.revoke, [dels[0], dels[1]]);
  assert.deepEqual((await control.listDelegations()).map((d) => d.clientId), ["c", "d", "e", "f"]);
  const isApi = (e: unknown) => e instanceof ClaimError && e.code === "CONTROL_API_FAILED";
  await assert.rejects(revoke(fakeControl(dels, { list: new Error("503") }).control, "r1"), isApi);
  await assert.rejects(revoke(fakeControl(dels, { revoke: new Error("503") }).control, "r1"), isApi);
});

/**
 * A disk root with real `runs/<id>` directories and an `exec` that runs the claim's command there with sh, as
 * `Disk.exec` does at the disk root: the command's quoting, existence test and stat are the real ones, and a
 * delegation's inode is the directory's real inode.
 */
function diskRoot(ids: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pda-diskroot-"));
  for (const id of ids) mkdirSync(join(dir, "runs", id), { recursive: true });
  const commands: string[] = [];
  const exec = async (command: string) => {
    commands.push(command);
    const r = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  return { dir, exec, commands, inode: (id: string) => statSync(join(dir, "runs", id)).ino, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}

const pathless = (clientId: string, inodeId: number, isOrphaned = true): Delegation => ({ clientId, inodeId, path: undefined, isPending: false, isOrphaned });

test("a delegation listed without a path is the run's when it sits on the inode runs/<id> resolves to now", async () => {
  const root = disposeAfter(diskRoot(["r1", "r2"]));
  const dels = [pathless("x", root.inode("r1")), pathless("y", root.inode("r2")), pathless("z", 999_999_999)];
  const { control, calls } = fakeControl(dels);
  control.exec = root.exec;
  assert.deepEqual((await findDelegations(control, "r1")).map((d) => d.clientId), ["x"]);
  assert.deepEqual((await revoke(control, "r1")).map((d) => d.clientId), ["x"]);
  assert.deepEqual(calls.revoke, [dels[0]]);
  assert.deepEqual((await control.listDelegations()).map((d) => d.clientId), ["y", "z"], "another run's pathless delegation is left alone");
  assert.equal(await runInode(control, "r2"), root.inode("r2"));
});

test("the inode is resolved only when nothing matches by path and some entry has no path", async () => {
  const root = disposeAfter(diskRoot(["r1"]));
  for (const [dels, resolves] of [
    [[del("runs/r1", "a"), pathless("x", root.inode("r1"))], false],
    [[del("runs/r2", "b")], false],
    [[], false],
    [[pathless("x", root.inode("r1"))], true],
  ] as const) {
    const { control } = fakeControl([...dels]);
    control.exec = root.exec;
    root.commands.length = 0;
    await findDelegations(control, "r1");
    assert.equal(root.commands.length, resolves ? 1 : 0, JSON.stringify(dels));
  }
});

test("a run directory that does not exist holds no pathless delegation", async () => {
  const root = disposeAfter(diskRoot([]));
  const { control } = fakeControl([pathless("x", 12345)]);
  control.exec = root.exec;
  assert.equal(await runInode(control, "r1"), null);
  assert.deepEqual(await findDelegations(control, "r1"), []);
});

test("a pathless delegation that cannot be attributed is CONTROL_API_FAILED, never none", async () => {
  const isApi = (e: unknown) => e instanceof ClaimError && e.code === "CONTROL_API_FAILED";
  const execs: [string, ControlApi["exec"]][] = [
    ["no exec", undefined],
    ["exec throws", async () => Promise.reject(new Error("504 Gateway Time-out"))],
    ["stat fails", async () => ({ exitCode: 1, stdout: "", stderr: "stat: I/O error" })],
    ["not a number", async () => ({ exitCode: 0, stdout: "runs/r1\n" })],
  ];
  for (const [why, exec] of execs) {
    const { control } = fakeControl([pathless("x", 7)]);
    control.exec = exec;
    await assert.rejects(findDelegations(control, "r1"), isApi, why);
    await assert.rejects(revoke(control, "r1"), isApi, why);
  }
});

// ---- acquire ----------------------------------------------------------------------------------------------------------

test("acquire mounts exclusively with a fixed argv, the token only on the wrapper's stdin, then verifies and probes", async () => {
  const r = disposeAfter(rig());
  process.env.ARCHIL_API_KEY = API_KEY_SENTINEL;
  process.env.ARCHIL_MOUNT_TOKEN = TOKEN; // even a token in the parent's environment never reaches a child
  try {
    const claim = await acquire(r.opts);
    const [mount] = r.calls("archil", "mount");
    assert.deepEqual(mount.argv, ["mount", TARGET, r.root, "--region", REF.region]);
    assert.equal(mount.stdin, "token");
    assert.ok(!mount.envKeys.includes("ARCHIL_API_KEY"));
    for (const c of r.read().calls) {
      assert.equal(c.argvHasToken, false, `${c.argv[0]}: the token is never an argument`);
      assert.equal(c.envHasToken, false, `${c.argv[0]}: the token is in no child's environment`);
      assert.ok(!c.envKeys.includes("ARCHIL_MOUNT_TOKEN"), `${c.argv[0]}: no ARCHIL_MOUNT_TOKEN variable`);
    }
    assert.deepEqual(r.calls("archil").map((c) => c.argv[0]), ["mount", "delegations"]);
    assert.deepEqual([claim.root, claim.work, claim.store], [r.root, join(r.root, "work"), join(r.root, "store")]);
    assert.deepEqual([claim.reused, claim.forced, claim.fenced], [false, false, false]);
    assert.ok(claim.timings.mountMs > 0 && claim.timings.verifyMs > 0);
    assert.equal(JSON.parse(readFileSync(join(r.root, CLAIM_PROBE), "utf8")).pid, process.pid);
  } finally {
    delete process.env.ARCHIL_API_KEY;
    delete process.env.ARCHIL_MOUNT_TOKEN;
  }
});

test("through sudo the token is in neither sudo's argv nor its environment; the wrapper gets it on stdin", async () => {
  const r = disposeAfter(rig({ sudo: true }));
  const claim = await acquire(r.opts);
  await claim.barrier();
  const sudo = r.calls("sudo");
  assert.deepEqual(sudo.map((c) => c.argv), [
    ["-n", r.host.archil, "mount", TARGET, r.root, "--region", REF.region],
    ["-n", r.host.archil, "delegations", "--json", r.root],
    ["-n", r.host.archil, "sync", r.root],
  ]);
  for (const c of sudo) {
    assert.deepEqual([c.argvHasToken, c.envHasToken, c.envKeys.includes("ARCHIL_MOUNT_TOKEN")], [false, false, false], c.argv.join(" "));
    assert.ok(!c.argv.some((a) => a.startsWith("--preserve-env")), "sudo preserves nothing, so it logs nothing");
  }
  assert.deepEqual(r.calls("archil").map((c) => [c.argv[0], c.stdin, c.envHasToken]), [["mount", "token", false], ["delegations", undefined, false], ["sync", undefined, false]]);
});

test("a missing token or one with a line break is refused before anything runs", async () => {
  const r = disposeAfter(rig());
  for (const token of ["", "\n", `${TOKEN}\n`, `a\rb`]) {
    await assert.rejects(acquire({ ...r.opts, token }), (e: unknown) => e instanceof ClaimError && e.code === "INVALID_ARGUMENT", JSON.stringify(token.length));
  }
  assert.equal(r.read().calls.length, 0);
});

test("a second exclusive mount is refused as held (exit 76), and nothing is left mounted", async () => {
  const r = disposeAfter(rig());
  r.set((s) => void (s.holders[TARGET] = "remote"));
  const err = await acquire(r.opts).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof HeldError, String(err));
  assert.equal(exitCodeFor(err), 76);
  assert.match(err.message, /outstanding delegation/);
  assert.ok(!err.message.includes(TOKEN));
  assert.equal(r.read().mounts[r.root], undefined);
});

test("other refused mounts are MOUNT_FAILED (exit 1) with the token scrubbed from the message", async () => {
  for (const [mode, expect] of [["auth", /Authentication failed/], ["fail", /something else/], ["echo-token", /<token>/]] as const) {
    const r = disposeAfter(rig({ behave: { mount: mode } }));
    const err = await acquire(r.opts).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof ClaimError && err.code === "MOUNT_FAILED", `${mode}: ${err}`);
    assert.equal(exitCodeFor(err), 1);
    assert.match(err.message, expect);
    assert.ok(!err.message.includes(TOKEN), `${mode} leaks no token`);
  }
});

test("a mount that never returns times out as MOUNT_FAILED", async () => {
  const r = disposeAfter(rig({ behave: { mountHang: true } }));
  r.host.timeoutMs = { ...r.host.timeoutMs, mount: 300 };
  const t0 = performance.now();
  await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNT_FAILED" && /timed out/.test(e.message));
  assert.ok(performance.now() - t0 < 4_000);
});

test("a delegation that does not verify unmounts and fails CLAIM_NOT_VERIFIED", async () => {
  for (const behave of [{ mount: "no-delegation" }, { delegationsPath: "wrong" }, { delegationState: "Pending" }, { delegationsGarbage: true }]) {
    const r = disposeAfter(rig({ behave }));
    await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "CLAIM_NOT_VERIFIED", JSON.stringify(behave));
    assert.equal(r.read().mounts[r.root], undefined, "unmounted after a failed verification");
    assert.equal(r.calls("archil", "unmount").length, 1);
  }
  const flat = disposeAfter(rig({ behave: { delegationsPath: "flat" } }));
  assert.equal((await acquire(flat.opts)).reused, false, "a delegation listed at the mountpoint itself verifies");
});

test("any refused probe write is a fence (exit 75), and the mount is cleaned", async () => {
  for (const code of ["EIO", "EROFS", "ENOENT", "EACCES", "ERR_SQLITE_ERROR"]) {
    const r = disposeAfter(rig({ persist: { persist: async () => Promise.reject(Object.assign(new Error(code), { code })) } }));
    await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof FencedError && e.exitCode === 75 && (e.cause as { code?: string }).code === code, code);
    assert.equal(r.read().mounts[r.root], undefined);
  }
});

test("the claim satisfies the environment's claim shape and names its disk", async () => {
  const r = disposeAfter(rig());
  const claim = await acquire(r.opts);
  const envClaim: ArchilEnvClaim = claim;
  assert.equal(envClaim.disk, REF.disk);
  assert.equal(archilEnv(claim).id, `archil:${REF.disk}:${r.root}`);
});

test("exit codes are not evidence: the mount table decides every mount, unmount and cleanup", async () => {
  {
    const r = disposeAfter(rig({ behave: { mountLies: true } }));
    await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNT_FAILED" && /exited 0/.test(e.message));
  }
  {
    const r = disposeAfter(rig());
    const claim = await acquire(r.opts);
    r.set((s) => void (s.behave.unmountLies = true));
    await assert.rejects(claim.release(), (e: unknown) => e instanceof ClaimError && e.code === "UNMOUNT_FAILED" && /still mounted/.test(e.message));
    assert.equal(r.calls("fusermount").length, 0, "a live mount is never fusermounted");
  }
  {
    const r = disposeAfter(rig({ behave: { unmountErrButGone: true } }));
    const claim = await acquire(r.opts);
    assert.deepEqual(await claim.release(), { via: "archil" }, "gone from the mount table is released, whatever the exit code");
  }
  {
    const r = disposeAfter(rig({ behave: { fusermountLies: true } }));
    const claim = await acquire(r.opts);
    r.set((s) => void (s.mounts[r.root].alive = false));
    r.dead.add(r.root);
    claim.markFenced();
    await assert.rejects(claim.release(), (e: unknown) => e instanceof ClaimError && e.code === "DEAD_MOUNT_CLEANUP_FAILED" && /still mounted/.test(e.message));
    assert.ok(r.read().mounts[r.root], "still listed, so never reported clean");
    await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "DEAD_MOUNT_CLEANUP_FAILED");
    assert.equal(r.calls("archil", "mount").length, 1, "never mounts over a dead mount it could not clean");
  }
});

test("a mountpoint holding something else is MOUNTPOINT_BUSY and archil is never called", async () => {
  const r = disposeAfter(rig());
  r.set((s) => void s.extraMounts.push(`tmpfs ${r.root} tmpfs rw 0 0`));
  await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNTPOINT_BUSY");
  assert.equal(r.read().calls.length, 0);
});

test("an in-place restart keeps its own live mount without a token, and still proves it with a write", async () => {
  const r = disposeAfter(rig());
  liveMount(r);
  const claim = await acquire(r.opts);
  assert.equal(claim.reused, true);
  assert.equal(r.calls("archil", "mount").length, 0);
  assert.ok(r.read().calls.every((c) => c.stdin === undefined && !c.envHasToken), "no token reaches any child");
  assert.ok(existsSync(join(r.root, CLAIM_PROBE)));
});

test("an in-place restart onto a revoked mount is fenced: the client still lists Active, the write is refused", async () => {
  const r = disposeAfter(rig({ persist: { persist: async () => Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })) } }));
  liveMount(r);
  r.set((s) => void (s.mounts[r.root].fenced = true));
  await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof FencedError);
  assert.equal(r.read().mounts[r.root], undefined, "the fenced mount is cleaned");
});

test("a dead mount at the mountpoint is cleaned with fusermount, then the orphaned claim is refused (76)", async () => {
  const r = disposeAfter(rig());
  liveMount(r);
  r.set((s) => void (s.mounts[r.root].alive = false));
  r.dead.add(r.root);
  await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof HeldError);
  assert.equal(r.calls("fusermount").length, 1);
  assert.equal(r.read().mounts[r.root], undefined);
  // The supervisor revokes the orphan; the next start mounts.
  r.dead.delete(r.root);
  r.set((s) => void delete s.holders[TARGET]);
  assert.equal((await acquire(r.opts)).reused, false);
});

test("a dead mount that fusermount cannot clean fails DEAD_MOUNT_CLEANUP_FAILED", async () => {
  const r = disposeAfter(rig({ behave: { fusermountFail: true } }));
  liveMount(r);
  r.set((s) => void (s.mounts[r.root].alive = false));
  r.dead.add(r.root);
  await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "DEAD_MOUNT_CLEANUP_FAILED");
  assert.equal(r.calls("archil", "mount").length, 0);
});

test("a mountpoint that cannot be created is MOUNT_FAILED; under a root-owned root it is created through sudo", { skip: process.getuid?.() === 0 }, async () => {
  for (const sudo of [false, true]) {
    const r = disposeAfter(rig({ sudo }));
    mkdirSync(r.mountRoot, { mode: 0o555 });
    await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNT_FAILED" && /cannot create/.test(e.message));
    assert.deepEqual(r.calls("sudo").map((c) => c.argv), sudo ? [["-n", "mkdir", "-p", r.root]] : []);
    assert.equal(r.calls("archil").length, 0);
    chmodSync(r.mountRoot, 0o755);
  }
});

test("bad input and a missing binary fail before any mount", async () => {
  const r = disposeAfter(rig());
  const isArg = (e: unknown) => e instanceof ClaimError && e.code === "INVALID_ARGUMENT";
  await assert.rejects(acquire({ ...r.opts, mountRoot: "relative/mnt" }), isArg);
  await assert.rejects(acquire({ ...r.opts, token: "" }), isArg);
  await assert.rejects(acquire({ ...r.opts, ref: { ...REF, id: "../etc" } }), isArg);
  await assert.rejects(acquire({ ...r.opts, host: { ...r.host, archil: join(r.dir, "missing-archil") } }), (e: unknown) => e instanceof ClaimError && e.code === "ARCHIL_CLI_FAILED");
});

// ---- takeover ---------------------------------------------------------------------------------------------------------

test("takeOver revokes through the control API, then mounts without --force; the old holder is cut off", async () => {
  const r = disposeAfter(rig());
  const oldMp = join(r.dir, "old", "runs", "r1");
  liveMount(r, oldMp);
  const { control, calls } = fakeControl([del("runs/r1")], {}, () => r.set((s) => void delete s.holders[TARGET]));
  const claim = await takeOver(control, r.opts);
  assert.equal(calls.revoke.length, 1);
  assert.equal(claim.forced, false);
  assert.deepEqual(r.calls("archil", "mount")[0].argv, ["mount", TARGET, r.root, "--region", REF.region]);
  assert.equal(r.read().holders[TARGET], r.root);
});

test("takeOver falls back to mount --force when listing or revoking through the API fails", async () => {
  for (const fail of [{ list: new Error("503") }, { revoke: new Error("503") }]) {
    const r = disposeAfter(rig());
    const oldMp = join(r.dir, "old", "runs", "r1");
    liveMount(r, oldMp);
    const { control } = fakeControl([del("runs/r1")], fail);
    const claim = await takeOver(control, r.opts);
    assert.equal(claim.forced, true);
    assert.deepEqual(r.calls("archil", "mount")[0].argv, ["mount", "--force", TARGET, r.root, "--region", REF.region]);
    assert.equal(r.read().mounts[oldMp].fenced, true, "the forced-out holder is fenced");
  }
});

test("takeOver revokes a holder the control API lists without a path, by its inode, then mounts without --force", async () => {
  const r = disposeAfter(rig());
  const root = disposeAfter(diskRoot(["r1"]));
  const oldMp = join(r.dir, "old", "runs", "r1");
  liveMount(r, oldMp);
  const { control, calls } = fakeControl([pathless("c-old", root.inode("r1"))], {}, () => r.set((s) => void delete s.holders[TARGET]));
  control.exec = root.exec;
  const claim = await takeOver(control, r.opts);
  assert.equal(calls.revoke.length, 1, "the pathless holder was found and revoked");
  assert.equal(claim.forced, false);
  assert.deepEqual(r.calls("archil", "mount")[0].argv, ["mount", TARGET, r.root, "--region", REF.region]);
});

test("takeOver forces when a pathless holder cannot be attributed (no exec)", async () => {
  const r = disposeAfter(rig());
  const oldMp = join(r.dir, "old", "runs", "r1");
  liveMount(r, oldMp);
  const { control, calls } = fakeControl([pathless("c-old", 7)]);
  const claim = await takeOver(control, r.opts);
  assert.equal(calls.revoke.length, 0);
  assert.equal(claim.forced, true);
  assert.deepEqual(r.calls("archil", "mount")[0].argv, ["mount", "--force", TARGET, r.root, "--region", REF.region]);
});

test("takeOver never forces after a successful revoke: a claimant that won the race keeps it (76)", async () => {
  const r = disposeAfter(rig());
  r.set((s) => void (s.holders[TARGET] = "remote"));
  const { control } = fakeControl([]);
  await assert.rejects(takeOver(control, r.opts), (e: unknown) => e instanceof HeldError);
  assert.ok(!r.calls("archil", "mount")[0].argv.includes("--force"));
  await assert.rejects(takeOver(control, { ...r.opts, ref: { ...REF, id: "a/b" } }), (e: unknown) => (e as ClaimError).code === "INVALID_ARGUMENT");
});

// ---- barrier and release ----------------------------------------------------------------------------------------------

test("barrier runs archil sync on the mount", async () => {
  const r = disposeAfter(rig());
  const claim = await acquire(r.opts);
  const { ms } = await claim.barrier();
  assert.ok(ms > 0);
  assert.deepEqual(r.calls("archil", "sync").map((c) => c.argv), [["sync", r.root]]);
});

test("a failed barrier fences the claim, and a fenced claim never touches the mount again", async () => {
  const r = disposeAfter(rig());
  const claim = await acquire(r.opts);
  r.set((s) => void (s.mounts[r.root].fenced = true));
  await assert.rejects(claim.barrier(), (e: unknown) => e instanceof FencedError && /failed or read-only/.test(e.message));
  assert.equal(claim.fenced, true);
  await assert.rejects(claim.barrier(), (e: unknown) => e instanceof FencedError);
  assert.equal(r.calls("archil", "sync").length, 1, "nothing is retried on a fenced handle");
});

test("markFenced stops barriers before they reach the mount", async () => {
  const r = disposeAfter(rig());
  const claim = await acquire(r.opts);
  const cause = Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 1034 });
  claim.markFenced(cause);
  await assert.rejects(claim.barrier(), (e: unknown) => e instanceof FencedError && e.cause === cause);
  assert.equal(r.calls("archil", "sync").length, 0);
});

test("a barrier that hangs times out as a fence", async () => {
  const r = disposeAfter(rig());
  r.host.timeoutMs = { ...r.host.timeoutMs, sync: 300 };
  const claim = await acquire(r.opts);
  r.set((s) => void (s.behave.syncHang = true));
  const t0 = performance.now();
  await assert.rejects(claim.barrier(), (e: unknown) => e instanceof FencedError && /timed out/.test(e.message));
  assert.ok(performance.now() - t0 < 4_000);
  assert.equal(claim.fenced, true);
});

test("release flushes, checks in with archil unmount, frees the claim and removes the mountpoint; twice is a no-op", async () => {
  const r = disposeAfter(rig());
  const claim = await acquire(r.opts);
  assert.deepEqual(await claim.release(), { via: "archil" });
  assert.deepEqual(r.calls("archil").map((c) => c.argv[0]), ["mount", "delegations", "sync", "unmount"]);
  assert.equal(r.read().mounts[r.root], undefined);
  assert.equal(r.read().holders[TARGET], undefined, "the delegation is checked in");
  assert.equal(readFileSync(r.host.procMounts!, "utf8").includes(r.root), false);
  assert.equal(existsSync(r.root), false);
  assert.deepEqual(await claim.release(), { via: "none" });
  await assert.rejects(claim.barrier(), (e: unknown) => e instanceof ClaimError && e.code === "CLAIM_RELEASED");
  // The freed claim can be taken again.
  assert.equal((await acquire(r.opts)).reused, false);
});

test("release on a fenced mount still unmounts, then reports the fence", async () => {
  const r = disposeAfter(rig());
  const claim = await acquire(r.opts);
  r.set((s) => void (s.mounts[r.root].fenced = true));
  await assert.rejects(claim.release(), (e: unknown) => e instanceof FencedError);
  assert.equal(r.read().mounts[r.root], undefined);
  const r2 = disposeAfter(rig());
  const c2 = await acquire(r2.opts);
  c2.markFenced();
  assert.deepEqual(await c2.release(), { via: "archil" });
  assert.equal(r2.calls("archil", "sync").length, 0, "a known fence skips the barrier");
});

test("release cleans a dead mount with fusermount after archil unmount refuses it", async () => {
  const r = disposeAfter(rig());
  const claim = await acquire(r.opts);
  r.set((s) => void (s.mounts[r.root].alive = false));
  r.dead.add(r.root);
  claim.markFenced(Object.assign(new Error("ENOTCONN"), { code: "ENOTCONN" }));
  assert.deepEqual(await claim.release(), { via: "fusermount" });
  assert.equal(r.calls("archil", "unmount").length, 1);
  assert.equal(r.calls("fusermount").length, 1);
  assert.equal(r.read().mounts[r.root], undefined);
  const r2 = disposeAfter(rig());
  const c2 = await acquire(r2.opts);
  r2.set((s) => void (s.mounts[r2.root].alive = false));
  r2.dead.add(r2.root);
  await assert.rejects(c2.release(), (e: unknown) => e instanceof FencedError, "an undetected dead mount fails the barrier");
  assert.equal(r2.read().mounts[r2.root], undefined, "and is cleaned anyway");
});

test("a live mount that refuses to unmount is UNMOUNT_FAILED and never fusermounted", async () => {
  const r = disposeAfter(rig());
  const claim = await acquire(r.opts);
  r.set((s) => void (s.behave.unmountFail = true));
  await assert.rejects(claim.release(), (e: unknown) => e instanceof ClaimError && e.code === "UNMOUNT_FAILED");
  assert.equal(r.calls("fusermount").length, 0);
  assert.ok(r.read().mounts[r.root]);
  assert.equal(await unmountClaim(join(r.dir, "nothing-here"), r.host), "none");
});

// ---- a host that refuses every unmount of a FUSE mount (Sysbox: umount2 fails with ENOENT) -----------------------------

const releasedUnder = (r: Rig) => Object.keys(r.read().mounts).filter((mp) => mp.startsWith(join(r.mountRoot, ".released") + "/"));

test("Sysbox: release checks in, finds no delegation left, moves the mount aside and kills its daemon; the same path mounts again", async () => {
  const r = disposeAfter(rig({ behave: { sysbox: true } }));
  const claim = await acquire(r.opts);
  assert.deepEqual(await claim.release(), { via: "moved" });
  assert.deepEqual(r.calls("archil").map((c) => c.argv[0]), ["mount", "delegations", "sync", "unmount", "checkin", "delegations", "retire"]);
  const retire = r.calls("archil", "retire")[0].argv;
  assert.equal(retire[1], r.root);
  assert.match(retire[2], /^[0-9a-z]+$/);
  assert.equal(r.calls("fusermount").length, 0, "a live mount is never fusermounted");
  assert.equal(r.read().holders[TARGET], undefined, "the delegation went back to the server");
  assert.equal(r.read().mounts[r.root], undefined, "the path is free");
  assert.deepEqual(releasedUnder(r), [join(r.mountRoot, ".released", `${REF.id}-${retire[2]}`)]);
  assert.equal(existsSync(r.root), false);
  const again = await acquire(r.opts);
  assert.equal(again.reused, false);
  assert.equal(r.read().holders[TARGET], r.root);
});

test("Sysbox: any other unmount refusal stays UNMOUNT_FAILED, with no checkin and nothing moved", async () => {
  const r = disposeAfter(rig({ behave: { unmountFail: true } }));
  const claim = await acquire(r.opts);
  await assert.rejects(claim.release(), (e: unknown) => e instanceof ClaimError && e.code === "UNMOUNT_FAILED" && /target is busy/.test(e.message));
  assert.equal(r.calls("archil", "checkin").length + r.calls("archil", "retire").length, 0);
  assert.ok(r.read().mounts[r.root]);
});

test("Sysbox: a failed checkin, or a delegation still listed after it, leaves the mount in place with UNMOUNT_FAILED", async () => {
  const r = disposeAfter(rig({ behave: { sysbox: true, checkinFail: true } }));
  const claim = await acquire(r.opts);
  await assert.rejects(claim.release(), (e: unknown) => e instanceof ClaimError && e.code === "UNMOUNT_FAILED" && /archil checkin failed/.test(e.message));
  assert.equal(r.calls("archil", "retire").length, 0);
  assert.ok(r.read().mounts[r.root]);
  assert.equal(r.read().holders[TARGET], r.root);

  const k = disposeAfter(rig({ behave: { sysbox: true, checkinKeeps: true } }));
  const c2 = await acquire(k.opts);
  await assert.rejects(c2.release(), (e: unknown) => e instanceof ClaimError && e.code === "UNMOUNT_FAILED" && /still lists a delegation/.test(e.message));
  assert.equal(k.calls("archil", "retire").length, 0);
  assert.ok(k.read().mounts[k.root]);
});

test("Sysbox: a move that leaves the path mounted, or a daemon that survives, is UNMOUNT_FAILED", async () => {
  const r = disposeAfter(rig({ behave: { sysbox: true, retireFail: true } }));
  const claim = await acquire(r.opts);
  await assert.rejects(claim.release(), (e: unknown) => e instanceof ClaimError && e.code === "UNMOUNT_FAILED" && /still mounted after moving it aside/.test(e.message));
  assert.ok(r.read().mounts[r.root]);
  const d = disposeAfter(rig({ behave: { sysbox: true, retireKeepsDaemon: true } }));
  const c2 = await acquire(d.opts);
  await assert.rejects(c2.release(), (e: unknown) => e instanceof ClaimError && e.code === "UNMOUNT_FAILED" && /daemon was not stopped/.test(e.message));
});

test("Sysbox: a dead mount is moved aside without a checkin, at release and when acquire finds one at the path", async () => {
  const r = disposeAfter(rig({ behave: { sysbox: true } }));
  const claim = await acquire(r.opts);
  r.set((s) => void (s.mounts[r.root].alive = false));
  r.dead.add(r.root);
  claim.markFenced(Object.assign(new Error("ENOTCONN"), { code: "ENOTCONN" }));
  assert.deepEqual(await claim.release(), { via: "moved" });
  assert.equal(r.calls("archil", "checkin").length, 0, "a dead client has nothing to check in");
  assert.equal(r.calls("fusermount").length, 1);
  assert.equal(r.read().mounts[r.root], undefined);

  const a = disposeAfter(rig({ behave: { sysbox: true } }));
  liveMount(a);
  a.set((s) => void (s.mounts[a.root].alive = false));
  a.dead.add(a.root);
  await assert.rejects(acquire(a.opts), (e: unknown) => e instanceof HeldError, "the dead client's delegation is orphaned on the server until revoked (76)");
  assert.equal(a.calls("archil", "retire").length, 1);
  assert.equal(a.read().mounts[a.root], undefined, "the path was freed before the mount was tried");
  assert.equal(a.calls("archil", "mount").length, 1);
});

// ---- a run's mountpoint with entries and no mount (written by path after the run's mount vanished) --------------------

/** process.stderr lines written while `fn` runs. */
async function stderrOf<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { value: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    process.stderr.write = write;
  }
}

function seedMountpoint(r: Rig) {
  mkdirSync(join(r.root, "jobs"), { recursive: true });
  writeFileSync(join(r.root, "run.json"), "secret-content-1\n");
  writeFileSync(join(r.root, "jobs", "a.json"), "secret-content-2\n");
}

test("acquire moves the entries of an unmounted mountpoint aside whole, logs the run and the count, then mounts", async () => {
  const r = disposeAfter(rig());
  seedMountpoint(r);
  const out = await stderrOf(() => acquire(r.opts));
  const claim = out.value!;
  assert.ok(claim, String(out.error));
  assert.deepEqual(r.calls("archil").map((c) => c.argv[0]), ["stray", "mount", "delegations"], "moved aside before the mount");
  const tag = r.calls("archil", "stray")[0].argv[2];
  const to = join(r.mountRoot, ".stray", `${REF.id}-${tag}`);
  assert.deepEqual(claim.stray, { to, entries: 2 });
  assert.deepEqual(readdirSync(to, { recursive: true }).map(String).sort(), ["jobs", "jobs/a.json", "run.json"], "the leftovers sit in .stray, whole");
  assert.deepEqual(readdirSync(r.root).filter((n) => n !== CLAIM_PROBE), [], "nothing of them is in the run");
  assert.ok(r.read().mounts[r.root]);
  const logged = out.lines.filter((l) => l.includes("stray"));
  assert.equal(logged.length, 1);
  assert.deepEqual({ ...JSON.parse(logged[0]), at: undefined }, { at: undefined, event: "stray entries moved aside", run: REF.id, entries: 2, to });
  assert.ok(!out.lines.join("").includes("secret") && !out.lines.join("").includes("a.json"), "no name or content of the leftovers is logged");
});

test("an empty mountpoint is left alone: no stray, no log line", async () => {
  const r = disposeAfter(rig());
  mkdirSync(r.root, { recursive: true });
  const out = await stderrOf(() => acquire(r.opts));
  assert.equal(out.value!.stray, null);
  assert.equal(r.calls("archil", "stray").length, 0);
  assert.equal(out.lines.length, 0);
});

test("leftovers the wrapper refuses to move (a symlinked .stray, an existing destination) are MOUNTPOINT_NOT_EMPTY; nothing mounts", async () => {
  const r = disposeAfter(rig({ behave: { strayFail: true } }));
  seedMountpoint(r);
  await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNTPOINT_NOT_EMPTY" && /could not be moved aside/.test(e.message));
  assert.equal(r.calls("archil", "mount").length, 0);
  assert.deepEqual(readdirSync(r.root).sort(), ["jobs", "run.json"], "the leftovers stay where they were");
});

test("archil refusing a refilled mountpoint is MOUNTPOINT_NOT_EMPTY; its misleading error on an empty one stays MOUNT_FAILED", async () => {
  const r = disposeAfter(rig({ behave: { mountReseed: true } }));
  seedMountpoint(r);
  await assert.rejects(acquire(r.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNTPOINT_NOT_EMPTY" && /Unspecified Error/.test(e.message));
  const p = disposeAfter(rig({ behave: { mount: "not-empty" } }));
  await assert.rejects(acquire(p.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNTPOINT_NOT_EMPTY", "archil's plain words");
  const l = disposeAfter(rig({ behave: { mount: "lockout" } }));
  await assert.rejects(acquire(l.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNT_FAILED" && /os error 115/.test(e.message), "an empty mountpoint: Archil's lockout, not leftovers");
});

const daemonArgv = (mp: string, target = TARGET) => ["/usr/bin/archil", "mount", target, mp, "--region", REF.region];

test("acquire kills a stale archil daemon (no mount at the run's path) through the wrapper's stale, logs the run and pids, then mounts", async () => {
  const r = disposeAfter(rig());
  mkdirSync(r.root, { recursive: true });
  r.set((s) => void (s.daemons["5151"] = daemonArgv(r.root)));
  const out = await stderrOf(() => acquire(r.opts));
  assert.ok(out.value, String(out.error));
  assert.deepEqual(r.calls("archil").map((c) => c.argv[0]), ["stale", "mount", "delegations"], "killed before the mount");
  assert.deepEqual(r.calls("archil", "stale")[0].argv, ["stale", r.root]);
  const daemons = r.read().daemons;
  assert.equal(daemons["5151"], undefined);
  assert.deepEqual(Object.values(daemons), [daemonArgv(r.root)], "the new mount's own daemon");
  const logged = out.lines.filter((l) => l.includes("stale"));
  assert.equal(logged.length, 1);
  assert.deepEqual({ ...JSON.parse(logged[0]), at: undefined }, { at: undefined, event: "stale archil daemon killed", run: REF.id, pids: [5151] });
});

test("a live mount's daemon is never touched: a listed mount's, another mountpoint's, processes that only name the path", async () => {
  const r = disposeAfter(rig());
  const other = join(r.mountRoot, "runs", "r2");
  r.set((s) => {
    s.daemons["6001"] = daemonArgv(other, `${REF.disk}:/runs/r2`);
    s.daemons["6002"] = ["/bin/bash", "-c", r.root];
    s.daemons["6003"] = ["/usr/bin/archil", "sync", r.root];
  });
  const claim = await acquire(r.opts);
  const own = Object.keys(r.read().daemons).find((pid) => !["6001", "6002", "6003"].includes(pid))!;
  // The same run again: its mount is listed, so it is kept (in place) and its daemon is not stale.
  const again = await acquire(r.opts);
  assert.equal(again.reused, true);
  // A second client of the same run on another mountpoint is refused as held; the first mount's daemon is not its business.
  const elsewhere = join(r.dir, "mnt-b");
  const held = await acquire({ ...r.opts, mountRoot: elsewhere }).then(() => null, (e: unknown) => e);
  assert.ok(held instanceof HeldError, String(held));
  assert.equal(r.calls("archil", "stale").length, 0);
  assert.deepEqual(Object.keys(r.read().daemons).sort(), ["6001", "6002", "6003", own].sort());
  assert.deepEqual(r.read().daemons[own], daemonArgv(r.root));
  assert.ok(r.read().mounts[claim.root]?.alive);
});

test("a daemon that exits within the grace is left to exit; one the wrapper cannot clear is MOUNT_FAILED (exit 1) and nothing mounts", async () => {
  const g = disposeAfter(rig());
  g.host.timeoutMs = { ...g.host.timeoutMs, staleGrace: 3_000 };
  mkdirSync(g.root, { recursive: true });
  g.set((s) => void (s.daemons["5151"] = daemonArgv(g.root)));
  const exits = setTimeout(() => g.set((s) => void delete s.daemons["5151"]), 300);
  const t0 = performance.now();
  await acquire(g.opts).finally(() => clearTimeout(exits));
  const waited = performance.now() - t0;
  assert.ok(waited >= 250 && waited < 3_000, `waited ${Math.round(waited)} ms`);
  assert.equal(g.calls("archil", "stale").length, 0, "nothing killed");

  const s = disposeAfter(rig({ behave: { staleSurvives: true } }));
  mkdirSync(s.root, { recursive: true });
  s.set((x) => void (x.daemons["5151"] = daemonArgv(s.root)));
  const err = await acquire(s.opts).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ClaimError && err.code === "MOUNT_FAILED" && /pid 5151\).*not cleared.*still alive/.test(err.message), String(err));
  assert.equal(exitCodeFor(err), 1);
  assert.equal(s.calls("archil", "mount").length, 0);

  // An archil of another path naming the mountpoint is not the wrapper's to kill; the mount would be refused all the same.
  const o = disposeAfter(rig());
  mkdirSync(o.root, { recursive: true });
  o.set((x) => void (x.daemons["5252"] = ["/opt/other/archil", "mount", TARGET, o.root]));
  await assert.rejects(acquire(o.opts), (e: unknown) => e instanceof ClaimError && e.code === "MOUNT_FAILED" && /5252 survived/.test(e.message));
  assert.ok(o.read().daemons["5252"]);
  assert.equal(o.calls("archil", "mount").length, 0);
});

test("archil's 'older Archil process' and 'Failed to bind control socket' refusals are MOUNT_FAILED (exit 1), never held", async () => {
  for (const [mode, force] of [["older", false], ["older", true], ["socket", false]] as const) {
    const r = disposeAfter(rig({ behave: { mount: mode } }));
    const err = await acquire({ ...r.opts, force }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof ClaimError && err.code === "MOUNT_FAILED", `${mode} force ${force}: ${err}`);
    assert.ok(!(err instanceof HeldError));
    assert.equal(exitCodeFor(err), 1);
    assert.match(err.message, /still runs for/);
    assert.ok(!err.message.includes(TOKEN));
  }
  const h = disposeAfter(rig());
  h.set((s) => void (s.holders[TARGET] = "remote"));
  await assert.rejects(acquire(h.opts), (e: unknown) => e instanceof HeldError && exitCodeFor(e) === EXIT_HELD, "another client's delegation stays 76");
});
