// A run's video of its browser (computer.record on a browser computer): the claim (computer-for-claim.ts) gives the run's
// browser tool its ClaimBrowser's `record`, and the tool (sessionRecordings, computer-record.ts) records each session from
// its launch to its release through the run's live view's one CDP screencast of it (pi-browser's LiveViewHost.watch),
// into recordings/<computer>.mp4. The browser is pi-browser's fake DevTools endpoint; the provider is a stand-in in the
// computer module's shape. The playback test pipes a real JPEG (docker/frame.jpg) through the ffmpeg on this machine's
// PATH and reads the file back with ffprobe: an H.264 video of the page's size with the frames sent. Its length is ffmpeg's
// wall clock (-use_wallclock_as_timestamps), so a loaded machine moves it: it is reported, not asserted (any-5 read 1.9 s
// and 2.1 s for a 2.5 s session in the merge queue, 11-17).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { createDrivingGates, createLiveView } from "@parcha/pi-browser/live-view";
import { fakeCdp } from "../../pi-browser/test/fixtures/fake-cdp.mjs";
import { sessionRecordings } from "../dist/computer-record.js";
import { commandOnPath } from "../dist/host-command.js";
import { computerForClaim, localWorkspace } from "../dist/workspace/index.js";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
const closers = [];
after(async () => {
  for (const close of closers) await close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-browser-record-")));
  dirs.push(dir);
  return dir;
}

async function until(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** The local Chrome as a browser provider in the computer module's shape: each create a session, its connect handing over
 *  the fake browser's DevTools URL. */
function chrome(url) {
  let made = 0;
  return {
    id: "local-chrome",
    version: "0",
    capabilities: () => ({ lifetime: "vendor", maxLifetimeMs: 3_600_000, network: ["open"], groups: ["cdp"] }),
    check: () => [],
    list: async () => ({ ok: true, value: [] }),
    create: async () => ({ ok: true, value: { id: `chrome-${++made}`, name: `chrome-${made}` } }),
    connect: async () => ({ ok: true, value: { client: { close() {} }, hello: { version: "0", kind: "browser", groups: ["cdp"] }, cdp: { url }, close: async () => {} } }),
    attach: async (ref) => ({ ok: true, value: { id: ref.id, name: ref.id, spec: { image: "chromium", user: "unknown", network: "open", kind: "browser" } } }),
    release: async () => ({ ok: true, value: undefined }),
  };
}

/** A browser computer's claim with `record` as the agent's setting says, its recordings folder and timeline kept; the
 *  run's live view of one session on a fake browser; and the tool's recordings over them. */
async function browserRun({ record, ffmpeg }) {
  const dir = scratch();
  const root = join(dir, "work");
  mkdirSync(root);
  const folder = join(dir, "recordings");
  const lines = [];
  const fake = await fakeCdp({ pages: [{ id: "PAGE1", url: "https://one.example.test/" }] });
  closers.push(() => fake.close());
  const store = { agents: { revision: async () => undefined }, sealedKeys: { get: async () => undefined, put: async () => {}, remove: async () => {}, all: async () => [] }, computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} } };
  const claim = await computerForClaim(
    { runId: "run-1", epoch: 1, computer: { kind: "browser", provider: "local-chrome", ...(record ? { record } : {}) } },
    store,
    { mode: 1, kinds: KINDS, sealKey: Buffer.alloc(32, 7), providers: { "local-chrome": () => chrome(fake.url) }, spec: () => ({ image: "browser", lifetimeMs: 600_000, network: "open" }), workspace: localWorkspace(root), check: { readBackOf, epoch: 1 }, recordings: { folder, say: (words) => void lines.push(words), ...(ffmpeg ? { ffmpeg } : {}) } },
  );
  closers.push(() => claim.release());
  const view = createLiveView({ hostOrigin: "'self'", gates: createDrivingGates() });
  closers.push(() => view.close());
  const id = await claim.computer.browser.open("ar-run-1-1", 600);
  await view.open("ar-run-1-1", fake.url);
  return { fake, claim, view, id, folder, lines, changed: sessionRecordings(view, claim.computer.browser.record) };
}

