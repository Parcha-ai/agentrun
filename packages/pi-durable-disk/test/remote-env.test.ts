import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { statSync } from "node:fs";
import { ArtifactSync, installPiRun, modalGpuBoxes, RemoteEnv, remoteEnvs, type ModalGpuSdk, type RemoteBox, type RemoteProcess } from "../src/remote-env.ts";
import { registerEnvCases } from "./_env-conformance.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      const sync = new ArtifactSync({ box: localBox(), remote, local, intervalMs: 150, onFile: (rel) => landed.push(rel) });
      await writeFile(join(remote, "ckpt", "0001.npz"), "first");
      await sleep(20);
      await writeFile(join(remote, "ckpt", "0002.npz"), "second");
      await writeFile(join(remote, "progress.tmp"), "skipped: a temporary file");
      sync.start();
      await sleep(700);
      assert.deepEqual(landed, ["ckpt/0001.npz", "ckpt/0002.npz"]);
      assert.equal(readFileSync(join(local, "ckpt", "0002.npz"), "utf8"), "second");
      // a file still growing is not taken until it stops changing; flush takes it as it is
      await writeFile(join(remote, "log.txt"), "a");
      for (let i = 0; i < 4; i++) { await appendFile(join(remote, "log.txt"), "b"); await sleep(120); }
      assert.equal(existsSync(join(local, "log.txt")), false, "not copied while it kept changing");
      const totals = await sync.flush();
      await sync.stop();
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
function fakeModal() {
  const boxes: (ReturnType<typeof localBox> & { tags: Record<string, string>; name: string; terminated: boolean })[] = [];
  const created: Record<string, unknown>[] = [];
  const sdk: ModalGpuSdk = {
    apps: { fromName: async () => ({ appId: "ap-1" }) },
    images: { fromRegistry: (t) => ({ t }), fromId: async (id) => ({ id }) },
    sandboxes: {
      async create(_app, _image, params) {
        created.push(params);
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
    assert.deepEqual(m.boxes[0]!.tags, { run: "r1", "pi-box": "teach-1:walk" });
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
    await withRoot(async (root) => {
      const box = localBox();
      const piRun = join(root, "bin", "pi-run");
      await installPiRun(box, piRun);
      const env = new RemoteEnv({ box, root });
      const tag = `pda-pirun-${process.pid}-${Date.now()}`;
      const first = env.exec(`${piRun} walk -- sh -c 'sleep 30 & sleep 30; wait' ${tag}-walk`, {}, context);
      const other = env.exec(`${piRun} spin -- sh -c 'sleep 30' ${tag}-spin`, {}, context);
      await sleep(800);
      const second = await env.exec(`${piRun} walk -- echo second`, {}, context);
      assert.equal(second.ok && second.value.exitCode, 0);
      const r1 = await first;
      assert.ok(r1.ok && r1.value.exitCode !== 0, "the first run was stopped");
      await sleep(300);
      assert.equal(spawnSync("pgrep", ["-f", `${tag}-walk`]).stdout.toString().trim(), "", "nothing of the first run is left");
      assert.notEqual(spawnSync("pgrep", ["-f", `${tag}-spin`]).stdout.toString().trim(), "", "the other key still runs");
      await env.exec(`${piRun} spin -- true`, {}, context);
      await other;
    });
  });
});
