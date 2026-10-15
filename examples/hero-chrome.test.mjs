// The hero job in a real local Chrome on the job's own pages (no network; the lead and the eyes scripted), with the frame recorder: every browser
// session leaves frames and one video, the killed and resumed run validates, and nothing is paid twice. It runs only where CHROME_PATH names a Chrome
// (set PI_BROWSER_NO_SANDBOX=1 where Chrome's sandbox cannot start), and alone: a real-Chrome suite never runs beside a full one.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { heroRun } from './hero/run.ts';

const chrome = process.env.CHROME_PATH;

test('a local Chrome on the job\'s pages: nine sessions leave frames and a video each, the killed run resumes, and the recording validates', { skip: !chrome || !existsSync(chrome) ? 'set CHROME_PATH to a Chrome' : false, timeout: 400_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hero-chrome-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const recording = join(tmp, 'recording');
  const run = await heroRun({ mode: 'chrome', kill1: 3, record: recording });
  t.after(() => run.cleanup());
  assert.deepEqual(run.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']]);
  assert.deepEqual([run.record.grids, run.record.read, run.record.failed], [9, 9, 0]);
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  const sessions = new Set(lines.filter((line) => line.source === 'browser' && line.kind === 'frame').map((line) => line.data.session));
  assert.ok(sessions.size >= 9, `a frame from each of nine sessions at least, not ${sessions.size}`);
  const tracks = lines.filter((line) => line.kind === 'frame.track');
  assert.ok(tracks.length >= 9, 'one track per session that has a frame');
  for (const track of tracks) {
    const [webm, index] = track.blobs;
    assert.ok(readFileSync(join(recording, 'blobs', `${webm}.webm`)).length > 0, 'the video is in blobs/');
    assert.ok(JSON.parse(readFileSync(join(recording, 'blobs', `${index}.json`), 'utf8')).frames.length > 0, 'and its index lists frames');
  }
  const counted = fold(lines);
  assert.deepEqual([counted.processes, counted.kills, counted.repeated, counted.unknown], [2, 1, 0, 0]);
});
