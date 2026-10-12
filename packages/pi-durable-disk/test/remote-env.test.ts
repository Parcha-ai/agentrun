import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { chmodSync, statSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { ArtifactSync, installPiRun, modalGpuBoxes, PI_RUN, RemoteEnv, remoteEnvs, type ModalGpuSdk, type RemoteBox, type RemoteProcess } from "../src/remote-env.ts";
import { registerEnvCases } from "./_env-conformance.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * A pi-run test's command: its shell writes its own pid to `${dir}/${tag}-${name}.pid` once pi-run has started it (so pi-run has
 * taken its key), then runs `body`. The tag stays in its arguments, for `leftover`.
 */
const command = (dir: string, tag: string, name: string, body: string) => `sh -c 'echo $$ > ${dir}/${tag}-${name}.pid; ${body}' ${tag}-${name}`;
/**
 * Whether the command `name` has started and is still alive (not a zombie), by the pid it wrote itself: a match on its
 * arguments would also find RemoteEnv's wrapper, which carries them before pi-run starts the command.
 */
function alive(dir: string, tag: string, name: string): boolean {
  let pid: string;
  try {
    pid = readFileSync(join(dir, `${tag}-${name}.pid`), "utf8").trim();
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}
/**
 * pi-run as a test runs it: with its records in the test's own directory (PI_RUN_DIR), so suites running at once on one host
 * (parallel worktrees, two lanes) never stop each other's runs of the same key through a shared /tmp/.pi-run.
 */
const piRunIn = (root: string, piRun: string, records = join(root, "pi-run-records")) => `PI_RUN_DIR=${records} ${piRun}`;
/** Whether anything tagged `${tag}-${name}` is left on this host: its wrapper, pi-run or its command. */
const leftover = (tag: string, name: string) => spawnSync("pgrep", ["-f", `${tag}-${name}`]).stdout.toString().trim() !== "";
/** The index of the first of `promises` to settle, or -1 after `ms`; the deadline's timer is cleared either way. */
async function firstSettled(promises: Promise<unknown>[], ms: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<number>((resolve) => (timer = setTimeout(() => resolve(-1), ms)));
  try {
    return await Promise.race([...promises.map((p, i) => p.then(() => i)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
/** A rerun of a key stops the previous run of that key (its whole process group) and leaves another key's run alone. */
async function rerunStopsOnlyItsKey(box: RemoteBox, root: string): Promise<void> {
  const bin = join(root, "bin", "pi-run");
  await installPiRun(box, bin);
  const piRun = piRunIn(root, bin);
  const env = new RemoteEnv({ box, root });
  const tag = `pda-pirun-${process.pid}-${Date.now()}`;
  const first = env.exec(`${piRun} walk -- ${command(root, tag, "walk", "sleep 30 & sleep 30; wait")}`, {}, context);
  const other = env.exec(`${piRun} spin -- ${command(root, tag, "spin", "sleep 30")}`, {}, context);
  await waitFor(() => alive(root, tag, "walk") && alive(root, tag, "spin"), 20_000, "both runs to start");
  const second = await env.exec(`${piRun} walk -- echo second`, {}, context);
  assert.equal(second.ok && second.value.exitCode, 0);
  const r1 = await first;
  assert.ok(r1.ok && r1.value.exitCode !== 0, "the first run was stopped");
  await waitFor(() => !leftover(tag, "walk"), 20_000, "nothing of the first run to be left");
  assert.equal(alive(root, tag, "spin"), true, "the other key still runs");
  await env.exec(`${piRun} spin -- true`, {}, context);
  await other;
}

/**
 * Two pi-run starts of one key at once leave exactly one running. Events, not a clock: the start that takes the lock second
 * stops the other's process group (polling every 0.5 s) and only then starts its own command, which on a loaded host can be
 * seconds after both began. The stopped start is the one whose exec returns; then the other's command comes up, and the
 * stopped one stays down. `keys` also checks that keys differing only in punctuation stay apart.
 */
async function twoStartsLeaveOne(box: RemoteBox, root: string, keys: boolean): Promise<void> {
  const bin = join(root, "bin", "pi-run");
  await installPiRun(box, bin);
  const piRun = piRunIn(root, bin);
  const env = new RemoteEnv({ box, root });
  const tag = `pda-pirun2-${process.pid}-${Date.now()}`;
  const runs = [env.exec(`${piRun} k -- ${command(root, tag, "a", "sleep 30")}`, {}, context), env.exec(`${piRun} k -- ${command(root, tag, "b", "sleep 30")}`, {}, context)];
  const stopped = await firstSettled(runs, 20_000);
  assert.notEqual(stopped, -1, "one start of k stopped the other within 20 s");
  const [loser, winner] = stopped === 0 ? ["a", "b"] : ["b", "a"];
  await waitFor(() => alive(root, tag, winner), 20_000, `the run of k that stopped the other (${winner})`);
  assert.equal(alive(root, tag, loser), false, "exactly one run of k");
  if (keys) {
    const colon = env.exec(`${piRun} walk:a -- ${command(root, tag, "colon", "sleep 30")}`, {}, context);
    await waitFor(() => alive(root, tag, "colon"), 20_000, "the run of walk:a"); // its pid is written once walk:a is its key
    await env.exec(`${piRun} walk/a -- true`, {}, context);
    assert.equal(alive(root, tag, "colon"), true, "walk/a did not stop walk:a");
    await env.exec(`${piRun} walk:a -- true`, {}, context);
    await colon;
  }
  await env.exec(`${piRun} k -- true`, {}, context);
  await Promise.all(runs);
}

/** Poll until `condition` holds, or fail naming `what` after `ms`. */
async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/**
 * A box that runs the env's own fixed scripts as local processes: the shell semantics are real, the transport is a pipe.
 * `end(code)` makes it a box that has ended (poll reports the code, exec fails); `hang()` one that stops answering.
 */
function localBox(id = "sb-local") {
  let ended: number | null = null, hanging = false;
  const calls: string[][] = [];
  const box: RemoteBox & { end(code: number): void; hang(): void; calls: string[][] } = {
    sandboxId: id,
    calls,
    async exec(command: string[]): Promise<RemoteProcess> {
      calls.push(command);
      if (hanging) return new Promise(() => {});
      if (ended !== null) throw Object.assign(new Error(`Sandbox ${id} has already shut down`), { name: "InvalidError" });
      const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
      const exited = new Promise<number>((resolve) => child.on("close", (code, signal) => resolve(code ?? (signal ? 128 + 9 : 1))));
      child.stdin.on("error", () => {});
      return {
        stdin: { writeBytes: async (b) => { await new Promise<void>((r, j) => child.stdin.write(b, (e) => (e ? j(e) : r()))); }, close: async () => { child.stdin.end(); } },
        stdout: child.stdout,
        stderr: child.stderr,
        wait: () => exited,
      };
    },
    async poll() {
      if (hanging) return new Promise(() => {});
      return ended;
    },
    end(code) { ended = code; },
    hang() { hanging = true; },
  };
  return box;
}

async function withRoot<T>(use: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pda-remote-"));
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("RemoteEnv: pi's environment conformance over a box's exec", () => {
  registerEnvCases("remoteEnv", (use) => withRoot((root) => use(new RemoteEnv({ box: localBox(), root, watchIntervalMs: 200 }))));
});

describe("RemoteEnv: a box that goes away is a tool error, never a hang", () => {
  it("a box that ended: the call fails with the reason, and every later call fails at once without asking the box", async () => {
    await withRoot(async (root) => {
      const box = localBox("sb-gone");
      const env = new RemoteEnv({ box, root });
      assert.equal((await env.writeFile("a.txt", "hi", context)).ok, true);
      box.end(137);
      const read = await env.readTextFile("a.txt", context);
      assert.equal(read.ok, false);
      assert.match(!read.ok ? read.error.message : "", /the box sb-gone is gone \(it ended with exit code 137\)/);
      const before = box.calls.length;
      const run = await env.exec("echo hi", {}, context);
      assert.equal(run.ok, false);
      assert.match(!run.ok ? run.error.message : "", /is gone/);
      assert.equal(box.calls.length, before, "a lost box is not asked again");
      assert.deepEqual(env.state(), { lost: "it ended with exit code 137" });
    });
  });

  it("a box that stops answering: the call returns within its deadline, and the box counts as lost", async () => {
    await withRoot(async (root) => {
      const box = localBox("sb-hang");
      const env = new RemoteEnv({ box, root, opTimeoutMs: 300, pollTimeoutMs: 200 });
      box.hang();
      const t0 = Date.now();
      const read = await env.readTextFile("a.txt", context);
      assert.ok(Date.now() - t0 < 2_000, `returned after ${Date.now() - t0} ms`);
      assert.match(!read.ok ? read.error.message : "", /did not answer a liveness check in 200 ms/);
      const run = await env.exec(["true"], {}, context);
      assert.match(!run.ok ? run.error.message : "", /is gone/);
    });
  });

  it("a slow call on a live box is a timeout, not a lost box", async () => {
    await withRoot(async (root) => {
      const env = new RemoteEnv({ box: localBox(), root });
      const r = await env.exec("sleep 5", { timeout: 0.5 }, context);
      assert.equal(!r.ok && r.error.code, "timeout");
      assert.equal(env.state(), "live");
      assert.equal((await env.exec("true", {}, context)).ok, true);
    });
  });

  it("an abort kills the command's whole process group on the box", async () => {
    await withRoot(async (root) => {
      const env = new RemoteEnv({ box: localBox(), root });
      const ac = new AbortController();
      const marker = `pda-remote-abort-${process.pid}-${Date.now()}`;
      const pending = env.exec(`sleep 30 & sleep 30 # ${marker}\nwait`, {}, withAbortSignal(ac.signal, context));
      await sleep(500);
      ac.abort();
      const r = await pending;
      assert.equal(!r.ok && r.error.code, "aborted");
      await sleep(1_500);
      const left = spawnSync("pgrep", ["-f", marker]).stdout.toString().trim();
      assert.equal(left, "", "no process of the command is left");
    });
  });
});

describe("ArtifactSync: a thread's checkpoints come home whole", () => {
  it("copies files once they are stable, in modification order, each renamed into place; flush takes the rest", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box", "skills", "walk"), local = join(root, "work", "skills", "walk");
      await mkdir(join(remote, "ckpt"), { recursive: true });
      const landed: string[] = [];
      // the test acts between passes, not on a guess at their timing: `before` runs as a listing starts, before its find, and
      // passes never overlap, so the pass before it (its copies too) is done and nothing changes while a pass looks
      const inner = localBox();
      let before: (() => Promise<void>) | undefined;
      const box: RemoteBox = {
        sandboxId: inner.sandboxId,
        poll: () => inner.poll(),
        async exec(c, o) {
          if (String(c[2] ?? "").includes('find . "$@"')) await before?.();
          return inner.exec(c, o);
        },
      };
      const sync = new ArtifactSync({ box, remote, local, intervalMs: 150, onFile: (rel) => landed.push(rel) });
      await writeFile(join(remote, "ckpt", "0001.npz"), "first");
      await sleep(20);
      await writeFile(join(remote, "ckpt", "0002.npz"), "second");
      await writeFile(join(remote, "progress.tmp"), "skipped: a temporary file");
      let release: (() => void) | undefined;
      let totals: { files: number; bytes: number };
      try {
        sync.start();
        for (const deadline = Date.now() + 10_000; landed.length < 2 && Date.now() < deadline;) await sleep(20);
        assert.deepEqual(landed, ["ckpt/0001.npz", "ckpt/0002.npz"]);
        assert.equal(readFileSync(join(local, "ckpt", "0002.npz"), "utf8"), "second");
        // a file still growing is not taken until it stops changing: it changes before each of five listings, so no two in a
        // row see it the same. The sixth is held before its find while the test looks; flush then takes the file as it is
        const watched = new Promise<void>((held) => {
          let writes = 0;
          before = async () => {
            if (writes < 5) { await (writes++ === 0 ? writeFile(join(remote, "log.txt"), "a") : appendFile(join(remote, "log.txt"), "b")); return; }
            before = undefined;
            held();
            await new Promise<void>((r) => (release = r));
          };
        });
        await watched;
        assert.equal(existsSync(join(local, "log.txt")), false, "not copied while it kept changing");
        release!();
        totals = await sync.flush();
      } finally {
        // a failed check still lets the held listing go and stops the sync, so nothing outlives the test
        before = undefined;
        release?.();
        await sync.stop();
      }
      assert.equal(readFileSync(join(local, "log.txt"), "utf8"), "abbbb");
      assert.deepEqual(totals, { files: 3, bytes: 5 + 6 + 5 });
      assert.deepEqual(readdirSync(local).filter((n) => n.endsWith(".tmp")), [], "no temporary file is left");
      assert.equal(existsSync(join(local, "progress.tmp")), false);
    });
  });

  it("a changed file is copied again; a box that goes away stops the sync with an error", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "work");
      await mkdir(remote, { recursive: true });
      const box = localBox();
      const errors: Error[] = [];
      const sync = new ArtifactSync({ box, remote, local, intervalMs: 100, onError: (e) => errors.push(e) });
      await writeFile(join(remote, "best.npz"), "v1");
      await sync.flush();
      await sleep(30);
      await writeFile(join(remote, "best.npz"), "v2!");
      await sync.flush();
      assert.equal(readFileSync(join(local, "best.npz"), "utf8"), "v2!");
      sync.start();
      box.end(1);
      await sleep(400);
      assert.equal(errors.length, 1);
      await sync.stop();
    });
  });
});

