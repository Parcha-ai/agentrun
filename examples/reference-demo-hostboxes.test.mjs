// H3: a place's host boxes through the supervisor's tap (RECORDING.md draft 56, with its Amendment 1). A place whose host
// driver makes its boxes with the provider the supervisor hands it (`context.hostTap.provider`), in an unheld window
// (`context.hostTap.unheld`), gets each host box's life in the recording as the supervisor's own host lines, by the run-wide
// label the run's process binds (H1's claimHost): `box.created` (role host, with `from`), one `box.exec` per command (with
// `at`), `box.ended`. Until the supervisor READS the bound label, the lines wait; a recording never carries a pending name.
// The fixture place is `DEMO_WITH_PLACE=tapped` (examples/reference/demo-fixture.ts): a local box stands for the host box.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readEvents } from '../scripts/recording/fold.mjs';
import { parseLines, validate as viewerValidate } from '../apps/viewer/src/format.ts';
import { run } from './reference-demo-helpers.mjs';

const hostBoxLines = (recording) => readEvents(recording).filter((line) => line.source === 'host' && line.channel === 'live' && ['box.created', 'box.exec', 'box.ended'].includes(line.kind));
const receipts = (recording) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'box.receipt').map((line) => line.data);
const readIds = (dir) => Object.fromEntries(readdirSync(dir).filter((name) => /^box-\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5))).map((name) => [name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), 'utf8'))]));
const everyFile = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'));

test('H3: a host box made through the tapped provider is in the recording as the supervisor\'s host lines, by the label its run\'s process bound (box-1): box.created (role host, from), its command\'s box.exec (at), box.ended; the tools\' boxes are box-2 and box-3; one receipt each; the viewer\'s format check gives no note', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'tapped' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const idsDir = join(result.dir, 'box-ids.internal');
  const ids = readIds(idsDir);
  assert.deepEqual(Object.entries(ids).map(([label, entry]) => [label, entry.owner, entry.provider]), [['box-1', 'place', 'local'], ['box-2', 'tools', 'alpha'], ['box-3', 'tools', 'beta']]);
  // The unheld window wrote only a name of its own start's, never a label.
  const pending = readdirSync(join(idsDir, 'pending'));
  assert.equal(pending.length, 1);
  const life = ids['box-1'].run;
  assert.equal(pending[0], `${life}-1.json`);
  assert.deepEqual(JSON.parse(readFileSync(join(idsDir, 'pending', pending[0]), 'utf8')), { provider: 'local', key: '0', run: life });
  // The box's key is the one its host driver minted at the create (Amendment 2): its runner claimed the label by it (HOST_BOX), the
  // supervisor read the label by the place's status key, and the tap bound the box's lines by the key on its create's label. The lines
  // below are there only because all three are the one key.
  assert.match(ids['box-1'].key, new RegExp(`^${life.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/0/[0-9a-f]{16}$`), 'the minted key, never the window\'s index');

  const lines = hostBoxLines(recording);
  assert.deepEqual(lines.map((line) => [line.kind, line.data.box, line.data.gen]), [['box.created', 'box-1', 1], ['box.exec', 'box-1', 1], ['box.ended', 'box-1', 1]]);
  for (const line of lines) assert.equal(line.gen, undefined, 'the supervisor\'s lines carry no event-level gen');
  const [created, exec, ended] = lines.map((line) => line.data);
  assert.deepEqual(Object.keys(created).sort(), ['box', 'facts', 'from', 'gen', 'provider', 'role']);
  assert.equal(created.role, 'host');
  assert.equal(created.provider, 'local');
  assert.deepEqual(Object.keys(created.facts).sort(), ['cpus', 'gpu', 'isolation']);
  assert.deepEqual(Object.keys(exec).sort(), ['at', 'box', 'gen']);
  assert.deepEqual(ended, { gen: 1, box: 'box-1', provider: 'local', killed: false });
  // The command ran before the label was bound: its line was held and keeps the command's own time, earlier than the line's.
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  const started = Date.parse(manifest.recorded?.started ?? manifest.started);
  assert.ok(Number.isFinite(started), 'the recording has a start');
  assert.ok(Date.parse(exec.at) - started < lines[1].t, `the held box.exec's at (${exec.at}) is earlier than its line (t ${lines[1].t})`);
  assert.ok(Date.parse(created.from) - started <= lines[0].t);

  assert.deepEqual(receipts(recording).map((receipt) => [receipt.box, receipt.provider]).sort(), [['box-1', 'local'], ['box-2', 'alpha'], ['box-3', 'beta']]);
  // No pending name, and no provider id of the host box, anywhere in the recording.
  const hostBoxIds = existsSync(join(result.dir, '..', 'host-boxes')) ? readdirSync(join(result.dir, '..', 'host-boxes')) : [];
  for (const text of everyFile(recording)) {
    assert.equal(text.includes('pending/'), false);
    assert.equal(text.includes(pending[0]), false);
    for (const id of hostBoxIds) assert.equal(text.includes(id), false, `the host box's id ${id} is in the recording`);
  }
  const parsed = parseLines(readFileSync(join(recording, 'events.jsonl'), 'utf8'));
  const blobs = new Set((existsSync(join(recording, 'blobs')) ? readdirSync(join(recording, 'blobs')) : []).map((name) => name.split('.')[0]));
  assert.deepEqual(viewerValidate(manifest, parsed, blobs), []);
});

test('DETECTION: a label the run\'s process binds for a host box that already names another box in the recording (a crash\'s residue: a synced line kept, its label file lost) refuses the recording, naming the label', { timeout: 300_000 }, async (t) => {
  await assert.rejects(
    run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'tapped', DEMO_PLANT_BOX_LINE: '1' }),
    /the recording is refused: the label box-1 the run's process bound for host box \S+\/0\/[0-9a-f]{16} already names another box in this recording/,
  );
});

test('DETECTION at the end: two box.created lines under one label, from any writers (here a planted line and the run\'s own tool box box-2), refuse the recording, naming the label', { timeout: 300_000 }, async (t) => {
  await assert.rejects(
    run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'tapped', DEMO_PLANT_BOX_LINE: 'box-2' }),
    /the recording is refused: the label box-2 names 2 boxes in this recording/,
  );
});

test('a host box the place ends only when it lets the run go stays OPEN in the recording: the recording is finished before the release (a release may delete the run tree), so the box has no box.ended and its one receipt has no end', { timeout: 300_000 }, async (t) => {
  const mark = join(await mkdtemp(join(tmpdir(), 'release-mark-')), 'mark.json');
  t.after(() => rm(dirname(mark), { recursive: true, force: true }));
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'tapped', DEMO_HOST_BOX_UNTIL_RELEASE: '1', DEMO_RELEASE_MARK: mark });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(JSON.parse(readFileSync(mark, 'utf8')), { manifestFirst: true }, 'the manifest is written before the place is let go');
  assert.deepEqual(hostBoxLines(recording).filter((line) => line.kind === 'box.ended'), [], 'no box.ended: the box ended after the recording was finished');
  const receipt = receipts(recording).filter((each) => each.box === 'box-1');
  assert.equal(receipt.length, 1, 'one receipt for the box');
  assert.deepEqual([receipt[0].to, receipt[0].seconds, receipt[0].cost_usd], [null, null, null], `the open box's receipt has no end: ${JSON.stringify(receipt[0])}`);
});
