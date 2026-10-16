// Places: localPlace runs the real CLI on a directory (a kill, then a resume with the next order), and archilPlace runs
// over a fake control API and a fake host driver (a mount token minted per attempt, the kill, the takeover, release).
// No Archil, no network.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delegation } from "disk";
import { archilPlace, localPlace, PlaceError } from "../src/place.ts";
import { parseTokenNickname } from "../src/claim.ts";
import type { HostDriver, HostHandle, HostStatus, StartAttempt, SupervisorControl } from "../src/supervise.ts";
import { currentBootId, procStartTicks } from "../src/hosts/local-host.ts";
import { scratchRoot } from "./_run-support.ts";

const APP = fileURLToPath(new URL("./fixtures/place-app.ts", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => T | undefined | null | false, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pathsAt = (root: string) => ({ id: "place-run", root, work: join(root, "work"), store: join(root, "store") });
const scratches: { remove(): void }[] = [];
const scratch = () => {
  const s = scratchRoot("place");
  scratches.push(s);
  return join(s.root, "run");
};
after(() => scratches.forEach((s) => s.remove()));

describe("localPlace", () => {
  it("a process kill SIGKILLs the instance's group; the next runner resumes the run with its own order, and with no outcome line the outcome is run.json's", { timeout: 120_000 }, async () => {
    const root = scratch();
    const place = localPlace({ app: APP })({ paths: pathsAt(root) });
    assert.equal(place.name, "local");
    assert.deepEqual(place.kills, ["process"], "no box to lose without destroyBoxes");
    assert.equal(place.token, undefined, "a plain directory has no claim, so no token");
    assert.equal(place.signals, undefined, "no request file named, no signals");
    assert.equal(place.requestFile, undefined);

    const first = await place.start({ gen: 1, env: { PLACE_ORDER: "one" } });
    const sleeper = Number(await waitFor("the first runner's sleeper", () => existsSync(join(root, "work", "sleeper.pid")) && readFileSync(join(root, "work", "sleeper.pid"), "utf8")));
    assert.ok(alive(sleeper));
    assert.equal(readFileSync(join(root, "work", "gen-1"), "utf8"), "one", "the order's environment reached the instance");

    await place.kill(first, "process");
    const killed = await first.exited;
    assert.deepEqual([killed.exit, killed.signal], ["SIGKILL", "SIGKILL"]);
    assert.deepEqual([killed.outcome?.status, killed.outcome?.generation], ["failed", 1], "no line: run.json as the killed instance left it (running), in the run's word: not delivered");
    await waitFor("the sleeper to die with its group", () => !alive(sleeper), 5_000);

    const { runner } = await place.recover(first, "process", { gen: 2, env: { PLACE_ORDER: "two", PLACE_SILENT: "1" } });
    const done = await runner.exited;
    assert.equal(done.exit, 0, done.stderr);
    assert.deepEqual(done.outcome, { status: "complete", generation: 2, code: null, record: { order: "two" } }, "done with the record from the detail of the last status: complete");
    assert.equal(readFileSync(join(root, "work", "gen-2"), "utf8"), "two");
    assert.deepEqual([(await place.status!()).record?.status, (await place.status!()).record?.generation], ["done", 2]);
  });

  it("the outcome line wins; a box kill takes the run's boxes once though the supervisor kills and recovers the same runner; release kills what still runs", { timeout: 120_000 }, async () => {
    const root = scratch();
    let destroyed = 0;
    const place = localPlace({ app: APP })({ paths: pathsAt(root), destroyBoxes: () => void destroyed++ });
    assert.deepEqual(place.kills, ["process", "box"]);

    const first = await place.start({ gen: 1, env: {} });
    await waitFor("the first runner", () => existsSync(join(root, "work", "sleeper.pid")));
    await place.kill(first, "box");
    const { runner } = await place.recover(first, "box", { gen: 2, env: { PLACE_ORDER: "two" } });
    assert.equal(destroyed, 1, "the boxes went once");
    assert.deepEqual((await runner.exited).outcome, { status: "complete", generation: 2, record: { order: "two" } }, "the instance's own line");

    const root2 = scratch();
    const other = localPlace({ app: APP, root: root2 })({ paths: pathsAt("/nonexistent/ignored") });
    assert.equal(other.paths.root, root2, "root replaces the context's");
    const held = await other.start({ gen: 1, env: {} });
    await waitFor("the runner", () => existsSync(join(root2, "work", "sleeper.pid")));
    // A command the run recorded, in a process group of its own as pi starts them: the instance's kill does not reach it.
    const command = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    const mark = { pid: command.pid!, start: procStartTicks(command.pid!)! };
    after(() => void (alive(mark.pid) && procStartTicks(mark.pid) === mark.start && process.kill(mark.pid, "SIGKILL")));
    mkdirSync(join(root2, "commands"), { recursive: true });
    writeFileSync(join(root2, "commands", `${mark.pid}-${mark.start}.json`), JSON.stringify({ boot: currentBootId(), leader: mark, members: [] }));
    const commandGone = new Promise((r) => command.once("exit", r));
    await other.release();
    assert.equal((await held.exited).signal, "SIGKILL");
    await Promise.race([commandGone, sleep(5_000)]);
    assert.ok(!alive(mark.pid), "release ended the run's recorded command");
    assert.ok(!existsSync(join(root2, "commands")), "and cleared its records");
  });
});

describe("localPlace outcome", () => {
  it("run.json's outcome is in the run's word: complete when done with a delivered record, failed for done with none or a failed run", { timeout: 120_000 }, async () => {
    const cases = [
      [{}, "complete"],
      [{ PLACE_NO_RECORD: "1" }, "failed"],
      [{ PLACE_FAIL: "1" }, "failed"],
    ] as const;
    for (const [env, status] of cases) {
      const place = localPlace({ app: APP })({ paths: pathsAt(scratch()) });
      const runner = await place.start({ gen: 1, env: { PLACE_FINISH: "1", PLACE_SILENT: "1", ...env } });
      const ended = await runner.exited;
      assert.equal(ended.exit, 0, ended.stderr);
      assert.equal(ended.outcome?.status, status, JSON.stringify({ env, outcome: ended.outcome }));
    }
  });
});

describe("localPlace cleanup", () => {
  it("a box deletion that fails is tried again by the next kill or recover, and one that succeeded is not repeated", { timeout: 120_000 }, async () => {
    const root = scratch();
    let calls = 0;
    const place = localPlace({ app: APP })({
      paths: pathsAt(root),
      destroyBoxes: () => {
        if (++calls === 1) throw new Error("provider down");
      },
    });
    const first = await place.start({ gen: 1, env: { PLACE_FINISH: "1" } });
    await assert.rejects(place.kill(first, "box"), /provider down/);
    const { runner } = await place.recover(first, "box", { gen: 2, env: { PLACE_FINISH: "1" } });
    assert.equal(calls, 2, "the recover took the boxes the failed kill left");
    await runner.exited;
    await place.kill(first, "box");
    assert.equal(calls, 2, "taken once");
  });

  it("release reaps the run's commands only under its owner lock: while another process holds the run they are its own", { timeout: 120_000 }, async () => {
    const root = scratch();
    mkdirSync(join(root, "commands"), { recursive: true });
    const holder = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/hold-owner-lock.ts", import.meta.url)), root], { stdio: ["ignore", "pipe", "inherit"] });
    after(() => void (holder.exitCode === null && holder.kill("SIGKILL")));
    await new Promise<void>((ok, fail) => {
      holder.stdout!.setEncoding("utf8").on("data", (d: string) => (d.includes("held") ? ok() : d.includes("refused") && fail(new Error(d))));
    });
    const command = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    const mark = { pid: command.pid!, start: procStartTicks(command.pid!)! };
    after(() => void (alive(mark.pid) && procStartTicks(mark.pid) === mark.start && process.kill(mark.pid, "SIGKILL")));
    writeFileSync(join(root, "commands", `${mark.pid}-${mark.start}.json`), JSON.stringify({ boot: currentBootId(), leader: mark, members: [] }));

    const place = localPlace({ app: APP })({ paths: pathsAt(root) });
    await place.release();
    assert.ok(alive(mark.pid), "the holder's command was left alone");

    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    const gone = new Promise((r) => command.once("exit", r));
    await place.release();
    await Promise.race([gone, sleep(5_000)]);
    assert.ok(!alive(mark.pid), "with the run free, release reaped it");
  });
});

describe("localPlace signals", () => {
  it("the attempt's kill request, once written whole, is one kill-request signal; return() ends a pending next() at once", async () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    const requestFile = (attempt: number) => join(dir, `kill-${attempt}.json`);
    const place = localPlace({ app: APP })({ paths: pathsAt(dir), requestFile });
    assert.equal(place.requestFile!(4), requestFile(4), "the request file is the supervisor's own, where signals reads");
    const it1 = place.signals!(1)[Symbol.asyncIterator]();
    const first = it1.next();
    writeFileSync(requestFile(1), '{"point":"paid-call.ackno');
    await sleep(100);
    let settled = false;
    void first.then(() => (settled = true));
    await sleep(0);
    assert.equal(settled, false, "half a request is not one");
    writeFileSync(`${requestFile(1)}.tmp`, JSON.stringify({ point: "paid-call.acknowledged", n: 2, pid: 7, nonce: "ab12" }));
    renameSync(`${requestFile(1)}.tmp`, requestFile(1));
    assert.deepEqual(await first, { done: false, value: { kind: "kill-request", crossing: { point: "paid-call.acknowledged", n: 2, pid: 7 }, nonce: "ab12" } }, "the nonce at the signal's top");
    assert.deepEqual(await it1.next(), { done: true, value: undefined }, "one request per attempt");

    const it2 = place.signals!(2)[Symbol.asyncIterator]();
    const pending = it2.next();
    await sleep(50);
    await it2.return!();
    // Settled before any timer or immediate can run: the return woke it, not its next poll.
    const first2 = await Promise.race([pending, new Promise((r) => setImmediate(() => r("late")))]);
    assert.deepEqual(first2, { done: true, value: undefined }, "the pending next() ended with the return");
  });
});

// ---- archilPlace over fakes ----------------------------------------------------------------------------------------------

const REF = { disk: "dsk-0000000000000001", region: "aws-us-east-1" };
const ID = "place-run";

class FakeControl implements SupervisorControl {
  objects = new Map<string, string>();
  delegations: Delegation[] = [];
  users = new Map<string, { nickname: string; token: string }>();
  ops: string[] = [];
  /** getObject of a key under this prefix never answers. */
  hangUnder: string | null = null;
  /** getObject calls so far, and an error every getObject of a key under `failUnder` throws instead of answering. */
  gets = 0;
  failUnder: { prefix: string; error: Error } | null = null;
  /** The inode each run directory has, as the disk's `find -inum` reports it; and how many execs ran, and how many next fail. */
  inodes = new Map<string, number>();
  execs = 0;
  execFails = 0;
  /** The next this many removeUser calls fail. */
  removeFails = 0;
  #n = 0;
  runJson(o: Record<string, unknown>) {
    this.objects.set(`runs/${ID}/run.json`, JSON.stringify({ run: ID, status: "running", generation: 1, sealedSeq: null, wakeAt: null, holder: null, heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString(), detail: null, ...o }));
  }
  async getObject(key: string) {
    this.gets++;
    if (this.hangUnder !== null && key.startsWith(this.hangUnder)) return new Promise<Uint8Array>(() => {});
    if (this.failUnder !== null && key.startsWith(this.failUnder.prefix)) throw this.failUnder.error;
    const v = this.objects.get(key);
    if (v === undefined) throw Object.assign(new Error("NoSuchKey"), { status: 404, code: "NoSuchKey" });
    return new TextEncoder().encode(v);
  }
  async headObject(key: string) {
    return this.objects.has(key) ? {} : null;
  }
  /** Every put, with the owner and mode it asked for; and a listing that fails, when set. */
  puts: { key: string; uid: number; gid: number; mode: number }[] = [];
  lists = 0;
  failList: Error | null = null;
  /** A put of a key under record/ or signals/ that the server refuses (a run a delegation holds), when set. */
  putRefused: Error | null = null;
  async putObject(key: string, body: string, options: { uid: number; gid: number; mode: number } = { uid: -1, gid: -1, mode: -1 }) {
    if (key.includes("/record/") || key.includes("/signals/")) {
      if (this.putRefused) throw this.putRefused;
      this.ops.push(`put ${key.slice(`runs/${ID}/`.length)}`);
      this.puts.push({ key, ...options });
    }
    this.objects.set(key, body);
  }
  async listObjects(prefix: string, _options?: { recursive?: boolean }) {
    this.lists++;
    if (this.failList) throw this.failList;
    return { objects: [...this.objects].filter(([key]) => key.startsWith(prefix) && !key.endsWith("/")).map(([key, v]) => ({ key, size: Buffer.byteLength(v) })) };
  }
  async addUser(user: { type: "token"; nickname: string }) {
    this.ops.push(`addUser ${user.nickname.replace(/-[0-9a-z]+$/, "")}`);
    const identifier = `id-${++this.#n}`;
    const token = `tok-${this.#n}-${"9".repeat(20)}`;
    this.users.set(identifier, { nickname: user.nickname, token });
    return { identifier, token };
  }
  async removeUser(_type: "token", identifier: string) {
    this.ops.push(`removeUser ${identifier}`);
    if (this.removeFails > 0) {
      this.removeFails--;
      throw Object.assign(new Error("503"), { status: 503 });
    }
    // Archil answers the removal of a user that is gone with success.
    this.users.delete(identifier);
  }
  async listDelegations() {
    return this.delegations.map((d) => ({ ...d }));
  }
  async revokeDelegation(d: Pick<Delegation, "clientId" | "inodeId">) {
    this.ops.push(`revoke ${d.clientId}`);
    this.delegations = this.delegations.filter((x) => x.clientId !== d.clientId);
  }
  async exec(command: string) {
    this.execs++;
    if (this.execFails > 0 && this.execFails--) throw new Error("exec unreachable");
    const asked = new Set([...command.matchAll(/-inum (\d+)/g)].map((m) => Number(m[1])));
    return { exitCode: 0, stdout: [...this.inodes].filter(([, inode]) => asked.has(inode)).map(([run, inode]) => `${inode} ${run}\n`).join("") };
  }
}

/** A driver whose instances run until stopped or killed; a started one writes run.json at its attempt and holds a delegation. */
function fakeHost(control: FakeControl, kills: "process" | "box" | null = "box") {
  const states = new Map<string, HostStatus>();
  const starts: { token: string; attempt?: StartAttempt }[] = [];
  const faults = { start: 0, stop: 0, status: 0 };
  const host: HostDriver & { mountRoot: string } = {
    mountRoot: "/mnt/fake",
    async start(_ref, token, attempt) {
      control.ops.push(`start g${attempt?.attempt}`);
      if (faults.start > 0 && faults.start--) throw new Error("no capacity");
      starts.push({ token, attempt });
      const name = `box-${starts.length}`;
      states.set(name, "running");
      control.delegations = [{ clientId: `c-${name}`, inodeId: 7, path: `runs/${ID}`, isPending: false, isOrphaned: false }];
      control.runJson({ generation: attempt!.attempt, holder: { driver: "fake", host: name, bootId: null, pid: 1, since: new Date().toISOString() } });
      return { driver: "fake", name };
    },
    async status(h: HostHandle) {
      if (faults.status > 0 && faults.status--) throw new Error("status unreachable");
      return states.get(String(h.name)) ?? "unknown";
    },
    async stop(h: HostHandle) {
      control.ops.push(`stop ${h.name}`);
      if (faults.stop > 0 && faults.stop--) throw new Error("cannot reach the box");
      if (states.has(String(h.name))) states.set(String(h.name), "stopped");
    },
    ...(kills
      ? {
          kills,
          async kill(h: HostHandle) {
            control.ops.push(`kill ${h.name}`);
            states.set(String(h.name), "gone");
          },
        }
      : {}),
  };
  return { host, states, starts, faults };
}

/** Every archil place a test makes, released after the file: a runner left running is polled until it ends. */
const made: { release(): Promise<void> }[] = [];
after(() => Promise.all(made.map((p) => p.release().catch(() => {}))));
const makePlace = (o: Parameters<typeof archilPlace>[0]) => {
  const p = archilPlace({ pollMs: 5, ...o })({ paths: pathsAt("/x") });
  made.push(p);
  return p;
};

describe("archilPlace recordHome", () => {
  const rec = (n: number, rest: string) => `runs/${ID}/record/${n}/${rest}`;
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
  const blobOf = (text: string, ext = "png") => ({ text, hash: createHash("sha256").update(text).digest("hex"), name: `${createHash("sha256").update(text).digest("hex")}.${ext}` });
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

  it("dir is the attempt's directory in the run; localPlace has none, nor a place whose control cannot list", () => {
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    assert.equal(at.recordHome!.dir(2), `/mnt/fake/runs/${ID}/record/2`);
    assert.throws(() => at.recordHome!.dir(0), (e: unknown) => e instanceof PlaceError && e.code === "INVALID_ARGUMENT");
    assert.equal(localPlace({ app: APP })({ paths: pathsAt("/x") }).recordHome, undefined);
    const bare = new FakeControl();
    (bare as unknown as { listObjects?: unknown }).listObjects = undefined;
    assert.equal(makePlace({ ...REF, control: bare, host: fakeHost(bare).host }).recordHome, undefined);
  });

  it("brings home the whole lines and holds a partial one; a second call, or one from another place on the same disk, carries nothing twice", async () => {
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    const into = scratch();
    const spool = rec(1, ".spool/child-9-1.jsonl");
    const dest = join(into, ".spool", "child-9-1.jsonl");
    control.objects.set(spool, `${line({ seq: 0 })}${line({ seq: 1 })}{"seq":`);
    control.objects.set(rec(1, ".spool/started"), "2026-10-16T07:00:00.000Z");
    await at.recordHome!.bringHome(into);
    assert.equal(read(dest), `${line({ seq: 0 })}${line({ seq: 1 })}`, "up to the last whole line");
    assert.equal(read(join(into, ".spool", "started")), null, "started is the supervisor's, never carried back");
    const gets = control.gets;
    await at.recordHome!.bringHome(into);
    assert.equal(read(dest), `${line({ seq: 0 })}${line({ seq: 1 })}`);
    assert.equal(control.gets, gets, "a file that did not grow is not fetched");
    control.objects.set(spool, `${line({ seq: 0 })}${line({ seq: 1 })}${line({ seq: 2 })}${line({ seq: 3 })}`);
    await at.recordHome!.bringHome(into, { final: true });
    await makePlace({ ...REF, control, host: fakeHost(control).host }).recordHome!.bringHome(into, { final: true });
    assert.equal(read(dest), [0, 1, 2, 3].map((seq) => line({ seq })).join(""), "each line once");
  });

  it("segments: each .spool/*.jsonl comes home with its own offset, a rotated one too", async () => {
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    const into = scratch();
    const seg = (n: number) => rec(2, `.spool/child-9-1.${n}.jsonl`);
    control.objects.set(seg(1), `${line({ seq: 0 })}${line({ seq: 1 })}`);
    control.objects.set(seg(2), `${line({ seq: 2 })}{"se`);
    await at.recordHome!.bringHome(into);
    control.objects.set(seg(2), `${line({ seq: 2 })}${line({ seq: 3 })}`);
    control.objects.set(seg(3), line({ seq: 4 }));
    await at.recordHome!.bringHome(into);
    assert.equal(read(join(into, ".spool", "child-9-1.1.jsonl")), `${line({ seq: 0 })}${line({ seq: 1 })}`);
    assert.equal(read(join(into, ".spool", "child-9-1.2.jsonl")), `${line({ seq: 2 })}${line({ seq: 3 })}`);
    assert.equal(read(join(into, ".spool", "child-9-1.3.jsonl")), line({ seq: 4 }));
  });

  it("blobs first: a blob that lands before its line comes home with it; a line whose blob is not on the disk yet waits, and on final is carried and named CARRY_FAILED", async () => {
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    const into = scratch();
    const x = blobOf("frame one");
    const y = blobOf("frame two", "jpg");
    const spool = rec(1, ".spool/child-9-1.jsonl");
    const dest = join(into, ".spool", "child-9-1.jsonl");
    control.objects.set(rec(1, `blobs/${x.name}`), x.text);
    control.objects.set(spool, line({ seq: 0, blobs: [x.hash] }));
    await at.recordHome!.bringHome(into);
    assert.equal(read(join(into, "blobs", x.name)), x.text);
    assert.equal(read(dest), line({ seq: 0, blobs: [x.hash] }));

    control.objects.set(spool, `${line({ seq: 0, blobs: [x.hash] })}${line({ seq: 1, blobs: [y.hash] })}${line({ seq: 2 })}`);
    await at.recordHome!.bringHome(into);
    assert.equal(read(dest), line({ seq: 0, blobs: [x.hash] }), "the line waits for its blob, and the lines after it too");
    // The blob lands after the line that names it: the next call brings both.
    const z = blobOf("frame three");
    control.objects.set(rec(1, `blobs/${y.name}`), y.text);
    await at.recordHome!.bringHome(into);
    assert.equal(read(join(into, "blobs", y.name)), y.text);
    assert.equal(read(dest), [line({ seq: 0, blobs: [x.hash] }), line({ seq: 1, blobs: [y.hash] }), line({ seq: 2 })].join(""));
    control.objects.delete(rec(1, `blobs/${y.name}`));
    control.objects.set(spool, `${read(dest)}${line({ seq: 3, blobs: [z.hash] })}`);
    await assert.rejects(at.recordHome!.bringHome(into, { final: true }), (e: unknown) => e instanceof PlaceError && e.code === "CARRY_FAILED" && e.message.includes(z.hash) && e.message.length <= 240);
    assert.ok(read(dest)!.endsWith(line({ seq: 3, blobs: [z.hash] })), "on final a line whose blob never landed comes home anyway, and says so");
  });

  it("a blob whose bytes do not hash to its name is skipped, everything else comes home, then the call is BLOB_MISMATCH", async () => {
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    const into = scratch();
    const bad = blobOf("the whole frame");
    const good = blobOf("another frame", "jpg");
    control.objects.set(rec(1, `blobs/${bad.name}`), "the who");
    control.objects.set(rec(1, `blobs/${good.name}`), good.text);
    control.objects.set(rec(1, ".spool/child-9-1.jsonl"), `${line({ seq: 0, blobs: [good.hash] })}${line({ seq: 1 })}`);
    for (const final of [false, true]) {
      await assert.rejects(at.recordHome!.bringHome(into, { final }), (e: unknown) => e instanceof PlaceError && e.code === "BLOB_MISMATCH" && e.message.includes(bad.name) && e.message.length <= 240);
      assert.equal(read(join(into, "blobs", bad.name)), null, "never written");
      assert.equal(read(join(into, "blobs", good.name)), good.text, "the rest first");
      assert.equal(read(join(into, ".spool", "child-9-1.jsonl")), `${line({ seq: 0, blobs: [good.hash] })}${line({ seq: 1 })}`);
    }
    control.objects.set(rec(1, `blobs/${bad.name}`), bad.text);
    await at.recordHome!.bringHome(into, { final: true });
    assert.equal(read(join(into, "blobs", bad.name)), bad.text, "the next call tries it again");
  });

  it("no BOX_GONE: the recording is on the run's disk, so after the box is deleted the final call still carries what it wrote", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    const into = scratch();
    const runner = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    control.objects.set(rec(1, ".spool/child-9-1.jsonl"), line({ seq: 0 }));
    await at.kill(runner, "box");
    await at.recordHome!.bringHome(into, { final: true });
    assert.equal(read(join(into, ".spool", "child-9-1.jsonl")), line({ seq: 0 }));
  });

  it("a listing that fails is CARRY_FAILED, in a message of at most 240 characters", async () => {
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    control.failList = Object.assign(new Error(`503 ${"x".repeat(1_000)}`), { status: 503 });
    await assert.rejects(at.recordHome!.bringHome(scratch()), (e: unknown) => e instanceof PlaceError && e.code === "CARRY_FAILED" && e.message.length <= 240);
  });

  it("at start, before the runner, the place makes the EMPTY signals/ and record/<attempt>/.spool/ over the control, owned by the run user; never a file", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = archilPlace({ ...REF, control, host, pollMs: 5, ensure: { create: { uid: 1500, gid: 1500 } } })({ paths: pathsAt("/x") });
    made.push(at);
    const first = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    assert.deepEqual(control.ops.filter((o) => o.startsWith("put ") || o.startsWith("start ")), ["put signals/", "put record/", "put record/1/", "put record/1/.spool/", "put record/1/blobs/", "start g1"], "before the runner");
    assert.ok(control.puts.every((p) => p.key.endsWith("/") && p.uid === 1500 && p.gid === 1500 && p.mode === 0o755), "directories only, the run user's");
    await at.kill(first, "box");
    control.ops.length = 0;
    await at.recover(first, "box", { gen: 2, env: {}, stdin: await at.token!(2) });
    assert.deepEqual(control.ops.filter((o) => o.startsWith("put ")), ["put record/2/", "put record/2/.spool/", "put record/2/blobs/"], "what exists is left as it is");
    await at.release();

    // A put the server refuses (a delegation holds the run): the start fails, saying so, and nothing starts.
    const c3 = new FakeControl();
    const { host: h3, starts } = fakeHost(c3);
    const refused = archilPlace({ ...REF, control: c3, host: h3, pollMs: 5, ensure: { create: { uid: 1500, gid: 1500 } } })({ paths: pathsAt("/x") });
    made.push(refused);
    c3.putRefused = Object.assign(new Error("409 Conflict: the directory is held by another client"), { status: 409 });
    await assert.rejects(refused.start({ gen: 1, env: {}, stdin: await refused.token!(1) }), (e: unknown) => {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      return (e as { code?: string }).code === "HOST_START_FAILED" && cause?.code === "DIRS_REFUSED" && /signals\/ in the run over the control was refused: 409/.test(cause.message ?? "") && (cause.message ?? "").length <= 240;
    });
    assert.equal(starts.length, 0, "no runner over directories that are not there");

    // Without the run user's owner nothing is made: a directory the run user does not own would refuse its files.
    const c2 = new FakeControl();
    const unowned = archilPlace({ ...REF, control: c2, host: fakeHost(c2).host, pollMs: 5 })({ paths: pathsAt("/x") });
    made.push(unowned);
    await unowned.start({ gen: 1, env: {}, stdin: await unowned.token!(1) });
    assert.deepEqual(c2.puts, []);
    await unowned.release();
  });
});