describe("ArtifactSync: flush beside the timer", () => {
  it("a flush while the timer runs copies each file once", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "work");
      await mkdir(remote, { recursive: true });
      const landed: string[] = [];
      // a box whose every call takes a while, as a real one does (each copy about 100 ms), so passes would overlap
      const fast = localBox();
      const slow: RemoteBox = { sandboxId: "sb-slow", poll: () => fast.poll(), exec: async (c, p) => { await sleep(40); return fast.exec(c, p); } };
      for (let i = 0; i < 10; i++) await writeFile(join(remote, `f${i}.json`), `${i}`);
      const sync = new ArtifactSync({ box: slow, remote, local, intervalMs: 50, onFile: (rel) => landed.push(rel) });
      sync.start();
      await sleep(160); // the timer has listed twice: its pass is copying when the flush starts
      await sync.flush();
      await sleep(300);
      await sync.stop();
      assert.equal(landed.length, 10, `copied ${landed.length} times for 10 files: ${landed.join(" ")}`);
      assert.equal(new Set(landed).size, 10);
    });
  });
});

describe("ArtifactSync: a slow pass does not crowd the listings behind it", () => {
  it("each listing starts a whole interval after the one before it ended, however late a find ran", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "work");
      await mkdir(remote, { recursive: true });
      await writeFile(join(remote, "a.json"), "a");
      // the second listing's find runs 300 ms into its pass, as a slow box runs it; a third listing on the next tick would
      // follow it within about 100 ms, and see a file still being written the same as the second did
      const intervalMs = 400;
      const fast = localBox();
      const finds: { start: number; end: number }[] = [];
      const box: RemoteBox = {
        sandboxId: "sb-late",
        poll: () => fast.poll(),
        async exec(c, o) {
          if (!String(c[2] ?? "").includes('find . "$@"')) return fast.exec(c, o);
          if (finds.length === 1) await sleep(300);
          const find = { start: Date.now(), end: Infinity };
          finds.push(find);
          const p = await fast.exec(c, o);
          const wait = p.wait;
          p.wait = async () => { const code = await wait(); find.end = Date.now(); return code; };
          return p;
        },
      };
      const sync = new ArtifactSync({ box, remote, local, intervalMs });
      try {
        sync.start();
        while (finds.length < 4) await sleep(20);
      } finally {
        await sync.stop();
      }
      // a file is taken once two listings in a row see it the same, so "in a row" has to mean an interval apart
      const gaps = finds.slice(1).map((f, i) => f.start - finds[i]!.end);
      assert.ok(gaps.every((g) => g >= intervalMs - 5), `each find started ${gaps.join(", ")} ms after the one before it ended`);
    });
  });
});

