// A recording never holds a browser session's live-view URL: the viewer's address is a full-control token, and a recording is
// replayed by anyone who has it. The fake backend reports one for every session it opens (a debugger URL with a token, as
// Browserbase's are), so the reference job on fakes shows whether the host lets it through: neither the recording's browser
// lines nor the run's own events.jsonl may carry it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localHost, placeAt, run } from '@parcha/agentrun-harness';
import { fakes, job } from './reference/job.ts';
import { openRecorder } from '../packages/harness/dist/record.js';

const commits = async () => async () => undefined;
const spooled = (dir) => readdirSync(join(dir, '.spool')).filter((name) => name.startsWith('live-')).sort()
  .flatMap((name) => readFileSync(join(dir, '.spool', name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));

test('a session\'s rows reach the recording and the run\'s events with no live-view URL; the row is otherwise whole', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'reference-live-view-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'recording');
  const place = await placeAt(join(tmp, 'run'));
  const recorder = openRecorder({ dir, commits });
  const local = localHost(place, fakes, { recorder });
  assert.equal((await run(place, local.host, job)).status, 'complete');
  await recorder.detach();
  const rows = spooled(dir).filter((line) => line.source === 'browser' && ['launched', 'updated'].includes(line.kind));
  assert.ok(rows.length > 0, 'the run opened a session');
  for (const row of rows) {
    assert.equal(row.data.liveView, null, `${row.kind}: no live view in the row`);
    assert.equal(typeof row.data.session?.tag, 'string', `${row.kind}: the session record is kept`);
  }
  const events = readFileSync(join(place.root, 'events.jsonl'), 'utf8');
  const recorded = readdirSync(join(dir, '.spool')).map((name) => readFileSync(join(dir, '.spool', name), 'utf8')).join('\n');
  for (const [where, text] of [['events.jsonl', events], ['the recording', recorded]]) {
    assert.doesNotMatch(text, /inspector\.html|devtools\/page\/|[?&]token=/, `${where} holds no viewer address`);
  }
});
