// The box's start probe (host/box-bwrap.ts probeBox) on this host, for the CI job that installs the box: prints what the
// probe found, and exits 1 unless it is the mode given. Written for AgentRun.
//   node scripts/box-probe.mjs --expect bwrap|unavailable
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeBox } from '../dist/host/index.js';

const at = process.argv.indexOf('--expect');
const expect = at < 0 ? undefined : process.argv[at + 1];
if (expect !== 'bwrap' && expect !== 'unavailable') {
  process.stderr.write('usage: node scripts/box-probe.mjs --expect bwrap|unavailable\n');
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), 'box-probe-'));
try {
  const found = await probeBox({ scratch });
  process.stdout.write(`${JSON.stringify(found)}\n`);
  if (found.mode !== expect) {
    process.stderr.write(`box-probe: expected ${expect}, the probe found ${found.mode}\n`);
    process.exitCode = 1;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