/**
 * A box whose command output is lost if nobody is reading it by the time the command has exited: Node does this to a local
 * child's stdout and stderr (it resumes an unread stream when the child exits), and a busy host can let a fast command exit
 * during any await. Here the command has always exited when exec returns, and what nobody reads is dropped on the next turn
 * of the event loop: a caller that awaits anything else before it reads loses the output, every time.
 */
function dropsUnreadOutput(inner: RemoteBox): RemoteBox {
  return {
    sandboxId: inner.sandboxId,
    poll: () => inner.poll(),
    async exec(command, options) {
      const p = await inner.exec(command, options);
      await p.stdin.close();
      const out = new PassThrough(), err = new PassThrough();
      (p.stdout as unknown as NodeJS.ReadableStream).pipe(out);
      (p.stderr as unknown as NodeJS.ReadableStream).pipe(err);
      const code = await p.wait();
      setImmediate(() => {
        for (const s of [out, err]) if (s.listenerCount("readable") + s.listenerCount("data") === 0) s.resume();
      });
      return { stdin: { writeBytes: async () => {}, close: async () => {} }, stdout: out, stderr: err, wait: async () => code } as unknown as RemoteProcess;
    },
  };
}

describe("ArtifactSync: a command's output is read from the moment it starts", () => {
  it("a copy whose command exits at once still brings its file home", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "home");
      await mkdir(join(remote, "checkpoints"), { recursive: true });
      await writeFile(join(remote, "skill.json"), "{}");
      await writeFile(join(remote, "checkpoints", "ckpt-1.json"), "c1");
      const sync = new ArtifactSync({ box: dropsUnreadOutput(localBox()), remote, local });
      const totals = await sync.flush();
      await sync.stop();
      assert.deepEqual(totals, { files: 2, bytes: 4 });
      assert.equal(readFileSync(join(local, "checkpoints", "ckpt-1.json"), "utf8"), "c1");
    });
  });
});

