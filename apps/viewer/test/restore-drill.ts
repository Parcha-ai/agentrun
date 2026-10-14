// A recording built line by line for RECORDING.md 3.2: a box dies after commit 5, the run reopens its checkpoint at
// commit 3, and commits 4 and 5 become a lost branch that the next process redoes. The restore tests read it, and the
// page test plays it.
import type { Json, Line } from '../src/format.ts';

export const manifest = {
  format: 'agentrun.recording/1', title: 'a restore', task: 'restore drill', recorded: { started: '2026-10-14T00:00:00Z', ended: '2026-10-14T00:01:00Z' },
  code: { repo: 'r', commit: 'c', packages: {} }, model: 'scripted', generations: 2, kills: 1, cost: { usd: null, parts: { judge: null } },
  source: { run: 'run', store_sha256: '0'.repeat(64) },
};

let t = 0;
export const supervisor = (kind: string, seq: number, data: Json): Line => ({ channel: 'live', source: 'host', kind, t: (t += 10), seq, data });
export const doc = (gen: number, commit: number, order: number, name: string, key: string | undefined, value: Json, snapshot = false): Line => ({
  channel: 'durable', source: name.startsWith('transport') ? 'transport' : 'workflow', kind: name, gen, t: (t += 10), commit, order,
  ...(snapshot ? { snapshot: true } : {}), data: { doc: name, ...(key !== undefined ? { key } : {}), value },
});
export const APPLIED = { outcome: 'applied' };
export const effect = (gen: number, commit: number, order: number, id: string, name: string, status: string, snapshot = false, calls?: Json[]) =>
  doc(gen, commit, order, 'agentrun.effects', `journal\u0000${id}`, { name, argsHash: `${name}-args`, status, ...(calls ? { calls } : {}) }, snapshot);
const decisions = (gen: number, commit: number, order: number, rows: Json[]) => doc(gen, commit, order, 'agentrun.decisions', 'journal', { receipts: rows });
// A scripted judge reports no cost, so the run's cost is unknown, as the manifest says.
const ask = { decision_id: 'd1', run_key: 'run', cost_usd: null };

export const lines: Line[] = [
  supervisor('process.started', 1, { gen: 1 }),
  doc(1, 1, 0, 'agentrun.driver', undefined, { generation: 1 }),
  effect(1, 2, 0, 'e1', 'search', 'unknown'),
  effect(1, 3, 0, 'e1', 'search', 'completed'),
  // The lost branch: commits 4 and 5, which no store holds after the restore.
  effect(1, 4, 0, 'e2', 'fetch', 'unknown'),
  effect(1, 5, 0, 'e2', 'fetch', 'completed', false, [APPLIED]),
  doc(1, 5, 1, 'agentrun.receipts', 'read fetch-args', { tool: 'read' }),
  decisions(1, 5, 2, [ask]),
  supervisor('kill', 2, { gen: 1, label: 'the box died', crossing: null }),
  supervisor('process.started', 3, { gen: 2 }),
  // The checkpoint, as process 2's snapshot: the state at commit 3, whose gen is the driver's there (1).
  doc(1, 3, 0, 'agentrun.driver', undefined, { generation: 1 }, true),
  effect(1, 3, 1, 'e1', 'search', 'completed', true),
  doc(2, 4, 0, 'transport.moves', 'm1', { kind: 'restore', head: 4, checkpoint: { head: 4, sha256: 'x', bytes: 1 } }),
  doc(2, 4, 1, 'agentrun.driver', undefined, { generation: 2 }),
  // The redo, numbered from the checkpoint's head again.
  effect(2, 5, 0, 'e2', 'fetch', 'unknown'),
  effect(2, 6, 0, 'e2', 'fetch', 'completed', false, [APPLIED]),
  doc(2, 6, 1, 'agentrun.receipts', 'read fetch-args', { tool: 'read' }),
  decisions(2, 6, 2, [ask]),
];
