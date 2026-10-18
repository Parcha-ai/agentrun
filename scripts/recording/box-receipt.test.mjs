// A box's receipt (RECORDING.md draft 40): a box billed per second carries usd_per_second and costs seconds times it; one
// billed per call carries calls and usd_per_call in place of usd_per_second, and costs calls times usd_per_call. Both
// validators, the viewer's `validate` and this directory's `validateRecording`, refuse a receipt with both prices, calls
// without usd_per_call or the reverse, and a cost that is not its price times its count to 9 decimals, an unpriced box's
// nulls excepted; and they refuse the same receipts.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validate } from '../../apps/viewer/src/format.ts';
import { validateRecording } from './validate.mjs';

const manifest = {
  format: 'agentrun.recording/1', title: 'A run', task: 'box-check',
  recorded: { started: '2026-10-18T08:00:00.000Z', ended: '2026-10-18T08:02:00.000Z' },
  code: { repo: 'agentrun', commit: 'abc1234', packages: { '@parcha/agentrun-dsl': '0.1.0', '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } },
  model: 'faux/faux-1', generations: 1, kills: 0, cost: { usd: null, parts: {} }, source: { run: 'run-1', store_sha256: 'a'.repeat(64) },
};
const base = { box: 'box-1', provider: 'archil', kind: 'exec', from: '2026-10-18T08:00:00Z', to: '2026-10-18T08:02:00Z', seconds: 120, source: 'transport', priced: '2026-10-18' };
const RECEIPTS = {
  'per second': { ok: true, data: { ...base, usd_per_second: 0.00005, cost_usd: 0.006 } },
  'per call': { ok: true, data: { ...base, calls: 7, usd_per_call: 0.00005, cost_usd: 0.00035 } },
  'per call, its product not rounded': { ok: true, data: { ...base, calls: 3, usd_per_call: 0.00005, cost_usd: 3 * 0.00005 } },
  'per call, rounded to 9 decimals': { ok: true, data: { ...base, calls: 3, usd_per_call: 0.0000333333333, cost_usd: 0.0001 } },
  'per call, no calls made': { ok: true, data: { ...base, calls: 0, usd_per_call: 0.00005, cost_usd: 0 } },
  'unpriced, per second': { ok: true, data: { ...base, usd_per_second: null, cost_usd: null } },
  'unpriced, per call': { ok: true, data: { ...base, calls: 4, usd_per_call: null, cost_usd: null } },
  'both prices': { ok: false, message: /both usd_per_second and usd_per_call/, data: { ...base, calls: 7, usd_per_call: 0.00005, usd_per_second: 0, cost_usd: 0.00035 } },
  'calls without usd_per_call': { ok: false, message: /calls without usd_per_call/, data: { ...base, calls: 7, usd_per_second: 0.00005, cost_usd: 0.006 } },
  'usd_per_call without calls': { ok: false, message: /usd_per_call without calls/, data: { ...base, usd_per_call: 0.00005, cost_usd: 0.00035 } },
  'no price at all': { ok: false, message: /carries no price/, data: { ...base, cost_usd: 0.006 } },
  'a per-call cost priced by the second': { ok: false, message: /cost_usd is 0.006, not its usd_per_call times its calls, 0.00035/, data: { ...base, calls: 7, usd_per_call: 0.00005, cost_usd: 0.006 } },
  'a per-second cost off by a cent': { ok: false, message: /cost_usd is 0.016, not its usd_per_second times its seconds, 0.006/, data: { ...base, usd_per_second: 0.00005, cost_usd: 0.016 } },
  'a cost off in the ninth decimal': { ok: false, message: /cost_usd is 0.000350001/, data: { ...base, calls: 7, usd_per_call: 0.00005, cost_usd: 0.000350001 } },
  'a price with no cost': { ok: false, message: /cost_usd is null, not its usd_per_call/, data: { ...base, calls: 7, usd_per_call: 0.00005, cost_usd: null } },
  'unpriced with a cost': { ok: false, message: /usd_per_second is null, so its cost_usd is null, not 0/, data: { ...base, usd_per_second: null, cost_usd: 0 } },
  'calls that are no count': { ok: false, message: /calls is 2.5, not a whole number/, data: { ...base, calls: 2.5, usd_per_call: 0.00005, cost_usd: 0.000125 } },
};
const lines = (data) => [
  { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 0, data: { gen: 1 } },
  { channel: 'live', source: 'host', kind: 'box.receipt', t: 120000, seq: 1, data },
];

async function viaScript(t, data) {
  const dir = await mkdtemp(join(tmpdir(), 'box-receipt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'blobs'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'events.jsonl'), lines(data).map((line) => JSON.stringify(line)).join('\n') + '\n');
  return validateRecording(dir).filter((problem) => /box\.receipt/.test(problem.message)).map((problem) => `line ${problem.line}: ${problem.message}`);
}
const viaViewer = (data) => validate(manifest, lines(data)).filter((problem) => /box\.receipt/.test(problem));

for (const [name, { ok, message, data }] of Object.entries(RECEIPTS)) {
  test(`a receipt ${name}: ${ok ? 'accepted' : 'refused'} by both validators, in the same words`, async (t) => {
    const script = await viaScript(t, data);
    const viewer = viaViewer(data);
    assert.deepEqual(viewer, script, 'the two validators say the same of it');
    if (ok) assert.deepEqual(script, []);
    else {
      assert.equal(script.length, 1, script.join('\n'));
      assert.match(script[0], /^line 2: /);
      assert.match(script[0], message);
    }
  });
}