describe("ArtifactSync: what stays on the box", () => {
  it("excluded paths are skipped with everything below them; the rest comes home", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "work-home");
      await mkdir(join(remote, "work", "ckpt"), { recursive: true });
      await mkdir(join(remote, "checkpoints"), { recursive: true });
      await writeFile(join(remote, "work", "state.json"), "trainer state");
      await writeFile(join(remote, "work", "ckpt", "big"), "x".repeat(1000));
      await writeFile(join(remote, "checkpoints", "ckpt-1.json"), "c1");
      await writeFile(join(remote, "skill.json"), "{}");
      await writeFile(join(remote, "workbench.txt"), "not under work/");
      const sync = new ArtifactSync({ box: localBox(), remote, local, exclude: ["work", "/nothing/"] });
      const totals = await sync.flush();
      await sync.stop();
      assert.deepEqual(totals, { files: 3, bytes: 2 + 2 + 15 });
      assert.equal(existsSync(join(local, "work")), false);
      assert.equal(readFileSync(join(local, "workbench.txt"), "utf8"), "not under work/");
    });
  });
});

describe("ArtifactSync after a restart", () => {
  it("a new sync finds the files an earlier one copied (same size, the box's mtime) and copies only what is new", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "work");
      await mkdir(remote, { recursive: true });
      await writeFile(join(remote, "a.npz"), "aaa");
      await writeFile(join(remote, "b.npz"), "bbbb");
      const first = new ArtifactSync({ box: localBox(), remote, local });
      assert.deepEqual(await first.flush(), { files: 2, bytes: 7 });
      await first.stop();
      assert.ok(Math.abs(statSync(join(local, "a.npz")).mtimeMs - statSync(join(remote, "a.npz")).mtimeMs) < 2, "the copy keeps the box's mtime");
      await writeFile(join(remote, "c.npz"), "cc");
      const landed: string[] = [];
      const second = new ArtifactSync({ box: localBox(), remote, local, onFile: (rel) => landed.push(rel) });
      assert.deepEqual(await second.flush(), { files: 1, bytes: 2 });
      assert.deepEqual(landed, ["c.npz"]);
      await second.stop();
    });
  });
});

