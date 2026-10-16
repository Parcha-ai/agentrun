import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDemo, demoDirs } from './check-setup-prompts.mjs';

const script = fileURLToPath(new URL('./check-setup-prompts.mjs', import.meta.url));
const SPEC = {
  name: 'disk', models: { lead: { needs: ['text', 'tools'] } },
  keys: [
    { env: 'STORE_API_KEY', why: 'the disk service', where: 'its console', required: true, for: 'live' },
    { env: 'STORE_DISK', why: 'the disk', where: 'its console', required: true, for: 'live' },
  ],
  programs: [{ cmd: 'node', why: 'runs the demo', required: true }, { cmd: 'mounter', why: 'mounts the disk', required: true, platforms: ['linux'], for: 'live' }],
  expectedCalls: 10, expectedCost: 0.15,
};
const PROMPT = 'Set `STORE_API_KEY` and `STORE_DISK`.\n\n**You run this yourself:** `sudo apt install mounter fuse3`, then `sudo visudo -cf /tmp/x` and `fusermount -u`.\n\nCheck: `node --version`.\n';

async function examples(t, demos) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-setup-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, { spec, prompt }] of Object.entries(demos)) {
    await mkdir(join(root, name), { recursive: true });
    if (spec) await writeFile(join(root, name, 'demo.json'), JSON.stringify(spec));
    if (prompt !== undefined) await writeFile(join(root, name, 'SETUP-PROMPT.md'), prompt);
  }
  return root;
}

test('a demo passes when its prompt names its spec, and the command words of its own steps are not programs', async t => {
  const root = await examples(t, { disk: { spec: SPEC, prompt: PROMPT }, notes: { prompt: 'not a demo' } });
  assert.deepEqual(demoDirs(root), [join(root, 'disk')], 'only directories with a demo.json');
  assert.deepEqual(checkDemo(join(root, 'disk')), []);
});

test('a spec key missing from the prompt, an extra credential, or no prompt at all fails, and the script exits 1', async t => {
  const root = await examples(t, {
    dropped: { spec: SPEC, prompt: PROMPT.replace(' and `STORE_DISK`', '') },
    extra: { spec: SPEC, prompt: `${PROMPT}Also export \`OTHER_API_KEY\`.\n` },
    bare: { spec: SPEC },
    good: { spec: SPEC, prompt: PROMPT },
  });
  assert.deepEqual(checkDemo(join(root, 'dropped')), ['the spec needs STORE_DISK, and the prompt never names it']);
  assert.deepEqual(checkDemo(join(root, 'extra')), ['the prompt names OTHER_API_KEY, which the spec does not list']);
  assert.deepEqual(checkDemo(join(root, 'bare')), ['SETUP-PROMPT.md is missing']);
  const run = spawnSync(process.execPath, [script, ...demoDirs(root)], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /4 demo specs checked, 3 failed\n$/);
  assert.equal(spawnSync(process.execPath, [script, join(root, 'good')], { encoding: 'utf8' }).status, 0);
});

test('the repository\'s own demos match their prompts', () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
