// Cuts the nested shape's recording fixture from a recording of examples/fixtures/graph-nested/run.ts: its durable lines of the workflow's own
// documents (the driver's record, the map items, their states, the effects, the task), with every clock fixed so the bytes hold
// no time, pid or path. Run: node examples/fixtures/graph-nested/run.ts --kill --record <dir> && node test/fixtures/graph/record.mjs <dir>
// It writes nested.recording.jsonl beside this file. The recording of a killed process keeps what that process's store
// committed before it died, so two recordings of the same run can differ by the one commit that was in flight at the kill.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLOCK = 1792000000000;
const ISO = '2026-10-15T00:00:00.000Z';
const fixed = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1e12 ? CLOCK : value;
  if (typeof value === 'string') return /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) ? ISO : value;
  if (Array.isArray(value)) return value.map(fixed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fixed(item)]));
  return value;
};

/** The fixture's lines from a recording's `events.jsonl` text. */
export function cut(text) {
  const kept = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => line.channel === 'durable' && line.source === 'workflow' && line.data && typeof line.data === 'object' && typeof line.data.doc === 'string' && line.data.doc.startsWith('agentrun.'));
  return kept.map((line, index) => {
    const { blobs, ...rest } = line;
    void blobs;
    return JSON.stringify(fixed({ ...rest, t: index }));
  }).join('\n') + '\n';
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (!dir) throw new Error('usage: node record.mjs <recording directory>');
  const out = fileURLToPath(new URL('./nested.recording.jsonl', import.meta.url));
  writeFileSync(out, cut(readFileSync(`${dir}/events.jsonl`, 'utf8')));
  console.log(`wrote ${out}`);
}