/** A Modal SDK whose sandboxes are local boxes, with tags and a list by tag. */
function fakeModal(createDelayMs = 0) {
  const boxes: (ReturnType<typeof localBox> & { tags: Record<string, string>; name: string; terminated: boolean })[] = [];
  const created: Record<string, unknown>[] = [];
  const sdk: ModalGpuSdk = {
    apps: { fromName: async () => ({ appId: "ap-1" }) },
    images: { fromRegistry: (t) => ({ t }), fromId: async (id) => ({ id }) },
    sandboxes: {
      async create(_app, _image, params) {
        created.push(params);
        if (createDelayMs) await sleep(createDelayMs);
        const b = Object.assign(localBox(`sb-${boxes.length + 1}`), { tags: {} as Record<string, string>, name: String(params.name), terminated: false });
        const box = Object.assign(b, { setTags: async (t: Record<string, string>) => { b.tags = t; }, terminate: async () => { b.terminated = true; b.end(137); } });
        boxes.push(box);
        return box;
      },
      async fromId(id) { const b = boxes.find((x) => x.sandboxId === id); if (!b) throw Object.assign(new Error("not found"), { name: "NotFoundError" }); return b as never; },
      async *list({ tags }) { for (const b of boxes) if (!b.terminated && Object.entries(tags).every(([k, v]) => b.tags[k] === v)) yield b as never; },
    },
  };
  return { sdk, boxes, created };
}

describe("modalGpuBoxes: one box per thread, found again by key", () => {
  it("ensure creates a tagged H100 box with its workspace once; a rerun adopts it; an ended box is replaced", async () => {
    await withRoot(async (tmp) => {
    const m = fakeModal();
    const ws = join(tmp, "workspace"), piRun = join(tmp, "bin", "pi-run");
    const boxes = modalGpuBoxes(m.sdk, { appName: "pda-robot", image: "im-trainer", create: { cpu: 8 }, root: ws, piRunPath: piRun });
    const a = await boxes.ensure("teach-1:walk", { run: "r1" });
    assert.equal(m.created.length, 1);
    assert.partialDeepStrictEqual(m.created[0], { gpu: "H100", cpu: 8, timeoutMs: 7_200_000 });
    assert.deepEqual(m.boxes[0]!.tags, { run: "r1", "pi-box": createHash("sha256").update("teach-1:walk").digest("hex").slice(0, 40), "pi-box-key": "teach-1:walk" });
    assert.ok(existsSync(ws) && existsSync(piRun), "the workspace is made and pi-run installed");
    const again = await boxes.ensure("teach-1:walk");
    assert.equal(again.sandboxId, a.sandboxId, "a rerun adopts the live box: no second H100");
    assert.equal(m.created.length, 1);
    assert.equal((await boxes.ensure("teach-1:spin")).sandboxId, "sb-2", "another key, another box");
    await boxes.terminate(a.sandboxId);
    assert.equal(await boxes.get(a.sandboxId), undefined, "an ended box is not handed out");
    assert.equal((await boxes.ensure("teach-1:walk")).sandboxId, "sb-3", "a box that ended is replaced");
    assert.equal(await boxes.get("sb-404"), undefined);
    });
  });
});

