// The browser's pictures in a recording: recordFrames hands pi-browser's frame lines to the recorder as live browser lines,
// each JPEG kept as a blob, and when it finishes makes a frame.track per session. The frame recorder is a stand-in here (no
// Chrome); the track is a stand-in too, except in the last test, which makes a real one with ffmpeg when the machine has it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FRAME_FPS, recordFrames } from '../packages/reference/dist/frames.js';
import { openRecorder } from '../packages/reference/dist/record.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Every live line this test's recorder spooled, in order. */
const spooled = (dir) => readdirSync(join(dir, '.spool')).filter((name) => name.startsWith('live-')).sort()
  .flatMap((name) => readFileSync(join(dir, '.spool', name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));

/** A stand-in for pi-browser's frameRecorder: it keeps the options it was made with, so the test can call its sink. */
function standIn() {
  const seen = { options: undefined, watched: [], closed: 0 };
  const factory = (options) => {
    seen.options = options;
    return { watch: (provider) => { seen.watched.push(provider); return { ...provider, watched: true }; }, pause() {}, resume() {}, stats: () => ({ frames: 0, gaps: 0, dropped: 0, sessions: 0 }), close: async () => { seen.closed += 1; } };
  };
  return { seen, factory };
}

async function recording(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'reference-frames-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, recorder: openRecorder({ dir }) };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const frame = (hash, t = 5) => ({ channel: 'live', source: 'browser', kind: 'frame', t, conv: 3, data: { session: 's1', provider: 'chrome', w: 64, h: 48, mime: 'image/jpeg' }, blobs: [hash] });

test('a frame the recorder hands over is a live browser line with its JPEG kept as a blob; a gap is a line with none; each provider is watched once', async (t) => {
  const { dir, recorder } = await recording(t);
  const { seen, factory } = standIn();
  const tap = recordFrames(recorder, dir, {}, { frameRecorder: factory });
  assert.equal(seen.options.maxFps, FRAME_FPS);
  const provider = { name: 'chrome' };
  const plane = tap.plane({ provider: () => provider, driver: async () => ({}) });
  const [first, second] = [await plane.provider({}), await plane.provider({})];
  assert.equal(first, second, 'the same provider is the same watched one');
  assert.deepEqual([seen.watched.length, first.watched], [1, true]);
  const hash = sha(JPEG);
  await seen.options.sink(frame(hash), { [hash]: JPEG });
  await seen.options.sink({ channel: 'live', source: 'browser', kind: 'frame.gap', t: 9, conv: 3, data: { session: 's1', from: 9, reason: 'session_released' } });
  await recorder.detach();
  const lines = spooled(dir).filter((line) => line.source === 'browser');
  assert.deepEqual(lines.map((line) => [line.kind, line.conv, line.blobs ?? null]), [['frame', 3, [hash]], ['frame.gap', 3, null]]);
  assert.deepEqual(lines[0].data, frame(hash).data);
  assert.deepEqual(readFileSync(join(dir, 'blobs', `${hash}.jpg`)), JPEG);
});

test('finish stops the capture and writes one frame.track line per track, its WebM and its index kept as blobs', async (t) => {
  const { dir, recorder } = await recording(t);
  const { seen, factory } = standIn();
  const webm = Buffer.from('a webm'), index = Buffer.from('{"version":1}');
  let asked;
  const exportStandIn = async (options) => {
    asked = options;
    assert.deepEqual(Buffer.from(await options.readBlob(sha(JPEG))), JPEG, 'the export reads the frame from the recording');
    return [{ line: { channel: 'live', source: 'browser', kind: 'frame.track', t: 20, conv: 3, data: { session: 's1', fps: FRAME_FPS, from: 5, to: 20 }, blobs: [sha(webm), sha(index)] }, blobs: { [sha(webm)]: webm, [sha(index)]: index } }];
  };
  const tap = recordFrames(recorder, dir, {}, { frameRecorder: factory, exportFrameTracks: exportStandIn });
  await seen.options.sink(frame(sha(JPEG)), { [sha(JPEG)]: JPEG });
  await tap.finish();
  await recorder.detach();
  assert.equal(seen.closed, 1);
  assert.deepEqual([asked.fps, asked.lines.map((line) => line.kind)], [FRAME_FPS, ['frame']]);
  const track = spooled(dir).find((line) => line.kind === 'frame.track');
  assert.deepEqual([track.source, track.conv, track.data, track.blobs], ['browser', 3, { session: 's1', fps: FRAME_FPS, from: 5, to: 20 }, [sha(webm), sha(index)]]);
  assert.deepEqual([readFileSync(join(dir, 'blobs', `${sha(webm)}.webm`)), readFileSync(join(dir, 'blobs', `${sha(index)}.json`))], [webm, index]);
  assert.equal(tap.stats().tracks, 1);
});

test('a track that cannot be made is left out with a warning, and the frames stay; a session with no frame asks for no track', async (t) => {
  const { dir, recorder } = await recording(t);
  const warned = t.mock.method(process, 'emitWarning', () => {});
  let asked = 0;
  const failing = async () => { asked += 1; throw new Error('ffmpeg_missing'); };
  const none = standIn();
  const empty = recordFrames(recorder, dir, {}, { frameRecorder: none.factory, exportFrameTracks: failing });
  await none.seen.options.sink({ channel: 'live', source: 'browser', kind: 'frame.gap', t: 9, conv: 3, data: { session: 's0', from: 9, reason: 'session_released' } });
  await empty.finish();
  assert.equal(asked, 0, 'gaps alone make no track');
  const some = standIn();
  const tap = recordFrames(recorder, dir, {}, { frameRecorder: some.factory, exportFrameTracks: failing });
  await some.seen.options.sink(frame(sha(JPEG)), { [sha(JPEG)]: JPEG });
  await tap.finish();
  await recorder.detach();
  assert.equal(asked, 1);
  assert.equal(warned.mock.calls.length, 1);
  assert.equal(warned.mock.calls[0].arguments[1].code, 'AGENTRUN_FRAME_TRACK');
  const kinds = spooled(dir).filter((line) => line.source === 'browser').map((line) => line.kind);
  assert.deepEqual(kinds, ['frame.gap', 'frame']);
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('with ffmpeg, finish makes a real WebM track and its index from the recorded JPEGs', { skip: ffmpeg ? false : 'no ffmpeg on this machine' }, async (t) => {
  const { dir, recorder } = await recording(t);
  const out = join(dir, 'one.jpg');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', out]).status, 0);
  const jpeg = readFileSync(out);
  const { seen, factory } = standIn();
  const tap = recordFrames(recorder, dir, {}, { frameRecorder: factory });
  await seen.options.sink(frame(sha(jpeg), 0), { [sha(jpeg)]: jpeg });
  await tap.finish();
  await recorder.detach();
  const track = spooled(dir).find((line) => line.kind === 'frame.track');
  assert.ok(track, 'a frame.track line');
  const [webm, index] = track.blobs;
  assert.deepEqual([...readFileSync(join(dir, 'blobs', `${webm}.webm`)).subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], 'an EBML (WebM) file');
  const parsed = JSON.parse(readFileSync(join(dir, 'blobs', `${index}.json`), 'utf8'));
  assert.deepEqual([parsed.version, parsed.session, parsed.frames.length], [1, 's1', 1]);
  assert.ok(existsSync(join(dir, 'blobs', `${sha(jpeg)}.jpg`)));
});
