// What the agent's commands see of the host's environment: a live run's keys stay in the host, and its bash tool and code mode's tools.bash get
// PATH, HOME, TMPDIR and LANG only. One of the files the reference entry's demo tests are split into; the shared helpers are in reference-demo-helpers.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { filesIn, run } from './reference-demo-helpers.mjs';

const names = (text) => new Set(text.split('\n').map((line) => line.split('=')[0]).filter(Boolean));

test('a live run\'s keys never reach the agent\'s commands: bash and code mode see PATH, HOME and TMPDIR and no declared value, and the recording holds none', { timeout: 300_000 }, async (t) => {
  const canary = `canary-${randomUUID()}`;
  const keys = [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }]];
  // The fixture's own settings reach a live child only when the demo declares them.
  const programs = ['DEMO_SPEC', 'DEMO_LIVE_PROBE', 'DEMO_CODE', 'DEMO_CODE_ON', 'DEMO_BASH'].map((env) => ({ name: `fixture ${env}`, env }));
  const env = {
    DEMO_LIVE_PROBE: '1', BROWSERBASE_API_KEY: canary, BROWSERBASE_PROJECT_ID: `${canary}-project`,
    // Into files only: a command's output is in the transcript, and the recorder refuses one that names this machine's paths.
    DEMO_BASH: 'printenv > bash-env.txt', DEMO_CODE_ON: '1', DEMO_CODE: 'await tools.bash({ command: "printenv > code-env.txt" }); return 1;',
  };
  const { result, recording } = await run(t, { keys, programs }, ['--json', '--live'], env);
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const child = new Set(JSON.parse(readFileSync(join(result.dir, 'env-seen.json'), 'utf8')));
  assert.ok(child.has('BROWSERBASE_API_KEY'), 'the host process holds the declared key, for its own calls');
  for (const file of ['bash-env.txt', 'code-env.txt']) {
    const text = readFileSync(join(result.dir, 'work', file), 'utf8');
    assert.ok(!text.includes(canary), `${file}: no declared value reaches the command`);
    const seen = names(text);
    for (const name of [...child].filter((name) => name.startsWith('DEMO_') || name.startsWith('BROWSERBASE_'))) assert.ok(!seen.has(name), `${file}: ${name} is not in the command's environment`);
    // The positive control: a command still finds its programs and its temporary directory.
    for (const name of ['PATH', 'HOME', 'TMPDIR', ...(child.has('LANG') ? ['LANG'] : [])]) assert.ok(seen.has(name), `${file}: ${name} is in the command's environment`);
  }
  for (const file of filesIn(recording)) assert.ok(!readFileSync(file).includes(canary), `the recording's ${file} holds no declared value`);
});
