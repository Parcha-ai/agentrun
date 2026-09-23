import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AUTHOR_SKILL_NAME, authorContract, authorSkillDirectory, loadAuthorReference, renderAuthorHostAddendum } from '@parcha/agentrun-dsl';
import { PI_HOST_ADDENDUM } from '../dist/index.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const addendumSentences = [
  '## Host: Pi extension',
  'Code nodes and mutating tools run only after the user issues /agentrun run --trusted for that run.',
  'This extension supplies no SOP text',
  'Shell and executor calls and artifact delivery are unavailable.',
];

test('a bare Pi session reads the skill rendered with the Pi addendum, without calling describe', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-pi-skill-'));
  try {
    const agentDir = join(cwd, 'pi-settings');
    const settingsManager = SettingsManager.create(cwd, agentDir);
    await new DefaultPackageManager({ cwd, agentDir, settingsManager }).installAndPersist(packageRoot, { local: true });
    await settingsManager.flush();
    // The same loader createAgentSession uses; no session is bound and no extension event runs.
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
    await loader.reload({ resolveProjectTrust: async () => true });
    const skills = loader.getSkills().skills.filter(skill => skill.name === AUTHOR_SKILL_NAME);
    assert.equal(skills.length, 1, 'exactly one author skill is registered');
    const body = await readFile(skills[0].filePath, 'utf8');
    for (const sentence of addendumSentences) assert.ok(body.includes(sentence), sentence);
    assert.ok(body.endsWith(`${renderAuthorHostAddendum(PI_HOST_ADDENDUM)}\n`), 'the addendum is rendered once, after the skill');
    const language = await readFile(join(skills[0].filePath, '..', 'references', 'language.md'), 'utf8');
    assert.ok(language.includes(authorContract({ host: PI_HOST_ADDENDUM })), 'the language reference is the Pi-rendered contract');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('the dsl package skill stays host-neutral', async () => {
  const neutral = await readFile(join(authorSkillDirectory(), 'SKILL.md'), 'utf8') + loadAuthorReference('language');
  for (const sentence of addendumSentences) assert.ok(!neutral.includes(sentence), sentence);
  assert.doesNotMatch(neutral, /\/agentrun run --trusted|Pi extension/);
  assert.ok(loadAuthorReference('language').includes(authorContract()));
});