test("record on: a session's screencast, shared with the live view, makes recordings/<computer>.mp4 of its frames; every frame is acked", async (t) => {
  if (!commandOnPath("ffprobe", process.env.PATH) || !commandOnPath("ffmpeg", process.env.PATH)) return t.skip("ffmpeg or ffprobe isn't on this machine's PATH: the playback check is skipped");
  const run = await browserRun({ record: true });
  assert.equal(typeof run.claim.computer.browser.record, "function", "the claim records this browser");
  await run.changed("ar-run-1-1", run.id);
  await until(() => run.fake.screencasts().length === 1, "the live view's screencast");
  const page = readFileSync(new URL("../docker/frame.jpg", import.meta.url));
  // Two frames, the second sent once the first is acked and half a second on (so ffmpeg reads them apart, however late
  // it reads), then the release.
  assert.ok(run.fake.frame({ bytes: page }));
  await until(() => run.fake.acks.length === 1, "the first frame's ack, with no viewer open");
  await sleep(500);
  assert.ok(run.fake.frame({ bytes: page }));
  await until(() => run.fake.acks.length === 2, "the second frame's ack, with no viewer open");
  await run.changed("ar-run-1-1", null);
  assert.deepEqual(run.lines, [`Recording the browser's screen into recordings/${run.id}.mp4.`]);
  const probed = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames:format=duration", "-of", "json", join(run.folder, `${run.id}.mp4`)], { encoding: "utf8" }));
  const [stream] = probed.streams;
  assert.equal(stream.codec_name, "h264");
  assert.deepEqual([stream.width, stream.height], [1280, 800], "fitted to the page's 1280x800");
  assert.ok(Number(stream.nb_read_frames) >= 2, `${stream.nb_read_frames} frames`);
  const seconds = Number(probed.format.duration);
  t.diagnostic(`${stream.codec_name} ${stream.width}x${stream.height}, ${stream.nb_read_frames} frames, ${seconds} s (ffmpeg's wall clock: not asserted)`);
});

test("record on: a session released and another launched under the tag each get their own file; the claim's release ends the one still recording", async () => {
  // A program in ffmpeg's place that writes what it reads to the file.
  const copy = join(scratch(), "ffmpeg");
  writeFileSync(copy, `#!/usr/bin/env node\nconst fs = require("node:fs"); process.stdin.pipe(fs.createWriteStream(process.argv.at(-1)));\n`);
  chmodSync(copy, 0o755);
  const run = await browserRun({ record: true, ffmpeg: copy });
  await run.changed("ar-run-1-1", run.id);
  await until(() => run.fake.screencasts().length === 1, "the live view's screencast");
  assert.ok(run.fake.frame());
  await until(() => existsSync(join(run.folder, `${run.id}.mp4`)), "the first session's file");
  const next = await run.claim.computer.browser.open("ar-run-1-1", 600);
  await run.changed("ar-run-1-1", next);
  await until(() => run.fake.acks.length === 1, "the first frame's ack");
  assert.ok(run.fake.frame());
  await until(() => existsSync(join(run.folder, `${next}.mp4`)), "the next session's file");
  await run.claim.release();
  assert.deepEqual(run.lines, [`Recording the browser's screen into recordings/${run.id}.mp4.`, `Recording the browser's screen into recordings/${next}.mp4.`]);
  assert.equal(run.fake.acks.length, 2);
});

test("record off: the claim gives no `record`, and frames through the live view write nothing", async () => {
  const run = await browserRun({});
  assert.equal(run.claim.computer.browser.record, undefined);
  await run.changed("ar-run-1-1", run.id);
  const ws = run.view.watch("ar-run-1-1", { frame() {}, ended() {} });
  await until(() => run.fake.screencasts().length === 1, "a screencast");
  assert.ok(run.fake.frame());
  await until(() => run.fake.acks.length === 1, "the frame's ack");
  await run.changed("ar-run-1-1", null);
  ws();
  await run.claim.release();
  assert.equal(existsSync(run.folder), false, "no recordings folder");
  assert.deepEqual(run.lines, []);
});
