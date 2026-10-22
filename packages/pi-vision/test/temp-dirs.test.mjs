// What the package and its test helper leave in the temp root. A scratch directory is removed on every path out of the work
// that made it, a cancelled call among them (pi's environments refuse every operation made with a cancelled call's context,
// a removal too), and a test directory goes with the process that made it, whether that process ends, throws or is terminated.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { transcribe, resolveLimits } from "@parcha/pi-vision";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fixtureDir } from "@parcha/pi-vision/testing";

const mp3 = () => Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(2048, 0x55)]);

test("a transcription cancelled while ffprobe measures the file leaves no scratch directory behind", async (t) => {
  const dir = await fixtureDir("pi-vision-temp-dirs-");
  t.after(() => dir.remove());
  await dir.file("landing.mp3", mp3());
  const scratch = join(dir.path, "scratch");
  await mkdir(scratch);
  const controller = new AbortController();
  const base = nodeVisionEnv({ cwd: dir.path });
  // The scratch directory is made under the test's own, and ffprobe "finishes" the moment the call is cancelled.
  const env = Object.assign(Object.create(base), {
    createTempDir: async (prefix) => ({ ok: true, value: await mkdtemp(join(scratch, prefix)) }),
    exec: async (argv) => {
      controller.abort();
      await writeFile(argv[argv.indexOf("-o") + 1], "12.5\n");
      return { ok: true, value: { exitCode: 0 } };
    },
  });
  const setup = {
    limits: resolveLimits({ id: "lead", input: ["text"] }), eyes: undefined, providers: [], sources: {}, scope: { label: "n", deriveDir: join(dir.path, "evidence") },
    evidence: { file: async () => null },
    transcriber: { provider: "stt", model: "stt-1", usdPerMinute: 0.006, transcribe: async () => ({ text: "hello", words: [{ text: "hello", start: 0, end: 1 }] }) },
  };
  await transcribe({ path: "landing.mp3" }, env, { conversationId: "c1", callId: "t1", model: undefined, signal: controller.signal }, setup).catch(() => undefined);
  assert.ok(controller.signal.aborted, "the call was cancelled while ffprobe ran");
  assert.deepEqual(await readdir(scratch), [], "the scratch directory of the length probe is removed though the call was cancelled");
});

/** Runs `body` in a process whose temp root is a directory of its own (it prints READY when `body` is set up), and gives how the
 *  process ended and what it left in that root. */
async function inChild(t, body, { terminate = false } = {}) {
  const root = await fixtureDir("pi-vision-temp-dirs-root-");
  t.after(async () => {
    // A directory a test left unremovable on purpose is made removable again before the root goes.
    for (const name of await readdir(root.path)) await chmod(join(root.path, name, "locked"), 0o755).catch(() => undefined);
    await root.remove();
  });
  const url = import.meta.resolve("@parcha/pi-vision/testing");
  const script = `import { chmod } from "node:fs/promises"; import { fixtureDir } from ${JSON.stringify(url)}; ${body}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TMPDIR: root.path }, stdio: ["ignore", "pipe", "ignore"] });
  const ready = new Promise((resolve) => child.stdout.on("data", (chunk) => String(chunk).includes("READY") && resolve()));
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  if (terminate) { await Promise.race([ready, exit]); child.kill("SIGTERM"); }
  return { ended: await exit, left: await readdir(root.path) };
}

/** A process that has made a fixture directory of its own and then runs `tail`. */
const leftBy = (t, tail, options) => inChild(t, `const d = await fixtureDir("pi-vision-leak-probe-"); await d.file("a.txt", "x"); console.log("READY"); ${tail}`, options);

test("a test's directory is gone when its process exits without removing it", async (t) => {
  const { ended, left } = await leftBy(t, "process.exit(0);");
  assert.equal(ended.code, 0);
  assert.deepEqual(left, []);
});

test("a test's directory is gone when its process dies of an uncaught error", async (t) => {
  const { ended, left } = await leftBy(t, 'throw new Error("a test that failed outside its own hooks");');
  assert.notEqual(ended.code, 0);
  assert.deepEqual(left, []);
});

test("a test's directory is gone when its process is terminated, and it still dies of the signal", async (t) => {
  const { ended, left } = await leftBy(t, "setInterval(() => {}, 1000);", { terminate: true });
  assert.equal(ended.signal, "SIGTERM", "the signal still ends the process");
  assert.deepEqual(left, []);
});

const root = process.getuid?.() === 0;

test("a directory whose removal failed is still removed when the process ends", { skip: root && "root ignores file modes" }, async (t) => {
  // The first removal fails (its parent cannot be written to), so the directory has not been removed and must stay tracked.
  const { ended, left } = await inChild(t, [
    'const d = await fixtureDir("pi-vision-leak-probe-"); await d.file("a.txt", "x");',
    "await chmod(d.path, 0o555); await d.remove().catch(() => undefined); await chmod(d.path, 0o755);",
    'console.log("READY"); process.exit(0);',
  ].join(" "));
  assert.equal(ended.code, 0);
  assert.deepEqual(left, [], "a failed remove() does not make the process forget the directory");
});

test("a directory that will not go does not stop the sweep, or the signal, or the exit", { skip: root && "root ignores file modes" }, async (t) => {
  const body = (tail) => [
    'const a = await fixtureDir("pi-vision-leak-probe-a-"); const b = await fixtureDir("pi-vision-leak-probe-b-");',
    'await a.file("locked/f.txt", "x"); await b.file("g.txt", "y"); await chmod(a.path + "/locked", 0o555);',
    `console.log("READY"); ${tail}`,
  ].join(" ");
  const exited = await inChild(t, body("process.exit(0);"));
  assert.deepEqual([exited.ended.code, exited.ended.signal], [0, null], "the exit is the process's own");
  assert.deepEqual(exited.left.map((name) => name.replace(/-[A-Za-z0-9]{6}$/, "")), ["pi-vision-leak-probe-a"], "the other directory is gone");
  const stopped = await inChild(t, body("setInterval(() => {}, 1000);"), { terminate: true });
  assert.equal(stopped.ended.signal, "SIGTERM", "the signal still ends the process");
  assert.deepEqual(stopped.left.map((name) => name.replace(/-[A-Za-z0-9]{6}$/, "")), ["pi-vision-leak-probe-a"], "the other directory is gone");
});
