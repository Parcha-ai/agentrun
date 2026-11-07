// Places: localPlace runs the real CLI on a directory (a kill, then a resume with the next order). No disk, no network.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localPlace, PlaceError } from "../src/place.ts";
import { RunFileError } from "../src/run-files.ts";
import { processTable, thisBoot } from "../src/process-table.ts";
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
    const mark = { pid: command.pid!, start: processTable().snapshot().info(command.pid!)!.start };
    after(() => void (alive(mark.pid) && processTable().snapshot().info(mark.pid)?.start === mark.start && process.kill(mark.pid, "SIGKILL")));
    mkdirSync(join(root2, "commands"), { recursive: true });
    writeFileSync(join(root2, "commands", `${mark.pid}-${mark.start}.json`), JSON.stringify({ boot: thisBoot(), leader: mark, members: [] }));
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
    const mark = { pid: command.pid!, start: processTable().snapshot().info(command.pid!)!.start };
    after(() => void (alive(mark.pid) && processTable().snapshot().info(mark.pid)?.start === mark.start && process.kill(mark.pid, "SIGKILL")));
    writeFileSync(join(root, "commands", `${mark.pid}-${mark.start}.json`), JSON.stringify({ boot: thisBoot(), leader: mark, members: [] }));

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

describe("a place's run files (readRunFile, listRunFiles): its own run, read only", () => {
  const bytes = (t: string) => new TextEncoder().encode(t);
  const code = (c: string) => (e: unknown) => e instanceof RunFileError && e.code === c;

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