describe("remoteEnvs: the Harness's env for threads with boxes", () => {
  it("one env per box, kept across calls; no box means the default env", async () => {
    const a = localBox("sb-a"), b = localBox("sb-b");
    const boxes: Record<string, RemoteBox> = { c1: a, c2: b };
    const root = { id: "local" } as never;
    const env = remoteEnvs((t) => boxes[t.conversationId as unknown as string], { root: "/tmp", fallback: () => root });
    const t = (id: string) => ({ conversationId: id, read: {} }) as never;
    const e1 = await env(t("c1"), context), e1again = await env(t("c1"), context), e2 = await env(t("c2"), context);
    assert.ok(e1 && e1 === e1again && e2 && e1 !== e2);
    assert.equal(e1.id, "sb-a", "the env id is the box's id");
    assert.equal(e1.cwd, "/tmp");
    assert.equal(await env(t("c3"), context), root, "a conversation without a box gets the fallback env");
    assert.equal(await remoteEnvs(() => undefined)(t("c3"), context), undefined, "no fallback: pi's default");
  });
});

describe("pi-run: one run per key on a box", () => {
  it("a rerun of the same key stops the previous run's whole process group first; another key is left alone", async () => {
    await withRoot((root) => rerunStopsOnlyItsKey(localBox(), root));
  });

});

