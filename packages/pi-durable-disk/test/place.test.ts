// Places: localPlace runs the real CLI on a directory (a kill, then a resume with the next order), and archilPlace runs
// over a fake control API and a fake host driver (a mount token minted per attempt, the kill, the takeover, release).
// No Archil, no network.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delegation } from "disk";
import { archilPlace, localPlace, PlaceError, writeAll, type UnheldRun, type UnheldStart } from "../src/place.ts";
import { RunFileError } from "../src/run-files.ts";
import { parseTokenNickname } from "../src/claim.ts";
import type { HostBox, HostDriver, HostHandle, HostStatus, StartAttempt, SupervisorControl } from "../src/supervise.ts";
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

describe("place outcome models", () => {
  const MODELS = { lead: "claude-opus-5-5", eyes: "gpt-vision-2" };
  /** A models value the app reported, and what the outcome should carry: a plain object of strings, else nothing. */
  const cases: [string, unknown, Record<string, string> | undefined][] = [
    ["a plain object of strings", MODELS, MODELS],
    ["absent", undefined, undefined],
    ["an array", ["claude-opus-5-5"], undefined],
    ["a string", "claude-opus-5-5", undefined],
    ["a non-string value", { lead: "claude-opus-5-5", eyes: 2 }, undefined],
    ["null", null, undefined],
  ];
  const carries = (outcome: unknown, want: Record<string, string> | undefined, name: string) => {
    if (want === undefined) assert.ok(outcome !== null && typeof outcome === "object" && !("models" in outcome), `${name}: no models field, never {}: ${JSON.stringify(outcome)}`);
    else assert.deepEqual((outcome as { models?: unknown }).models, want, name);
  };

  it("localPlace: the outcome line's models only when they are a plain object of strings, and run.json's on a failed run that printed none", { timeout: 240_000 }, async () => {
    for (const [name, models, want] of cases) {
      const place = localPlace({ app: APP })({ paths: pathsAt(scratch()) });
      const env: Record<string, string> = { PLACE_FINISH: "1", ...(models === undefined ? {} : { PLACE_MODELS: JSON.stringify(models) }) };
      const ended = await (await place.start({ gen: 1, env })).exited;
      assert.equal(ended.outcome?.status, "complete", `${name}: ${ended.stderr}`);
      carries(ended.outcome, want, `the outcome line, ${name}`);
    }
    const place = localPlace({ app: APP })({ paths: pathsAt(scratch()) });
    const failed = await (await place.start({ gen: 1, env: { PLACE_FINISH: "1", PLACE_SILENT: "1", PLACE_FAIL: "1", PLACE_MODELS: JSON.stringify(MODELS) } })).exited;
    assert.equal(failed.outcome?.status, "failed", failed.stderr);
    assert.deepEqual(failed.outcome?.models, MODELS, "a failed run used models too: run.json's detail carries them");
  });

  it("archilPlace: run.json's final detail.models on a complete or a failed outcome, only when they are a plain object of strings", async () => {
    for (const status of ["done", "failed"] as const) {
      for (const [name, models, want] of cases) {
        const control = new FakeControl();
        const { host, states } = fakeHost(control);
        const at = makePlace({ ...REF, control, host });
        const runner = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
        control.runJson({ generation: 1, status, detail: { record: { n: 1 }, ...(models === undefined ? {} : { models }) } });
        states.set("box-1", "stopped");
        const outcome = (await runner.exited).outcome;
        assert.equal(outcome?.status, status === "done" ? "complete" : "failed", name);
        carries(outcome, want, `${status}, ${name}`);
        await at.release();
      }
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
    if (this.onGet) await this.onGet(key);
    if (this.hangUnder !== null && key.startsWith(this.hangUnder)) return new Promise<Uint8Array>(() => {});
    if (this.failUnder !== null && key.startsWith(this.failUnder.prefix)) throw this.failUnder.error;
    const v = this.objects.get(key);
    if (v === undefined) throw Object.assign(new Error("NoSuchKey"), { status: 404, code: "NoSuchKey" });
    return new TextEncoder().encode(v);
  }
  /** Called before a get or a head answers: a test that must hold two callers at one point (a barrier) waits here. */
  onGet: ((key: string) => Promise<void> | void) | null = null;
  onHead: ((key: string) => Promise<void> | void) | null = null;
  async headObject(key: string) {
    if (this.onHead) await this.onHead(key);
    return this.objects.has(key) ? {} : null;
  }
  /** Every put, with the owner and mode it asked for; and a listing that fails, when set. */
  puts: { key: string; uid: number; gid: number; mode: number }[] = [];
  lists = 0;
  failList: Error | null = null;
  /** A put of a key under record/ or signals/ that the server refuses (a run a delegation holds), when set. */
  putRefused: Error | null = null;
  /** Every put of any key, in order, with its body, owner and mode; and an error every put of a key under `putFaultUnder` throws. */
  allPuts: { key: string; body: string; uid: number; gid: number; mode: number }[] = [];
  putFaultUnder: { prefix: string; error: Error } | null = null;
  async putObject(key: string, body: string, options: { uid: number; gid: number; mode: number } = { uid: -1, gid: -1, mode: -1 }) {
    if (this.putFaultUnder !== null && key.startsWith(this.putFaultUnder.prefix)) throw this.putFaultUnder.error;
    this.allPuts.push({ key, body, ...options });
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

  it("carriers that overlap on one destination append each line once: two calls of one place, two places, a third that finds the lines home", async () => {
    const control = new FakeControl();
    const spool = rec(1, ".spool/child-9-1.jsonl");
    const lines = [0, 1, 2, 3, 4].map((seq) => line({ seq })).join("");
    control.objects.set(spool, lines);
    const one = makePlace({ ...REF, control, host: fakeHost(control).host });
    const other = makePlace({ ...REF, control, host: fakeHost(control).host });
    const into = scratch();
    // Both read the destination's offset (0) before either appends: without the recheck under the lock, both append.
    await Promise.all([one.recordHome!.bringHome(into), one.recordHome!.bringHome(into), other.recordHome!.bringHome(into)]);
    assert.equal(read(join(into, ".spool", "child-9-1.jsonl")), lines, "each line once");
    await other.recordHome!.bringHome(into, { final: true });
    assert.equal(read(join(into, ".spool", "child-9-1.jsonl")), lines);
    assert.deepEqual(readdirSync(join(into, ".spool")), ["child-9-1.jsonl"], "no lock is left behind");
  });

  it("a second destination gets every line, even of the files this place already carried elsewhere and that did not grow", async () => {
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    const spool = rec(1, ".spool/child-9-1.jsonl");
    control.objects.set(spool, `${line({ seq: 0 })}${line({ seq: 1 })}`);
    const a = scratch();
    const b = scratch();
    await at.recordHome!.bringHome(a);
    await at.recordHome!.bringHome(b);
    assert.equal(read(join(b, ".spool", "child-9-1.jsonl")), `${line({ seq: 0 })}${line({ seq: 1 })}`);
    assert.equal(read(join(a, ".spool", "child-9-1.jsonl")), read(join(b, ".spool", "child-9-1.jsonl")));
  });

  it("a destination file's lock: one left by a carrier that is gone is taken over; one a live carrier keeps is CARRY_FAILED after the wait", { timeout: 30_000 }, async () => {
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    control.objects.set(rec(1, ".spool/child-9-1.jsonl"), line({ seq: 0 }));
    const into = scratch();
    mkdirSync(join(into, ".spool"), { recursive: true });
    const lock = join(into, ".spool", ".child-9-1.jsonl.lock");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    writeFileSync(lock, dead);
    await at.recordHome!.bringHome(into);
    assert.equal(read(join(into, ".spool", "child-9-1.jsonl")), line({ seq: 0 }), "a gone holder's lock is taken over");
    assert.equal(existsSync(lock), false);
    control.objects.set(rec(1, ".spool/child-9-1.jsonl"), `${line({ seq: 0 })}${line({ seq: 1 })}`);
    writeFileSync(lock, String(process.pid)); // a live carrier: this process, as another one would be
    const t0 = Date.now();
    await assert.rejects(at.recordHome!.bringHome(into), (e: unknown) => e instanceof PlaceError && e.code === "CARRY_FAILED" && /holds/.test(e.message) && e.message.length <= 240);
    assert.ok(Date.now() - t0 >= 5_000, "it waited for the holder first");
    assert.equal(read(join(into, ".spool", "child-9-1.jsonl")), line({ seq: 0 }), "nothing appended while another holds it");
  });

  it("a destination file's lock that cannot be read is CARRY_FAILED at once, never a wait without end", { timeout: 30_000 }, async (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads every file");
    const control = new FakeControl();
    const at = makePlace({ ...REF, control, host: fakeHost(control).host });
    control.objects.set(rec(1, ".spool/child-9-1.jsonl"), line({ seq: 0 }));
    const into = scratch();
    mkdirSync(join(into, ".spool"), { recursive: true });
    const lock = join(into, ".spool", ".child-9-1.jsonl.lock");
    writeFileSync(lock, "4242");
    chmodSync(lock, 0o000);
    try {
      const t0 = Date.now();
      await assert.rejects(at.recordHome!.bringHome(into), (e: unknown) => e instanceof PlaceError && e.code === "CARRY_FAILED" && /reading the carry lock/.test(e.message) && e.message.length <= 240);
      assert.ok(Date.now() - t0 < 5_000, "refused at once, not after the wait");
      assert.equal(read(join(into, ".spool", "child-9-1.jsonl")), null);
    } finally {
      chmodSync(lock, 0o644);
    }
  });

  it("writeAll goes on after a short write, and a write that takes nothing fails", () => {
    const got: number[] = [];
    writeAll(7, new Uint8Array([1, 2, 3, 4, 5, 6, 7]), (_fd, bytes, offset, length) => {
      const n = Math.min(3, length);
      got.push(...bytes.subarray(offset, offset + n));
      return n;
    });
    assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7]);
    assert.throws(() => writeAll(7, new Uint8Array([1, 2]), () => 0), (e: unknown) => e instanceof PlaceError && e.code === "CARRY_FAILED");
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

describe("archilPlace HOST_BOX: each host box's runner is told which label to claim", () => {
  /** A host whose boxes are a provider's, with a receipt for each box unless it is in `noReceipt`. */
  const providing = (control: FakeControl, provider: string | undefined, noReceipt = new Set<string>()) => {
    const fake = fakeHost(control);
    const host: HostDriver = {
      ...fake.host,
      ...(provider ? { provider } : {}),
      box: (h) => (noReceipt.has(String(h.name)) ? null : { provider: provider ?? "none", kind: `sandbox ${h.name}`, from: "2026-10-22T00:00:00.000Z", to: null }),
    };
    return { host, starts: fake.starts };
  };

  it("each start puts HOST_BOX { provider, key: the box's index in status().boxes, run: RUN_LABEL } in that order's env", async () => {
    const control = new FakeControl();
    const { host, starts } = providing(control, "modal");
    const place = makePlace({ ...REF, control, host });
    const first = await place.start({ gen: 1, env: { RUN_LABEL: "life-1" }, stdin: await place.token!(1) });
    await place.kill(first, "box");
    await place.recover(first, "box", { gen: 2, env: { RUN_LABEL: "life-1" }, stdin: await place.token!(2) });
    const asked = starts.map((s) => JSON.parse(s.attempt!.env!.HOST_BOX!) as { provider: string; key: string; run: string });
    assert.deepEqual(asked, [{ provider: "modal", key: "0", run: "life-1" }, { provider: "modal", key: "1", run: "life-1" }]);
    const boxes = (await place.status!()).boxes!;
    assert.deepEqual(asked.map((a) => boxes[Number(a.key)]!.kind), ["sandbox box-1", "sandbox box-2"], "each key is that box's index in status().boxes");
    assert.ok(asked.every((a) => boxes[Number(a.key)]!.provider === a.provider), "and names its provider");
  });

  it("no HOST_BOX without the order's RUN_LABEL or a driver that names its provider; with HOST_BOX in play, a box with no receipt fails status() instead of shifting the rest", async () => {
    const c1 = new FakeControl();
    const noLife = providing(c1, "modal");
    const p1 = makePlace({ ...REF, control: c1, host: noLife.host });
    await p1.start({ gen: 1, env: {}, stdin: await p1.token!(1) });
    assert.equal(noLife.starts[0]!.attempt!.env!.HOST_BOX, undefined, "no life, no label to claim");
    const c2 = new FakeControl();
    const noProvider = providing(c2, undefined);
    const p2 = makePlace({ ...REF, control: c2, host: noProvider.host });
    await p2.start({ gen: 1, env: { RUN_LABEL: "life-1" }, stdin: await p2.token!(1) });
    assert.equal(noProvider.starts[0]!.attempt!.env!.HOST_BOX, undefined, "a driver that names no provider");
    const c3 = new FakeControl();
    const missing = new Set<string>();
    const gap = providing(c3, "modal", missing);
    const p3 = makePlace({ ...REF, control: c3, host: gap.host });
    await p3.start({ gen: 1, env: { RUN_LABEL: "life-1" }, stdin: await p3.token!(1) });
    missing.add("box-1");
    await assert.rejects(p3.status!(), (e: unknown) => e instanceof PlaceError && e.code === "STATUS_FAILED" && /no receipt for host box 0/.test(e.message));
  });

  it("no HOST_BOX from a place that cannot read its run's files (its control cannot list): no read members, no label to claim", async () => {
    const control = new FakeControl();
    (control as unknown as { listObjects?: unknown }).listObjects = undefined;
    const { host, starts } = providing(control, "modal");
    const place = makePlace({ ...REF, control, host });
    assert.equal(place.readRunFile, undefined);
    assert.equal(place.listRunFiles, undefined);
    await place.start({ gen: 1, env: { RUN_LABEL: "life-1" }, stdin: await place.token!(1) });
    assert.equal(starts[0]!.attempt!.env!.HOST_BOX, undefined, "a label the place could never read back is never handed over");
  });
});

describe("archilPlace unheld: a hook in the start window, while nobody holds the run (K9)", () => {
  const OWNER = { create: { uid: 1500, gid: 1500 } };
  const run = `runs/${ID}/`;
  const LIFE = { RUN_LABEL: "life-1" };
  /** A host whose boxes are a provider's, with a receipt for each: a start of it carries HOST_BOX, so the hook gets `box`. */
  const providing = (control: FakeControl) => {
    const fake = fakeHost(control);
    const host: HostDriver = { ...fake.host, provider: "modal", box: (h) => ({ provider: "modal", kind: `vm ${h.name}`, from: "2026-10-22T00:00:00.000Z", to: null }) };
    return { host, starts: fake.starts };
  };
  /** How a failed start reaches the caller: ensureRunning wraps the driver's throw, and the place's code is its cause. */
  const startFails = (code: string, re?: RegExp) => (e: unknown) => {
    const cause = (e as { cause?: unknown }).cause;
    return (e as { code?: string }).code === "HOST_START_FAILED" && cause instanceof PlaceError && cause.code === code && (!re || re.test(cause.message));
  };
  const runFileCode = (e: unknown) => (e instanceof RunFileError ? e.code : String(e));
  const owned = (c: FakeControl, key: string) => c.allPuts.filter((p) => p.key === `${run}${key}`).map(({ uid, gid, mode }) => ({ uid, gid, mode }));
  const closed = Object.assign(new Error("409 OperationAborted: another client holds a write delegation"), { status: 409, code: "OperationAborted" });

  it("runs once per start, after makeDirs and before host.start, with the attempt and exactly the HOST_BOX that start carries; what it returns reaches that start's environment", async () => {
    const control = new FakeControl();
    const { host, starts } = providing(control);
    const seen: UnheldStart[] = [];
    const place = makePlace({
      ...REF, control, host, ensure: OWNER,
      unheld: async (r: UnheldRun, start: UnheldStart) => {
        control.ops.push(`unheld g${start.attempt}`);
        assert.equal(r.id, ID);
        seen.push(start);
        return { LABEL_HINT: `hint-${start.attempt}` };
      },
    });
    const first = await place.start({ gen: 1, env: LIFE, stdin: await place.token!(1) });
    await place.kill(first, "box");
    await place.recover(first, "box", { gen: 2, env: LIFE, stdin: await place.token!(2) });
    assert.deepEqual(seen, [
      { attempt: 1, box: { provider: "modal", key: "0", run: "life-1" } },
      { attempt: 2, box: { provider: "modal", key: "1", run: "life-1" } },
    ]);
    starts.forEach((s, i) => {
      assert.deepEqual(JSON.parse(s.attempt!.env!.HOST_BOX!), seen[i]!.box, "start.box is the HOST_BOX that start carries");
      assert.equal(s.attempt!.env!.LABEL_HINT, `hint-${i + 1}`, "the returned env reaches that start");
      assert.equal(s.attempt!.env!.RUN_LABEL, "life-1", "beside the order's own");
    });
    const order = control.ops.filter((o) => /^(put signals\/$|unheld g1|start g1)/.test(o));
    assert.deepEqual(order, ["put signals/", "unheld g1", "start g1"], "makeDirs, then the hook, then the driver");
  });

  it("start.box is absent when the place hands no label over (no RUN_LABEL, or a driver that names no provider); the hook still runs", async () => {
    const c1 = new FakeControl();
    const seen: UnheldStart[] = [];
    const p1 = makePlace({ ...REF, control: c1, host: providing(c1).host, ensure: OWNER, unheld: async (_r: UnheldRun, s: UnheldStart) => void seen.push(s) });
    await p1.start({ gen: 1, env: {}, stdin: await p1.token!(1) });
    const c2 = new FakeControl();
    const p2 = makePlace({ ...REF, control: c2, host: fakeHost(c2).host, ensure: OWNER, unheld: async (_r: UnheldRun, s: UnheldStart) => void seen.push(s) });
    await p2.start({ gen: 1, env: LIFE, stdin: await p2.token!(1) });
    assert.deepEqual(seen, [{ attempt: 1 }, { attempt: 1 }]);
  });

  it("put is create-only: the file owned by the run user, 0644, every missing parent made first as a 0755 marker the run user owns; a file or a directory already there is EXISTS, and nothing is written; after the hook returns, a put is WINDOW_CLOSED with no request", async () => {
    const control = new FakeControl();
    control.objects.set(`${run}box-ids.internal/`, "");
    control.objects.set(`${run}box-ids.internal/taken.json`, "earlier");
    control.objects.set(`${run}box-ids.internal/adir/`, "");
    const answers: string[] = [];
    let kept: UnheldRun | undefined;
    const place = makePlace({
      ...REF, control, host: fakeHost(control).host, ensure: OWNER,
      unheld: async (r: UnheldRun) => {
        kept = r;
        await r.put("box-ids.internal/pending/life-1-1.json", '{"provider":"modal"}');
        for (const path of ["box-ids.internal/taken.json", "box-ids.internal/adir", "box-ids.internal/pending/life-1-1.json"]) {
          answers.push(await r.put(path, "x").then(() => "written", runFileCode));
        }
      },
    });
    await place.start({ gen: 1, env: {}, stdin: await place.token!(1) });
    assert.deepEqual(answers, ["EXISTS", "EXISTS", "EXISTS"]);
    assert.equal(control.objects.get(`${run}box-ids.internal/taken.json`), "earlier", "nothing written over");
    assert.equal(control.objects.get(`${run}box-ids.internal/pending/life-1-1.json`), '{"provider":"modal"}');
    assert.deepEqual(owned(control, "box-ids.internal/pending/"), [{ uid: 1500, gid: 1500, mode: 0o755 }], "the missing parent, once, the run user's");
    assert.deepEqual(owned(control, "box-ids.internal/"), [], "a parent already there is not made again");
    assert.deepEqual(owned(control, "box-ids.internal/pending/life-1-1.json"), [{ uid: 1500, gid: 1500, mode: 0o644 }]);
    const keys = control.allPuts.map((p) => p.key);
    assert.ok(keys.indexOf(`${run}box-ids.internal/pending/`) < keys.indexOf(`${run}box-ids.internal/pending/life-1-1.json`), "the parent before the file");
    const before = control.allPuts.length;
    await assert.rejects(kept!.put("box-ids.internal/late.json", "{}"), (e: unknown) => runFileCode(e) === "WINDOW_CLOSED");
    assert.equal(control.allPuts.length, before, "no request once the window is closed");
  });

  it("put refuses a path outside K8's rules with INVALID_PATH before any request, and its message never echoes the path", async () => {
    const control = new FakeControl();
    const refused: string[] = [];
    const place = makePlace({
      ...REF, control, host: fakeHost(control).host, ensure: OWNER,
      unheld: async (r: UnheldRun) => {
        for (const bad of ["", "/abs.json", "a//b.json", "../up.json", "a/./b.json", ".archil/c.json", "bad name.json", "trailing/"]) {
          await r.put(bad, "x").then(
            () => refused.push(`written ${bad}`),
            (e: unknown) => {
              assert.equal(runFileCode(e), "INVALID_PATH", JSON.stringify(bad));
              if (bad.length > 2) assert.ok(!(e as Error).message.includes(bad), `the message never echoes ${JSON.stringify(bad)}`);
              refused.push("INVALID_PATH");
            },
          );
        }
      },
    });
    await place.start({ gen: 1, env: {}, stdin: await place.token!(1) });
    assert.deepEqual(refused, Array(8).fill("INVALID_PATH"));
    assert.deepEqual(control.allPuts.filter((p) => !/\/(signals|record)\//.test(p.key) && !p.key.endsWith("start.json") && p.key !== run), [], "no request was made for any of them");
  });

  it("a put answered exactly 409 OperationAborted is WINDOW_CLOSED, and it fails the start even when the hook catches it: host.start is never called, the token goes, the hook ran once", async () => {
    const control = new FakeControl();
    const { host, starts } = fakeHost(control);
    control.putFaultUnder = { prefix: `${run}box-ids.internal/`, error: closed };
    let caught: unknown;
    let calls = 0;
    const place = makePlace({
      ...REF, control, host, ensure: OWNER,
      unheld: async (r: UnheldRun) => {
        calls++;
        await r.put("box-ids.internal/pending/life-1-1.json", "{}").catch((e: unknown) => void (caught = e));
      },
    });
    await assert.rejects(place.start({ gen: 1, env: {}, stdin: await place.token!(1) }), startFails("WINDOW_CLOSED"));
    assert.equal(runFileCode(caught), "WINDOW_CLOSED");
    assert.equal((caught as { cause?: unknown }).cause, closed, "the server's answer is its cause");
    assert.equal(starts.length, 0, "no box");
    assert.ok(!control.ops.some((o) => o.startsWith("start ")), "host.start was never called");
    assert.equal(control.users.size, 0, "the token it minted is removed");
    assert.equal(calls, 1, "nothing is retried in that start");
  });

  it("any other put failure (a 409 with another code, a 503) is CONTROL_API_FAILED with its cause; a hook that rethrows it fails the start CONTROL_API_FAILED, and no box", async () => {
    for (const error of [Object.assign(new Error("409 Conflict"), { status: 409, code: "Conflict" }), Object.assign(new Error("503 SlowDown"), { status: 503, code: "SlowDown" })]) {
      const control = new FakeControl();
      const { host, starts } = fakeHost(control);
      control.putFaultUnder = { prefix: `${run}box-ids.internal/`, error };
      let seen: unknown;
      const place = makePlace({
        ...REF, control, host, ensure: OWNER,
        unheld: async (r: UnheldRun) => {
          await r.put("box-ids.internal/x.json", "{}").catch((e: unknown) => {
            seen = e;
            throw e;
          });
        },
      });
      await assert.rejects(place.start({ gen: 1, env: {}, stdin: await place.token!(1) }), startFails("CONTROL_API_FAILED"));
      assert.equal(runFileCode(seen), "CONTROL_API_FAILED", error.message);
      assert.equal((seen as { cause?: unknown }).cause, error);
      assert.equal(starts.length, 0);
    }
  });

  it("a hook that throws anything else, or overruns its bound, fails the start UNHELD_FAILED with no box; at the bound its signal aborts and a later put is WINDOW_CLOSED with no request", async () => {
    const c1 = new FakeControl();
    const h1 = fakeHost(c1);
    const boom = new Error("the labeller broke");
    const p1 = makePlace({ ...REF, control: c1, host: h1.host, ensure: OWNER, unheld: async () => { throw boom; } });
    await assert.rejects(p1.start({ gen: 1, env: {}, stdin: await p1.token!(1) }), (e: unknown) => startFails("UNHELD_FAILED")(e) && ((e as { cause: PlaceError }).cause.cause === boom));
    assert.equal(h1.starts.length, 0);

    const c2 = new FakeControl();
    const h2 = fakeHost(c2);
    let kept: UnheldRun | undefined;
    const p2 = makePlace({ ...REF, control: c2, host: h2.host, ensure: OWNER, unheldTimeoutMs: 50, unheld: (r: UnheldRun) => { kept = r; return new Promise<void>(() => {}); } });
    const t0 = Date.now();
    await assert.rejects(p2.start({ gen: 1, env: {}, stdin: await p2.token!(1) }), startFails("UNHELD_FAILED", /50 ms/));
    assert.ok(Date.now() - t0 < 5_000, "the bound ends the wait");
    assert.ok(kept!.signal.aborted, "the hook's signal aborts at its bound");
    const before = c2.allPuts.length;
    await assert.rejects(kept!.put("box-ids.internal/late.json", "{}"), (e: unknown) => runFileCode(e) === "WINDOW_CLOSED");
    assert.equal(c2.allPuts.length, before, "no request after the window");
    assert.equal(h2.starts.length, 0);
  });

  it("the returned environment: a name the start already sets, a name that is not a variable name, a value that is not a string or holds a NUL, or a key-shaped name fails the start INVALID_ARGUMENT, naming the variable and never its value; anything else passes", async () => {
    const VALUE = `v-${"q".repeat(16)}`;
    const refused: Record<string, unknown>[] = [
      { PATH: VALUE }, { PDA_HOLDER: VALUE }, { HOST_BOX: VALUE }, { RUN_LABEL: VALUE }, { "1BAD": VALUE }, { "A-B": VALUE }, { NUMBER: 7 }, { NUL: "a\0b" },
      { ANTHROPIC_API_KEY: VALUE }, { MODAL_TOKEN_ID: VALUE }, { MODAL_TOKEN_SECRET: VALUE }, { DB_PASSWORD: VALUE }, { GH_TOKEN: VALUE }, { db_passwd: VALUE },
      { X_Credentials: VALUE }, { CREDENTIAL: VALUE }, { CACHE_KEY_PREFIX: VALUE },
    ];
    for (const env of refused) {
      const name = Object.keys(env)[0]!;
      const control = new FakeControl();
      const { host, starts } = providing(control);
      const place = makePlace({ ...REF, control, host, ensure: OWNER, unheld: async () => env as Record<string, string> });
      await assert.rejects(place.start({ gen: 1, env: LIFE, stdin: await place.token!(1) }), (e: unknown) => {
        assert.ok(startFails("INVALID_ARGUMENT")(e), `${name}: ${String(e)}`);
        const message = (e as { cause: Error }).cause.message;
        assert.ok(message.includes(name), `${name}: the message names the variable`);
        assert.ok(!message.includes(VALUE) && !String(e).includes(VALUE), `${name}: never its value`);
        return true;
      });
      assert.equal(starts.length, 0, `${name}: no box`);
    }
    const control = new FakeControl();
    const { host, starts } = providing(control);
    const passing = { KEYBOARD: "us", TOKENIZER: "bpe", MONKEY: "1", SECRETARY: "ok", LABEL_HINT: "x" };
    const place = makePlace({ ...REF, control, host, ensure: OWNER, unheld: async () => passing });
    await place.start({ gen: 1, env: LIFE, stdin: await place.token!(1) });
    for (const [k, v] of Object.entries(passing)) assert.equal(starts[0]!.attempt!.env![k], v, k);
    for (const odd of [null, [], "HOST=1"]) {
      const c = new FakeControl();
      const p = makePlace({ ...REF, control: c, host: fakeHost(c).host, ensure: OWNER, unheld: async () => odd as unknown as Record<string, string> });
      await assert.rejects(p.start({ gen: 1, env: {}, stdin: await p.token!(1) }), startFails("INVALID_ARGUMENT"), JSON.stringify(odd));
    }
  });

  it("archilPlace({ unheld }) without ensure.create, with a control that cannot list, or with a bound that is not a positive number is INVALID_ARGUMENT at once", () => {
    const control = new FakeControl();
    const host = fakeHost(control).host;
    const hook = async () => {};
    const invalid = (re: RegExp) => (e: unknown) => e instanceof PlaceError && e.code === "INVALID_ARGUMENT" && re.test(e.message);
    assert.throws(() => archilPlace({ ...REF, control, host, unheld: hook }), invalid(/ensure\.create/));
    const bare = new FakeControl();
    (bare as unknown as { listObjects?: unknown }).listObjects = undefined;
    assert.throws(() => archilPlace({ ...REF, control: bare, host: fakeHost(bare).host, ensure: OWNER, unheld: hook }), invalid(/list/));
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => archilPlace({ ...REF, control, host, ensure: OWNER, unheld: hook, unheldTimeoutMs: ms }), invalid(/unheldTimeoutMs/), String(ms));
    assert.doesNotThrow(() => archilPlace({ ...REF, control: bare, host: fakeHost(bare).host }), "no hook, no checks: as before");
  });

  it("a takeover runs the hook again, and a put of a path an earlier start wrote answers EXISTS: read it back and compare", async () => {
    const control = new FakeControl();
    const answers: string[] = [];
    const path = "box-ids.internal/pending/life-1.json";
    const place = makePlace({
      ...REF, control, host: providing(control).host, ensure: OWNER,
      unheld: async (r: UnheldRun, start: UnheldStart) => {
        answers.push(await r.put(path, `{"attempt":${start.attempt}}`).then(
          () => "created",
          async (e: unknown) => (runFileCode(e) === "EXISTS" ? `exists ${new TextDecoder().decode((await r.read(path))!)}` : String(e)),
        ));
        assert.deepEqual(await r.list("box-ids.internal/pending"), ["life-1.json"]);
      },
    });
    const first = await place.start({ gen: 1, env: LIFE, stdin: await place.token!(1) });
    await place.kill(first, "box");
    await place.recover(first, "box", { gen: 2, env: LIFE, stdin: await place.token!(2) });
    assert.deepEqual(answers, ["created", 'exists {"attempt":1}']);
  });

  it("two supervisor lives in one window (a barrier holds both past the start-mark read before either writes it): put is NOT exclusive, so both puts of one name succeed; names unique to each start are both kept, neither overwritten", async () => {
    const control = new FakeControl();
    const barrier = (n: number) => {
      let arrived = 0;
      let open!: () => void;
      const all = new Promise<void>((r) => (open = r));
      return () => (++arrived >= n && open(), all);
    };
    const marks = barrier(2);
    let markReads = 0;
    control.onGet = (key) => (key === `${run}start.json` && markReads++ < 2 ? marks() : undefined);
    const SAME = "box-ids.internal/pending/same.json";
    const heads = barrier(2);
    let sameHeads = 0;
    control.onHead = (key) => (key === `${run}${SAME}` && sameHeads++ < 2 ? heads() : undefined);
    const results: Record<string, string> = {};
    const life = (name: string) => {
      const place = makePlace({
        ...REF, control, host: providing(control).host, ensure: OWNER,
        unheld: async (r: UnheldRun, start: UnheldStart) => {
          results[`${name} same`] = await r.put(SAME, `{"life":"${name}"}`).then(() => "written", runFileCode);
          results[`${name} own`] = await r.put(`box-ids.internal/pending/${name}-${start.attempt}.json`, `{"life":"${name}"}`).then(() => "written", runFileCode);
        },
      });
      return { place, name };
    };
    const lives = [life("life-a"), life("life-b")];
    const tokens = await Promise.all(lives.map((l) => l.place.token!(1)));
    await Promise.all(lives.map((l, i) => l.place.start({ gen: 1, env: { RUN_LABEL: l.name }, stdin: tokens[i] }).catch((e: unknown) => e)));
    assert.equal(markReads >= 2, true, "both lives read the start mark before either wrote it");
    assert.deepEqual(results, { "life-a same": "written", "life-a own": "written", "life-b same": "written", "life-b own": "written" }, "check-then-write: both puts of one name succeed (not exclusive, as the contract says)");
    assert.ok(['{"life":"life-a"}', '{"life":"life-b"}'].includes(control.objects.get(`${run}${SAME}`)!), "that name holds the last writer's body");
    assert.equal(control.objects.get(`${run}box-ids.internal/pending/life-a-1.json`), '{"life":"life-a"}', "unique names: neither overwritten");
    assert.equal(control.objects.get(`${run}box-ids.internal/pending/life-b-1.json`), '{"life":"life-b"}');
  });
});

describe("archilPlace: an adopted start keeps the key its box already has (a fix to #974's HOST_BOX keys)", () => {
  /** A driver keyed on the attempt, as localHost's unit and Daytona's label are: the same attempt again finds its own box. */
  const adopting = (control: FakeControl) => {
    const byAttempt = new Map<number, string>();
    const states = new Map<string, HostStatus>();
    let n = 0;
    const host: HostDriver & { mountRoot: string } = {
      mountRoot: "/mnt/fake",
      provider: "modal",
      async start(_ref, _token, attempt): Promise<HostHandle> {
        const a = attempt!.attempt;
        control.ops.push(`start g${a}`);
        control.delegations = [{ clientId: `c-${a}-${n}`, inodeId: 7, path: `runs/${ID}`, isPending: false, isOrphaned: false }];
        const had = byAttempt.get(a);
        // Its instance never writes run.json, so a takeover starts the same attempt again.
        if (had !== undefined) return { driver: "fake", name: had, adopted: true };
        const name = `box-${++n}`;
        byAttempt.set(a, name);
        states.set(name, "running");
        return { driver: "fake", name };
      },
      async status(h: HostHandle) {
        return states.get(String(h.name)) ?? "unknown";
      },
      async stop(h: HostHandle) {
        control.ops.push(`stop ${h.name}`);
        if (states.has(String(h.name))) states.set(String(h.name), "stopped");
      },
      kills: "process",
      async kill(h: HostHandle) {
        control.ops.push(`kill ${h.name}`);
      },
      box: (h) => ({ provider: "modal", kind: `vm ${h.name}`, from: "2026-10-22T00:00:00.000Z", to: null }),
    };
    return host;
  };

  it("a box the place already started, adopted again on a repeated attempt, is one entry in status().boxes, never a second key, and is stopped once at release", async () => {
    const control = new FakeControl();
    const place = archilPlace({ ...REF, control, host: adopting(control), pollMs: 5 })({ paths: pathsAt("/x") });
    let released = false;
    try {
      const first = await place.start({ gen: 1, env: { RUN_LABEL: "life-1" }, stdin: await place.token!(1) });
      await place.kill(first, "process");
      const again = await place.recover(first, "process", { gen: 2, env: { RUN_LABEL: "life-1" }, stdin: await place.token!(2) });
      assert.ok(again.runner, "the takeover adopted its own box");
      assert.deepEqual(control.ops.filter((o) => o.startsWith("start ")), ["start g1", "start g1"], "the same attempt, started twice");
      const boxes = (await place.status!()).boxes!;
      assert.deepEqual(boxes.map((b) => b.kind), ["vm box-1"], "one box, one key: the key its runner claimed");
      released = true;
      await place.release();
      assert.deepEqual(control.ops.filter((o) => o.startsWith("stop ")), ["stop box-1"], "stopped once");
    } finally {
      if (!released) await place.release().catch(() => {});
    }
  });
});

describe("a place's run files (readRunFile, listRunFiles): its own run, read only", () => {
  const bytes = (t: string) => new TextEncoder().encode(t);
  const code = (c: string) => (e: unknown) => e instanceof RunFileError && e.code === c;

  it("archilPlace reads over its control: a file's bytes, null only for a missing file, [] for a directory not there yet; every other failure throws; nothing is written", async () => {
    const control = new FakeControl();
    const place = makePlace({ ...REF, control, host: fakeHost(control).host });
    const run = `runs/${ID}/`;
    control.objects.set(run, "");
    control.objects.set(`${run}box-ids.internal/`, "");
    control.objects.set(`${run}box-ids.internal/box-2.json`, '{"owner":"place"}');
    control.objects.set(`${run}box-ids.internal/box-10.json`, '{"owner":"tools"}');
    control.objects.set(`${run}link.json`, "");
    control.failUnder = { prefix: `${run}link.json`, error: Object.assign(new Error("501 NotImplemented"), { status: 501, code: "NotImplemented" }) };
    const before = JSON.stringify([...control.objects]);
    const puts = control.puts.length;
    assert.deepEqual(await place.readRunFile!("box-ids.internal/box-2.json"), bytes('{"owner":"place"}'));
    assert.equal(await place.readRunFile!("box-ids.internal/box-3.json"), null, "missing: null, read again later");
    assert.deepEqual(await place.listRunFiles!("box-ids.internal"), ["box-10.json", "box-2.json"]);
    assert.deepEqual(await place.listRunFiles!("not-made-yet"), [], "a directory not there yet is not an error");
    await assert.rejects(place.readRunFile!("link.json"), code("NOT_A_FILE"), "a symlink (S3 answers 501)");
    await assert.rejects(place.readRunFile!("../other/run.json"), code("INVALID_PATH"));
    control.objects.delete(run);
    control.objects.delete(`${run}box-ids.internal/`);
    control.objects.delete(`${run}box-ids.internal/box-2.json`);
    control.objects.delete(`${run}box-ids.internal/box-10.json`);
    await assert.rejects(place.readRunFile!("box-ids.internal/box-2.json"), code("RUN_MISSING"));
    await assert.rejects(place.listRunFiles!("box-ids.internal"), code("RUN_MISSING"));
    control.objects.set(run, "");
    control.failUnder = { prefix: `${run}box-ids.internal/box-4.json`, error: Object.assign(new Error("503"), { status: 503 }) };
    await assert.rejects(place.readRunFile!("box-ids.internal/box-4.json"), code("CONTROL_API_FAILED"));
    assert.equal(control.puts.length, puts, "no put");
    assert.equal(JSON.stringify([...control.objects].filter(([k]) => k !== run)), JSON.stringify(JSON.parse(before).filter(([k]: [string]) => ![run, `${run}box-ids.internal/`, `${run}box-ids.internal/box-2.json`, `${run}box-ids.internal/box-10.json`].includes(k))), "the reads changed nothing");
  });

  it("localPlace reads its run directory: a file's bytes, null only for a missing file, sorted names, [] for a directory not there yet; a directory or a symlink is NOT_A_FILE, never followed; unsafe paths are refused", async () => {
    const root = scratch();
    mkdirSync(join(root, "box-ids.internal", "sub"), { recursive: true });
    writeFileSync(join(root, "box-ids.internal", "box-2.json"), '{"owner":"place"}');
    writeFileSync(join(root, "box-ids.internal", "box-10.json"), "");
    const outside = join(dirname(root), "outside.json");
    writeFileSync(outside, "SECRET-OUTSIDE");
    symlinkSync(outside, join(root, "box-ids.internal", "link.json"));
    symlinkSync(dirname(root), join(root, "up"));
    const place = localPlace({ app: "app.ts" })({ paths: pathsAt(root) });
    assert.deepEqual(await place.readRunFile!("box-ids.internal/box-2.json"), bytes('{"owner":"place"}'));
    const empty = await place.readRunFile!("box-ids.internal/box-10.json");
    assert.ok(empty instanceof Uint8Array && empty.length === 0, "a real empty file is an empty array");
    assert.equal(await place.readRunFile!("box-ids.internal/box-3.json"), null);
    assert.equal(await place.readRunFile!("not-made/box-1.json"), null, "under a directory not there yet: missing");
    assert.deepEqual(await place.listRunFiles!("box-ids.internal"), ["box-10.json", "box-2.json", "link.json", "sub"]);
    assert.deepEqual(await place.listRunFiles!(""), ["box-ids.internal", "up"]);
    assert.deepEqual(await place.listRunFiles!("not-made-yet"), []);
    await assert.rejects(place.readRunFile!("box-ids.internal/link.json"), code("NOT_A_FILE"), "a symlink is never followed");
    await assert.rejects(place.readRunFile!("up/outside.json"), code("NOT_A_FILE"), "nor a symlinked directory on the way");
    await assert.rejects(place.listRunFiles!("up"), code("NOT_A_FILE"));
    await assert.rejects(place.readRunFile!("box-ids.internal/sub"), code("NOT_A_FILE"), "a directory");
    for (const bad of ["", "/etc/passwd", "../outside.json", "a/../b", "bad name"]) await assert.rejects(place.readRunFile!(bad), code("INVALID_PATH"), JSON.stringify(bad));
    const gone = localPlace({ app: "app.ts" })({ paths: pathsAt(join(dirname(root), "no-such-run")) });
    await assert.rejects(gone.readRunFile!("run.json"), code("RUN_MISSING"));
    await assert.rejects(gone.listRunFiles!(""), code("RUN_MISSING"));
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
    // The heap after `polls` more polls, every collectable thing collected: a GC, a turn for what it freed to settle, and
    // a GC again.
    const heapAfter = async (polls: number) => {
      const until = control.gets + polls;
      while (control.gets < until) await sleep(50);
      for (let i = 0; i < 3; i++) {
        gc();
        await new Promise((resolve) => setImmediate(resolve));
      }
      return process.memoryUsage().heapUsed;
    };
    // What the test guards against (each wait raced against one promise that lives as long as the iterator) keeps about
    // 1.2 KB a poll, so it grows every window by megabytes. One sample against an absolute bound could not tell that from
    // a run's noise: a CI leg once read 1.01 MB over 3000 polls with nothing retained. So, after a warm-up (the JIT and the
    // lazily compiled paths settle first), two windows, and the smaller one's growth must stay under 400 bytes a poll: a
    // leak grows both, a one-off allocation lands in one.
    const WINDOW = 2_500;
    const BOUND = 400 * WINDOW;
    const warm = await heapAfter(1_000);
    const first = await heapAfter(WINDOW);
    const second = await heapAfter(WINDOW);
    await it.return!();
    assert.deepEqual(await pending, { done: true, value: undefined });
    const grew = [first - warm, second - first];
    assert.ok(Math.min(...grew) < BOUND, `the heap grew ${grew.join(" and ")} bytes over two windows of ${WINDOW} polls (bound ${BOUND} each)`);
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

  it("status lists a receipt for each box the place started, a killed or released one with its end; a driver that makes no boxes gives none, nor does localPlace", async () => {
    const control = new FakeControl();
    const { host } = fakeHost(control);
    const receipts = new Map<string, HostBox>();
    const receipt = (n: number, to: string | null): HostBox => ({ provider: "daytona", kind: "sandbox 1 vCPU, 1 GiB memory, 3 GiB disk", from: `2026-10-16T09:0${n}:00.000Z`, to, usdPerSecond: 0.0000185, source: "https://www.daytona.io/pricing", priced: "2026-10-16" });
    (host as HostDriver).box = (h) => receipts.get(String(h.name)) ?? null;
    const at = makePlace({ ...REF, control, host });
    const first = await at.start({ gen: 1, env: {}, stdin: await at.token!(1) });
    receipts.set("box-1", receipt(1, null));
    assert.deepEqual((await at.status!()).boxes, [receipt(1, null)]);
    await at.kill(first, "box");
    receipts.set("box-1", receipt(1, "2026-10-16T09:01:30.000Z"));
    await at.recover(first, "box", { gen: 2, env: {}, stdin: await at.token!(2) });
    receipts.set("box-2", receipt(2, null));
    assert.deepEqual((await at.status!()).boxes, [receipt(1, "2026-10-16T09:01:30.000Z"), receipt(2, null)], "the killed box with its end, the new one live");
    await at.release();
    receipts.set("box-2", receipt(2, "2026-10-16T09:03:00.000Z"));
    assert.deepEqual((await at.status!()).boxes?.map((b) => b.to), ["2026-10-16T09:01:30.000Z", "2026-10-16T09:03:00.000Z"], "released boxes stay listed");

    const c2 = new FakeControl();
    const plain = makePlace({ ...REF, control: c2, host: fakeHost(c2).host });
    await plain.start({ gen: 1, env: {}, stdin: await plain.token!(1) });
    assert.ok(!("boxes" in (await plain.status!())), "a driver that makes no boxes: no receipts");
    await plain.release();
    assert.ok(!("boxes" in (await localPlace({ app: APP })({ paths: pathsAt(scratch()) }).status!())), "localPlace reports none");
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
