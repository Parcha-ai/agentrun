// The Apollo 11 film's first slice. The pure parts run anywhere; the dry run needs Docker, the Chrome image already pulled
// (about 1.5 GB: the test never pulls it) and the network, and is skipped without them or with FILM_OFFLINE=1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHROME_IMAGE, extensionIdOf } from './apollo-film/chrome-box.ts';
import { lead, sources } from './apollo-film/dry-run.ts';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const ready = docker('image', 'inspect', CHROME_IMAGE).status === 0 && process.env.FILM_OFFLINE !== '1';
const needsDocker = { skip: ready ? false : `Docker with ${CHROME_IMAGE} pulled, and the network, are needed` };

test("an unpacked extension's id is the SHA-256 of its path, a letter for each nibble: the id Chrome gave /tmp/ext", () => {
  // Read from a real Chrome 155 that loaded the extension from this path.
  assert.equal(extensionIdOf('/tmp/ext'), 'lcfjooiecahccmjaipimfaidcnaihadb');
  assert.notEqual(extensionIdOf('/tmp/other'), extensionIdOf('/tmp/ext'));
});

test('every source of the film is a NASA item with a credit and the page that says what it is', () => {
  assert.ok(sources.items.length >= 1);
  for (const item of sources.items) {
    assert.ok(item.id && item.title && item.credit, JSON.stringify(item));
    assert.match(item.credit, /^NASA/, `${item.id}: the credit names NASA`);
    assert.match(item.page, /^https:\/\/(www\.nasa\.gov|images-api\.nasa\.gov|images-assets\.nasa\.gov)\//, `${item.id}: a NASA page`);
  }
});

const user = (text) => ({ role: 'user', content: text });
const result = (toolName, text, isError = false) => ({ role: 'toolResult', toolName, content: [{ type: 'text', text }], isError });
const step = (messages) => { const call = lead(messages).content[0]; return [call.name, call.arguments]; };

test('the lead opens the first page, reads it, and cites the read; a step that keeps failing ends in an honest answer', () => {
  const task = user('pages: ["https://www.nasa.gov/mission/apollo-11/"]');
  assert.deepEqual(step([task]), ['run', { code: 'await page.goto("https://www.nasa.gov/mission/apollo-11/")' }]);
  assert.deepEqual(step([task, result('run', 'ok')]), ['browser_read', { what: 'markdown' }]);
  const [name, args] = step([task, result('run', 'ok'), result('browser_read', '# Apollo 11\nevidence/browse/browser_read-abc.json')]);
  assert.equal(name, 'submit');
  assert.deepEqual(args.citations, ['evidence/browse/browser_read-abc.json']);
  const failed = [task, result('run', 'no', true), result('run', 'no', true), result('run', 'no', true)];
  const [last, said] = step(failed);
  assert.equal(last, 'submit');
  assert.match(said.answer, /could not be opened/);
});

test('a Chrome in a Docker box browses nasa.gov through pi-browser, and the run is a valid recording with its frames and the box', needsDocker, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apollo-film-'));
  try {
    const recording = join(dir, 'recording');
    const ran = spawnSync(process.execPath, [join(import.meta.dirname, 'apollo-film', 'dry-run.ts'), '--record', recording, '--dir', join(dir, 'run')], { encoding: 'utf8', timeout: 240_000 });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /dry run: complete, [1-9]\d* frames/);
    const checked = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'recording', 'validate.mjs'), recording], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const lines = readFileSync(join(recording, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const frames = lines.filter((line) => line.kind === 'frame');
    assert.ok(frames.length >= 1);
    for (const frame of frames) {
      assert.equal(frame.source, 'browser');
      assert.equal(frame.channel, 'live');
      assert.equal(frame.data.mime, 'image/jpeg');
      assert.ok(existsSync(join(recording, 'blobs', `${frame.blobs[0]}.jpg`)));
    }
    const created = lines.find((line) => line.kind === 'box.created');
    const ended = lines.find((line) => line.kind === 'box.ended');
    assert.ok(created && ended && created.data.box === ended.data.box && created.t <= ended.t);
    const record = JSON.parse(readFileSync(join(dir, 'run', 'out', 'record.json'), 'utf8')).record;
    assert.match(record.answer, /Chrome inside a Docker box/);
    assert.equal(record.citations.length, 1);
    // The box is removed when the run ends.
    assert.equal(docker('ps', '--all', '--quiet', '--filter', `id=${created.data.box}`).stdout.trim(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