describe("Greptile on #209: the findings, each pinned", () => {
  it("a copy that cannot be written fails the flush (no unhandled error on the host)", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "home");
      await mkdir(remote, { recursive: true });
      await mkdir(local, { recursive: true });
      await writeFile(join(remote, "a.npz"), "a");
      chmodSync(local, 0o500);
      try {
        const sync = new ArtifactSync({ box: localBox(), remote, local });
        await assert.rejects(sync.flush(), /EACCES|permission/i);
        await sync.stop();
      } finally {
        chmodSync(local, 0o700);
      }
    });
  });

  it("a stdin close that never returns is bounded: the command times out, a flush fails in its deadline", async () => {
    await withRoot(async (root) => {
      const inner = localBox();
      const stuck: RemoteBox = { sandboxId: "sb-stuck", poll: () => inner.poll(), exec: async (c, p) => { const r = await inner.exec(c, p); return { ...r, stdin: { writeBytes: r.stdin.writeBytes, close: () => new Promise(() => {}) } }; } };
      const env = new RemoteEnv({ box: stuck, root });
      const t0 = Date.now();
      const r = await env.exec("true", { timeout: 0.5 }, context);
      assert.equal(!r.ok && r.error.code, "timeout");
      assert.ok(Date.now() - t0 < 10_000, `returned after ${Date.now() - t0} ms`);
      await mkdir(join(root, "box"), { recursive: true });
      const sync = new ArtifactSync({ box: stuck, remote: join(root, "box"), local: join(root, "home"), opTimeoutMs: 300 });
      await assert.rejects(sync.flush());
      await sync.stop();
    });
  });

  it("an abort while the box is still starting the command: the command never runs on", async () => {
    await withRoot(async (root) => {
      const inner = localBox();
      const slow: RemoteBox = { sandboxId: "sb-slowstart", poll: () => inner.poll(), exec: async (c, p) => { if (c.includes("pi-exec")) await sleep(600); return inner.exec(c, p); } };
      const env = new RemoteEnv({ box: slow, root });
      const tag = `pda-late-${process.pid}-${Date.now()}`;
      const ac = new AbortController();
      const pending = env.exec(`sleep 30 # ${tag}`, {}, withAbortSignal(ac.signal, context));
      await sleep(100);
      ac.abort();
      const r = await pending;
      assert.equal(!r.ok && r.error.code, "aborted");
      await sleep(2_500);
      assert.equal(spawnSync("pgrep", ["-f", tag]).stdout.toString().trim(), "", "the late start did not run on");
    });
  });

  it("a box adopted after a crash between its creation and its setup is set up before it is handed out", async () => {
    await withRoot(async (tmp) => {
      const m = fakeModal();
      const ws = join(tmp, "workspace"), piRun = join(tmp, "bin", "pi-run");
      const app = await m.sdk.apps.fromName("x", { createIfMissing: true });
      const half = await m.sdk.sandboxes.create(app, {}, { name: "half" });
      await half.setTags({ "pi-box": createHash("sha256").update("t:walk").digest("hex").slice(0, 40) });
      const boxes = modalGpuBoxes(m.sdk, { appName: "x", image: "im-1", root: ws, piRunPath: piRun });
      const got = await boxes.ensure("t:walk");
      assert.equal(got.sandboxId, half.sandboxId, "adopted, not a second box");
      assert.ok(existsSync(ws) && existsSync(piRun), "and set up");
    });
  });

  it("overlapping ensures of one key end on one box: in one process they share the work; across processes the losers end theirs", async () => {
    await withRoot(async (tmp) => {
      const m = fakeModal(150);
      const opts = { appName: "x", image: "im-1", root: join(tmp, "ws"), piRunPath: join(tmp, "pi-run") };
      const one = modalGpuBoxes(m.sdk, opts);
      const [a, b] = await Promise.all([one.ensure("k"), one.ensure("k")]);
      assert.equal(a.sandboxId, b.sandboxId);
      assert.equal(m.created.length, 1, "one creation for two callers");
      const m2 = fakeModal(150);
      const [x, y] = await Promise.all([modalGpuBoxes(m2.sdk, opts).ensure("k2"), modalGpuBoxes(m2.sdk, opts).ensure("k2")]);
      assert.equal(x.sandboxId, y.sandboxId, "both creators settle on the same box");
      assert.equal(m2.boxes.filter((bx) => !bx.terminated).length, 1, "the duplicate H100 is ended");
    });
  });

  it("long keys that share a prefix get their own boxes", async () => {
    await withRoot(async (tmp) => {
      const m = fakeModal();
      const boxes = modalGpuBoxes(m.sdk, { appName: "x", image: "im-1", root: join(tmp, "ws"), piRunPath: join(tmp, "pi-run") });
      const prefix = "teach-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:";
      const walk = await boxes.ensure(prefix + "walk"), spin = await boxes.ensure(prefix + "spin");
      assert.notEqual(walk.sandboxId, spin.sandboxId);
    });
  });

  it("pi-run: two starts of one key at once leave exactly one running; keys that differ only in punctuation stay apart", async () => {
    await withRoot((root) => twoStartsLeaveOne(localBox(), root, true));
  });

  it("a symbolic link to a directory lists its entries; a name that starts with a dash is listed like any other", async () => {
    await withRoot(async (root) => {
      const env = new RemoteEnv({ box: localBox(), root });
      await mkdir(join(root, "real"), { recursive: true });
      await writeFile(join(root, "real", "a.txt"), "a");
      await writeFile(join(root, "real", "-notes"), "dash");
      symlinkSync("real", join(root, "linked"));
      const list = await env.listDir("linked", context);
      assert.deepEqual(list.ok && list.value.map((e) => e.name).sort(), ["-notes", "a.txt"]);
      const reader = await env.openDirReader("linked", context);
      assert.ok(reader.ok);
      const names: string[] = [];
      for (;;) { const page = await reader.value.next(1, context); assert.ok(page.ok); names.push(...page.value.entries.map((e) => e.name)); if (page.value.done) break; }
      assert.deepEqual(names.sort(), ["-notes", "a.txt"]);
    });
  });

  it("a file that changes while it is copied is not published; the settled version is", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "home");
      await mkdir(remote, { recursive: true });
      await writeFile(join(remote, "ckpt.json"), "v1");
      const inner = localBox();
      let meddled = false;
      // the box rewrites the file right as the first copy reads it
      const meddling: RemoteBox = { sandboxId: "sb-m", poll: () => inner.poll(), exec: async (c, p) => { if (!meddled && c.join(" ").includes("cat --")) { meddled = true; await sleep(20); await appendFile(join(remote, "ckpt.json"), "-and-more"); } return inner.exec(c, p); } };
      const landed: string[] = [];
      const sync = new ArtifactSync({ box: meddling, remote, local, onFile: (rel) => landed.push(rel) });
      await sync.flush();
      assert.deepEqual(landed, [], "the changing copy was dropped");
      assert.equal(existsSync(join(local, "ckpt.json")), false);
      await sync.flush();
      assert.equal(readFileSync(join(local, "ckpt.json"), "utf8"), "v1-and-more");
      await sync.stop();
    });
  });

  it("spilled output goes to the box whole, through a file on the host, not memory", async () => {
    await withRoot(async (root) => {
      const env = new RemoteEnv({ box: localBox(), root });
      const r = await env.exec("head -c 3000000 /dev/zero | tr '\\0' 'x'; echo", { spill: { afterBytes: 1000, afterLines: 100 } }, context);
      assert.ok(r.ok && r.value.spillPath, "spilled");
      const spilled = await env.fileInfo(r.ok ? r.value.spillPath! : "", context);
      assert.equal(spilled.ok && spilled.value.size, 3_000_001);
      assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith("pi-remote-spill-")), [], "the host's temporary spill file is gone");
    });
  });
});

