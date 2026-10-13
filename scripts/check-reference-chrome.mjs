#!/usr/bin/env node
// Runs the reference job against a real Chrome (`examples/reference/run.ts --json --chrome`, Chrome at CHROME_PATH) and checks
// the record and the ledger against examples/reference/expected.json. The whole value is not compared: the browser's receipt
// name hashes the session, which differs per run, and so do the token counts of what it cites.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const readName = /^evidence\/investigate\/browser_read-[0-9a-f]{12}\.json$/;

/** The problems with a real-Chrome run's value against the fixed one; `[]` when it matches where it must. */
export function compareChromeRecord(actual, expected) {
  const problems = [];
  const same = (what, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}: ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
  same('status', actual.status, expected.status);
  const { citations: _a, ...record } = actual.output ?? {};
  const { citations: _e, ...fixed } = expected.output;
  same('output', record, fixed);
  same('evidence count', actual.evidence?.length, expected.evidence.length);
  if (!readName.test(actual.evidence?.[0] ?? '')) problems.push(`the browser receipt is not named like one: ${actual.evidence?.[0]}`);
  same('the look receipt', actual.evidence?.[1], expected.evidence[1]);
  same('citations are the receipts filed', actual.output?.citations, actual.evidence);
  same('what each package did', actual.did, expected.did);
  same('each fake called once', actual.ledger?.calls, expected.ledger.calls);
  return problems;
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'reference-chrome-'));
  try {
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}) };
    const ran = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', 'examples/reference/run.ts', '--json', '--chrome'], { cwd: root, env, encoding: 'utf8', timeout: 180_000 });
    assert.equal(ran.status, 0, `The reference job with Chrome exited ${ran.status}: ${ran.stderr.slice(-2000)}`);
    const problems = compareChromeRecord(JSON.parse(ran.stdout), JSON.parse(readFileSync(join(root, 'examples/reference/expected.json'), 'utf8')));
    if (problems.length) throw new Error(`The reference job with Chrome differs from the expected record:\n${problems.join('\n')}`);
    console.log('The reference job with a real Chrome printed the expected record and ledger.');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