describe("archilPlace", () => {
  it("mints a mount token per attempt through its control: a runner starts with the token it was handed, with its order's environment", async () => {
    const control = new FakeControl();
    const { host, starts } = fakeHost(control);
    const place = archilPlace({ ...REF, control, host, pollMs: 5 })({ paths: pathsAt("/local/ignored") });
    made.push(place);
    assert.equal(place.name, "archil");
    assert.deepEqual(place.paths, { id: ID, root: `/mnt/fake/runs/${ID}`, work: `/mnt/fake/runs/${ID}/work`, store: `/mnt/fake/runs/${ID}/store` });
    assert.deepEqual(place.kills, ["box"], "what the driver's kill takes");

    const t1 = await place.token!(1);
    const t2 = await place.token!(2);
    assert.ok(t1 && t2 && t1 !== t2, "one token per attempt");
    const nicknames = [...control.users.values()].map((u) => parseTokenNickname(u.nickname));
    assert.deepEqual(nicknames.map((n) => [n?.runId, n?.attempt]), [[ID, 1], [ID, 2]], "each token user names its run and attempt");

    const runner = await place.start({ gen: 1, env: { PLAN: "p1" }, stdin: t1 });
    assert.deepEqual(starts.map((s) => [s.token, s.attempt]), [[t1, { attempt: 1, env: { PLAN: "p1" } }]]);
    assert.equal(control.ops.filter((o) => o.startsWith("addUser")).length, 2, "the start used the token it was handed: no third mint");
    assert.equal(runner.epoch, 1, "the generation the instance opens");

    // A supervisor that hands no token: the start mints its own, for its order's number.
    const c2 = new FakeControl();
    const unhanded = makePlace({ ...REF, control: c2, host: fakeHost(c2).host });
    await unhanded.start({ gen: 3, env: {} });
    assert.deepEqual(c2.ops, ["addUser pda-place-run-g3", "start g1"], "the token user names the supervisor's attempt; the driver's attempt is the generation the instance opens");
    await unhanded.release();
    await place.release();
  });

  it("kill is the driver's; recover takes the run over: the dead holder's fresh lease revoked, the next attempt's token, its revoke and duration reported", async () => {
    const control = new FakeControl();
    const { host, starts } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    const first = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    control.ops.length = 0;

    await at.kill(first, "box");
    const ended = await first.exited;
    assert.deepEqual([ended.exit, ended.signal, ended.outcome?.status, ended.outcome?.generation], ["SIGKILL", "SIGKILL", "failed", 1]);
    assert.deepEqual(control.ops, ["kill box-1"]);
    control.ops.length = 0;

    const t2 = await at.token!(2);
    const { runner, revoked, ms } = await at.recover(first, "box", { gen: 2, env: { PLAN: "p2" }, stdin: t2 });
    assert.deepEqual(control.ops, ["addUser pda-place-run-g2", "revoke c-box-1", "start g2"], "no second kill; the heartbeat was fresh, and the place revoked anyway");
    assert.deepEqual(revoked, [{ clientId: "c-box-1", inodeId: 7, path: `runs/${ID}`, isOrphaned: false }]);
    assert.equal(typeof ms, "number");
    assert.equal(starts.at(-1)!.token, t2);
    assert.equal(runner.epoch, 2);

    const status = await at.status!();
    assert.deepEqual([status.record?.generation, status.delegations?.map((d) => d.clientId)], [2, ["c-box-2"]]);
  });

  it("a runner that ends on its own: exit is the host's status and the outcome run.json's detail; a later kill is a no-op", async () => {
    const control = new FakeControl();
    const { host, states } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    const runner = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    control.runJson({ status: "done", generation: 1, detail: { record: { n: 3 }, storeSha256: "ab", code: "OK" } });
    states.set("box-1", "stopped");
    assert.deepEqual(await runner.exited, { exit: "stopped", signal: null, outcome: { status: "complete", generation: 1, code: "OK", record: { n: 3 }, storeSha256: "ab" }, stderr: "" });
    await at.kill(runner, "box");
    assert.ok(!control.ops.includes("kill box-1"));
  });

  it("run.json's outcome is in the run's word: complete only when done with a delivered record; done with none, failed or abandoned is failed", async () => {
    const cases = [
      [{ status: "done", detail: { record: { n: 1 } } }, "complete"],
      [{ status: "done", detail: { steps: 4 } }, "failed"],
      [{ status: "done", detail: { record: null } }, "failed"],
      [{ status: "done", detail: null }, "failed"],
      [{ status: "failed", detail: { code: "APP_GAVE_UP", record: { n: 1 } } }, "failed"],
      [{ status: "running" }, "failed"],
    ] as const;
    for (const [record, status] of cases) {
      const control = new FakeControl();
      const { host, states } = fakeHost(control);
      const at = makePlace({ ...REF, control, host });
      const runner = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
      control.runJson({ generation: 1, ...record });
      states.set("box-1", "stopped");
      assert.equal((await runner.exited).outcome?.status, status, JSON.stringify(record));
    }
  });

  it("a done run starts nothing: the token goes, and the runner ends as it begins", async () => {
    const control = new FakeControl();
    control.runJson({ status: "done", generation: 4, detail: { record: "r" } });
    const { host, starts } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    const runner = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    assert.equal(starts.length, 0);
    assert.deepEqual(control.users.size, 0, "the unused token user was removed");
    assert.deepEqual((await runner.exited).outcome, { status: "complete", generation: 4, code: null, record: "r" });
    await at.release();
  });

  it("release stops what it started and removes every token it minted, once", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    const runner = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    await at.token!(2);
    await at.release();
    assert.equal(control.users.size, 0);
    assert.ok(control.ops.includes("stop box-1"));
    assert.equal((await runner.exited).exit, "stopped");
    control.ops.length = 0;
    await at.release();
    assert.deepEqual(control.ops, [], "nothing left to stop or remove");
  });

  it("a release whose stop fails keeps the handle: it says so, and the next release stops it", async () => {
    const control = new FakeControl();
    const { host, faults } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    const runner = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    faults.stop = 1;
    await assert.rejects(at.release(), (e: unknown) => e instanceof PlaceError && e.code === "RELEASE_FAILED" && /stop box-1: cannot reach the box/.test(e.message));
    control.ops.length = 0;
    await at.release();
    assert.deepEqual(control.ops, ["stop box-1"], "tried again; the token went the first time");
    assert.equal((await Promise.race([runner.exited, sleep(2_000).then(() => ({ exit: "still running" }))])).exit, "stopped");
  });

  it("a start the driver refuses: the unused token is removed even when ensureRunning's own removal failed, and release retries what is left", async () => {
    const control = new FakeControl();
    const { host, faults } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    faults.start = 1;
    control.removeFails = 1; // ensureRunning's removal
    await assert.rejects(at.start({ gen: 1, env: {}, stdin: await at.token!(1) }), (e: unknown) => (e as { code?: string }).code === "HOST_START_FAILED");
    assert.equal(control.users.size, 0, "the place removed it again");

    faults.start = 1;
    control.removeFails = 2; // ensureRunning's and the place's
    await assert.rejects(at.start({ gen: 2, env: {}, stdin: await at.token!(2) }));
    assert.equal(control.users.size, 1, "both removals failed: the user is still there");
    await at.release();
    assert.equal(control.users.size, 0, "release removed it");
  });

  it("signals: the attempt's request is read from the run's directory over S3, where requestFile says the runner writes it; return() ends a next() whose read hangs", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = makePlace({ ...REF, control, host, signalPollMs: 5 });
    assert.equal(at.requestFile!(3), `/mnt/fake/runs/${ID}/signals/kill-3.json`, "in the run's mount, outside work/");
    assert.throws(() => at.requestFile!(0), (e: unknown) => e instanceof PlaceError && e.code === "INVALID_ARGUMENT");
    const key = `runs/${ID}/signals/kill-3.json`;

    const it3 = at.signals!(3)[Symbol.asyncIterator]();
    const first = it3.next();
    let settled = false;
    void first.then(() => (settled = true));
    control.objects.set(key, '{"point":"paid-call.ackn');
    await sleep(40);
    assert.equal(settled, false, "half a request is not one");
    control.objects.set(key, JSON.stringify({ point: "paid-call.acknowledged", n: 1, pid: 4, nonce: "0f1e" }));
    assert.deepEqual(
      await first,
      { done: false, value: { kind: "kill-request", crossing: { point: "paid-call.acknowledged", n: 1, pid: 4 }, nonce: "0f1e" } },
      "the nonce is the signal's, read at its top, and not the crossing's; every other field stays in the crossing",
    );
    assert.deepEqual(await it3.next(), { done: true, value: undefined });

    // No nonce, or one that is not a string: the signal has no nonce field, and the crossing none either.
    for (const [request, attempt] of [[{ point: "p", n: 2 }, 5], [{ point: "p", n: 2, nonce: 7 }, 6]] as const) {
      control.objects.set(`runs/${ID}/signals/kill-${attempt}.json`, JSON.stringify(request));
      const got = (await at.signals!(attempt)[Symbol.asyncIterator]().next()).value as Record<string, unknown>;
      assert.deepEqual(got, { kind: "kill-request", crossing: { point: "p", n: 2 } }, JSON.stringify(request));
      assert.ok(!("nonce" in got), "no nonce field at all");
    }

    control.hangUnder = `runs/${ID}/signals/`;
    const it4 = at.signals!(4)[Symbol.asyncIterator]();
    const pending = it4.next();
    await sleep(20);
    await it4.return!();
    const ended = await Promise.race([pending, new Promise((r) => setImmediate(() => r("late")))]);
    assert.deepEqual(ended, { done: true, value: undefined }, "the return ended it though its read never answered");
  });

  it("a runner whose status reads fail stays killable: its exited reports the failure, and kill still kills", async () => {
    const control = new FakeControl();
    const { host, faults } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    const runner = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    faults.status = 1_000;
    await assert.rejects(runner.exited, (e: unknown) => e instanceof PlaceError && e.code === "STATUS_FAILED");
    faults.status = 0;
    await at.kill(runner, "box");
    assert.ok(control.ops.includes("kill box-1"), "the driver's kill ran");
  });

  it("recover leaves a newer holder another supervisor started to the usual checks: no revoke, no start, HELD", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    const first = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    await at.kill(first, "box");
    // Before this recover reads the disk, another supervisor's instance opened generation 2 and holds the run.
    control.runJson({ generation: 2, holder: { driver: "other", host: "elsewhere", bootId: null, pid: 9, since: new Date().toISOString() } });
    control.delegations = [{ clientId: "c-other", inodeId: 7, path: `runs/${ID}`, isPending: false, isOrphaned: false }];
    control.ops.length = 0;
    await assert.rejects(at.recover(first, "box", { gen: 2, env: {}, stdin: await at.token!(2) }), (e: unknown) => e instanceof PlaceError && e.code === "HELD");
    assert.ok(!control.ops.some((o) => o.startsWith("revoke") || o.startsWith("start")), control.ops.join(", "));
  });

  it("every disk call the place makes is bounded: a recovery whose run.json read stalls fails CONTROL_API_FAILED instead of waiting forever", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = makePlace({ ...REF, control, host, ensure: { controlTimeoutMs: 50 } });
    const first = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    await at.kill(first, "box");
    const t2 = await at.token!(2);
    control.hangUnder = `runs/${ID}/run.json`;
    const ended = await Promise.race([
      at.recover(first, "box", { gen: 2, env: {}, stdin: t2 }).then(() => "recovered", (e: unknown) => e),
      sleep(5_000).then(() => "still waiting"),
    ]);
    assert.equal((ended as { code?: string }).code, "CONTROL_API_FAILED", String(ended));
    control.hangUnder = null;
  });

  it("status keeps one resolver: a delegation Archil lists with no path costs one exec over many calls, and a failed exec does not fail the next call", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = makePlace({ ...REF, control, host });
    control.inodes.set(ID, 7);
    control.delegations = [{ clientId: "c-1", inodeId: 7, isPending: false, isOrphaned: false } as Delegation];
    for (let i = 0; i < 5; i++) assert.deepEqual((await at.status!()).delegations?.map((d) => d.clientId), ["c-1"]);
    assert.equal(control.execs, 1, "the inode was attributed once");

    const other = makePlace({ ...REF, control, host });
    control.execs = 0;
    control.execFails = 1;
    await assert.rejects(other.status!(), (e: unknown) => (e as { code?: string }).code === "CONTROL_API_FAILED");
    assert.deepEqual((await other.status!()).delegations?.map((d) => d.clientId), ["c-1"], "the next call resolved it with a new resolver");
    assert.equal(control.execs, 2);
  });

  it("signals: a long poll attaches nothing to anything that lives as long as the iterator (the heap does not grow with polls)", { timeout: 120_000 }, async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    // The places the tests before made still poll their runners' status: quiet them, so the heap is this iterator's.
    await Promise.all(made.map((p) => p.release().catch(() => {})));
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = makePlace({ ...REF, control, host, signalPollMs: 0 });
    const it = at.signals!(9)[Symbol.asyncIterator]();
    const pending = it.next();
    const heapAfter = async (polls: number) => {
      const until = control.gets + polls;
      while (control.gets < until) await sleep(50);
      gc();
      return process.memoryUsage().heapUsed;
    };
    const before = await heapAfter(300);
    const after = await heapAfter(3_000);
    await it.return!();
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.ok(after - before < 1_000_000, `the heap grew ${after - before} bytes over 3000 polls`);
  });

  it("signals never reject: a lasting read failure is one signals-failed and then done; a short one is retried; a missing request is waited for", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const at = makePlace({ ...REF, control, host, signalPollMs: 5, signalFailMs: 200 });
    const prefix = `runs/${ID}/signals/`;
    /** The next result, or the rejection as a value (which must never come), or "no word" after 5 s. */
    const nextOf = (it: AsyncIterator<unknown>) =>
      Promise.race([it.next().then((r) => r, (e: unknown) => ({ rejected: e })), new Promise((r) => setTimeout(() => r("no word after 5 s"), 5_000).unref())]);

    // A failure shorter than signalFailMs, then the request: it is yielded.
    const it1 = at.signals!(1)[Symbol.asyncIterator]();
    const first = nextOf(it1);
    control.failUnder = { prefix, error: Object.assign(new Error("503 Slow Down"), { status: 503 }) };
    await sleep(60);
    control.failUnder = null;
    control.objects.set(`${prefix}kill-1.json`, JSON.stringify({ point: "p", n: 1 }));
    assert.deepEqual(await first, { done: false, value: { kind: "kill-request", crossing: { point: "p", n: 1 } } });

    // A read refused for good: one signals-failed (the read's own code when it has one, else SIGNALS_FAILED), then done.
    for (const [error, code] of [
      [Object.assign(new Error("AccessDenied"), { status: 403 }), "SIGNALS_FAILED"],
      [Object.assign(new Error("getObject did not answer in 10000 ms"), { code: "CONTROL_API_FAILED" }), "CONTROL_API_FAILED"],
      [Object.assign(new Error(`AccessDenied ${"x".repeat(1_000)}`), { status: 403 }), "SIGNALS_FAILED"],
    ] as const) {
      const it2 = at.signals!(2)[Symbol.asyncIterator]();
      control.failUnder = { prefix, error };
      const failed = (await nextOf(it2)) as { done: boolean; value: { kind: string; code: string; message: string } };
      assert.equal(failed.done, false, JSON.stringify(failed));
      assert.equal(failed.value.kind, "signals-failed");
      assert.equal(failed.value.code, code);
      assert.ok(`reading the kill request failed for 200 ms: ${error.message}`.startsWith(failed.value.message), failed.value.message);
      assert.ok(failed.value.message.length <= 240, `the whole message is capped: ${failed.value.message.length} characters`);
      assert.match(failed.value.message, /^reading the kill request failed for 200 ms: AccessDenied|^reading the kill request failed for 200 ms: getObject/);
      assert.deepEqual(await nextOf(it2), { done: true, value: undefined }, "then the iterator ends");
      control.failUnder = null;
    }

    // No request at all for longer than signalFailMs: a missing object is not a failure.
    const it3 = at.signals!(3)[Symbol.asyncIterator]();
    const pending = nextOf(it3);
    let settled = false;
    void pending.then(() => (settled = true));
    await sleep(300);
    assert.equal(settled, false, "still waiting, no signal and no rejection");
    await it3.return!();
    assert.deepEqual(await pending, { done: true, value: undefined });
  });

  it("a driver with no kill: kills is empty and kill refuses", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control, null);
    const at = makePlace({ ...REF, control, host });
    assert.deepEqual(at.kills, []);
    const runner = await at.start({ gen: 1, env: {} });
    await assert.rejects(at.kill(runner, "process"), (e: unknown) => e instanceof PlaceError && e.code === "KILL_UNSUPPORTED");
    await at.release();
  });
});