describe("pi-run's lock", () => {
  it("pi-run takes the key's lock before it checks and records: a holder of the lock holds it back", async () => {
    await withRoot(async (root) => {
      const box = localBox();
      const bin = join(root, "bin", "pi-run");
      await installPiRun(box, bin);
      const records = join(root, "pi-run-records");
      const piRun = piRunIn(root, bin, records);
      const env = new RemoteEnv({ box, root });
      const key = `lock-${process.pid}-${Date.now()}`;
      const k = createHash("sha256").update(key).digest("hex").slice(0, 32);
      await mkdir(records, { recursive: true });
      const holder = spawn("flock", [`${records}/${k}.lock`, "sleep", "1.5"]);
      const released = new Promise((r2) => holder.on("close", r2));
      await sleep(200);
      const t0 = Date.now();
      // the command writes when it started: it must not start while the lock is held (the end of pi-run takes the lock too)
      const r = await env.exec(`${piRun} ${key} -- sh -c 'date +%s%3N > started'`, {}, context);
      assert.equal(r.ok && r.value.exitCode, 0);
      const startedAt = Number(readFileSync(join(root, "started"), "utf8").trim());
      assert.ok(startedAt - t0 >= 1_000, `the command started ${startedAt - t0} ms in, inside the other holder's lock`);
      await released;
    });
  });
});

describe("pi-run's records (PI_RUN_DIR)", () => {
  it("two record directories keep one key apart; in one directory a rerun of the key stops the earlier run", async () => {
    await withRoot(async (root) => {
      const box = localBox();
      const bin = join(root, "bin", "pi-run");
      await installPiRun(box, bin);
      const env = new RemoteEnv({ box, root });
      const tag = `pda-pirun-dirs-${process.pid}-${Date.now()}`;
      const [inA, inB] = [piRunIn(root, bin, join(root, "records-a")), piRunIn(root, bin, join(root, "records-b"))];
      const a = env.exec(`${inA} k -- ${command(root, tag, "a", "sleep 30")}`, {}, context);
      await waitFor(() => alive(root, tag, "a"), 20_000, "the run of k with records-a");
      const b = env.exec(`${inB} k -- ${command(root, tag, "b", "sleep 30")}`, {}, context);
      await waitFor(() => alive(root, tag, "b"), 20_000, "the run of k with records-b");
      assert.equal(alive(root, tag, "a"), true, "a run of the same key with other records does not stop it");
      await env.exec(`${inA} k -- true`, {}, context); // the same records: this rerun of k stops the first
      assert.notEqual(await firstSettled([a], 20_000), -1, "the rerun with the same records stopped the first run");
      await waitFor(() => !alive(root, tag, "a"), 20_000, "the first run to be gone");
      assert.equal(alive(root, tag, "b"), true, "and left the run with other records alone");
      await env.exec(`${inB} k -- true`, {}, context);
      await b;
    });
  });
});

describe("Greptile on #209, second round", () => {
  it("output that cannot be kept for its spill file is a tool error (the command is stopped), not a crash of the host", async () => {
    await withRoot(async (root) => {
      const ro = join(root, "readonly");
      await mkdir(ro);
      chmodSync(ro, 0o500);
      const saved = process.env.TMPDIR;
      process.env.TMPDIR = ro;
      try {
        const env = new RemoteEnv({ box: localBox(), root });
        const r = await env.exec("head -c 200000 /dev/zero | tr '\\0' 'x'; sleep 30", { spill: { afterBytes: 100, afterLines: 10 } }, context);
        assert.equal(r.ok, false);
        assert.match(!r.ok ? r.error.message : "", /could not keep the command's output/);
      } finally {
        if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; // assigning undefined would store "undefined"
        chmodSync(ro, 0o700);
      }
    });
  });

  it("reinstalling pi-run on a box in use: a reader never sees an empty or partial script", async () => {
    await withRoot(async (root) => {
      const box = localBox();
      const piRun = join(root, "bin", "pi-run");
      await installPiRun(box, piRun);
      const reader = spawn("sh", ["-c", `for i in $(seq 3000); do wc -c < "$1"; done`, "sh", piRun]);
      let sizes = "";
      reader.stdout.on("data", (d) => { sizes += String(d); });
      const done = new Promise((r) => reader.on("close", r));
      for (let i = 0; i < 15; i++) await installPiRun(box, piRun);
      await done;
      const seen = new Set(sizes.trim().split("\n").map(Number));
      assert.deepEqual([...seen], [Buffer.byteLength(PI_RUN)], `sizes seen: ${[...seen].join(", ")}`);
    });
  });

  it("exclude names paths, not patterns: work[1] stays, work1 comes home", async () => {
    await withRoot(async (root) => {
      const remote = join(root, "box"), local = join(root, "home");
      await mkdir(join(remote, "work[1]"), { recursive: true });
      await mkdir(join(remote, "work1"), { recursive: true });
      await writeFile(join(remote, "work[1]", "state"), "s");
      await writeFile(join(remote, "work1", "policy.json"), "p");
      const sync = new ArtifactSync({ box: localBox(), remote, local, exclude: ["work[1]"] });
      await sync.flush();
      await sync.stop();
      assert.equal(existsSync(join(local, "work[1]")), false);
      assert.equal(readFileSync(join(local, "work1", "policy.json"), "utf8"), "p");
    });
  });
});
