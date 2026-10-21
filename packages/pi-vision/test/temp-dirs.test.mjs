// What the package and its test helper leave in the temp root. A scratch directory is removed on every path out of the work
// that made it, a cancelled call among them (pi's environments refuse every operation made with a cancelled call's context,
// a removal too), and a test directory goes with the process that made it, whether that process ends, throws or is terminated.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
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

/** Runs `tail` in a process that has made a fixture directory under its own temp root, and gives what the process left there. */
async function leftBy(t, tail, { terminate = false } = {}) {
  const root = await fixtureDir("pi-vision-temp-dirs-root-");
  t.after(() => root.remove());
  const url = import.meta.resolve("@parcha/pi-vision/testing");
  const script = `import { fixtureDir } from ${JSON.stringify(url)}; const d = await fixtureDir("pi-vision-leak-probe-"); await d.file("a.txt", "x"); console.log("READY"); ${tail}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TMPDIR: root.path }, stdio: ["ignore", "pipe", "ignore"] });
  const ready = new Promise((resolve) => child.stdout.on("data", (chunk) => String(chunk).includes("READY") && resolve()));
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  if (terminate) { await Promise.race([ready, exit]); child.kill("SIGTERM"); }
  const ended = await exit;
  return { ended, left: await readdir(root.path) };
}

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
