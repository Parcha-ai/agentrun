// The image's ffmpeg check (docker/ffmpeg-check.mjs), run as the Dockerfile runs it, on this machine's ffmpeg behind a
// stand-in that starts it late, as an image built for another architecture does under emulation: the check waits on the
// recorder (a PNG frame written, then a second file with a JPEG frame written), not on a fixed time, and a deadline passed
// or an ffmpeg that refuses JPEG frames fails it by name. Skipped where ffmpeg isn't on PATH; CI's serve shards install it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scratch } from "./support.mjs";

const CHECK = fileURLToPath(new URL("../docker/ffmpeg-check.mjs", import.meta.url));
/** This machine's ffmpeg, the first on PATH, or undefined. */
const real = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "ffmpeg")).find((path) => existsSync(path));
const skip = !real && "ffmpeg isn't on this machine's PATH";

/** Whether process `pid` is still running. */
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs the check with an `ffmpeg` first on PATH that waits `delay` s before it starts the real one, and exits 1 when asked
 *  to read JPEG frames if `refuseJpeg` (at once, or after that many seconds: its input takes frames meanwhile, and it never
 *  makes the file); `args` go to the check. However it ends, no ffmpeg it started is left running. */
async function check(t, { delay = 0, refuseJpeg = false, args = [] } = {}) {
  const dir = await scratch(t);
  const pids = join(dir, "pids");
  const refuse = refuseJpeg === false ? "" : `for a in "$@"; do [ "$a" = mjpeg ] && { sleep ${refuseJpeg === true ? 0 : refuseJpeg}; exit 1; }; done\n`;
  writeFileSync(join(dir, "ffmpeg"), `#!/bin/sh\necho $$ >> '${pids}'\n${refuse}sleep ${delay}\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, "ffmpeg"), 0o755);
  const run = spawnSync(process.execPath, [CHECK, ...args], { encoding: "utf8", timeout: 90_000, env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, TMPDIR: dir } });
  const left = existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number).filter(running) : [];
  assert.deepEqual(left, [], "every ffmpeg the check started has ended when it returns");
  return { status: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

test("an ffmpeg that starts 2 s late still gets a PNG file and a JPEG file: the check waits on what the recorder wrote", { skip, timeout: 120_000 }, async (t) => {
  const { status, out, err } = await check(t, { delay: 2 });
  assert.equal(status, 0, err);
  assert.match(out, /^ffmpeg check: the recorder made recordings\/c1\.mp4 \(\d+ H\.264 frames, 1280x720\) and recordings\/c1-2\.mp4 \(\d+ H\.264 frames, 1280x720\) from PNG and JPEG frames$/);
});

test("past its deadline the check fails by name: the format never written, the files, the frames written and dropped", { skip, timeout: 120_000 }, async (t) => {
  const { status, err } = await check(t, { delay: 5, args: ["1500"] });
  assert.equal(status, 1);
  assert.match(err, /^ffmpeg check: no JPEG frame written in 1\.5 s \(files: recordings\/c1\.mp4, written \d+, dropped \d+\)$/);
});

test("an ffmpeg that refuses JPEG frames fails the check by name, before its deadline", { skip, timeout: 120_000 }, async (t) => {
  const started = Date.now();
  const { status, err } = await check(t, { refuseJpeg: true });
  assert.equal(status, 1);
  assert.match(err, /^ffmpeg check: the recording ended by itself: ffmpeg stopped \(exit code 1\)/);
  assert.ok(Date.now() - started < 30_000, `${Date.now() - started} ms`);
});

test("an ffmpeg that takes JPEG frames into its input and exits with no file made fails the check by name, never as a read of a file that is not there", { skip, timeout: 120_000 }, async (t) => {
  // Its input (a pipe) takes the frames while it waits, so the recorder counts them written before ffmpeg made any file.
  const { status, err } = await check(t, { refuseJpeg: 2 });
  assert.equal(status, 1);
  assert.match(err, /^ffmpeg check: the recording ended by itself: ffmpeg stopped \(exit code 1\)/, err);
});
