import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('Pi loads the compiled extension with host modules despite competing local dependencies', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-host-compatibility-'));
  const agentDir = join(cwd, 'settings');
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', 'typebox']) {
      const directory = join(cwd, 'node_modules', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', exports: './index.js' }));
      await writeFile(join(directory, 'index.js'), 'throw new Error("Extension imported its own core dependency instead of the Pi host");');
    }
    const extensionPath = join(cwd, 'extension.js');
    const nativeExtension = new URL('../dist/extension.js', import.meta.url).pathname;
    await writeFile(extensionPath, `import { Agent } from '@earendil-works/pi-agent-core';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import agentRun from ${JSON.stringify(nativeExtension)};
export default function (pi) {
  pi.registerCommand('host-identities', { description: 'Offline compatibility probe', handler: async () => ({ Agent, createReadTool, Type }) });
  agentRun(pi);
}
`);
    await mkdir(agentDir);
    const loader = new DefaultResourceLoader({ cwd, agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir), additionalExtensionPaths: [extensionPath],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload({ resolveProjectTrust: async () => true });
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    const identities = await extension.commands.get('host-identities').handler('', {});
    const agent = new identities.Agent({ streamFn: () => { throw new Error('Transport must not run'); } });
    assert.equal(agent.state.isStreaming, false);
    assert.deepEqual(identities.Type.String(), { type: 'string' });
    await writeFile(join(cwd, 'note.txt'), 'Loaded through the Pi host.');
    const read = identities.createReadTool(cwd);
    const result = await read.execute('compatibility-read', { path: 'note.txt' });
    assert.deepEqual(result.content, [{ type: 'text', text: 'Loaded through the Pi host.' }]);
    assert.ok(extension.tools.has('agentrun'));
    const messages = [], branch = [];
    Object.assign(loaded.runtime, { getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => 'off', sendMessage: message => messages.push(message),
      appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data: structuredClone(data) }) });
    const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => 'host-compatibility', getBranch: () => branch, getSessionFile: () => undefined } };
    try {
      await extension.commands.get('agentrun').handler('demo', ctx);
      assert.equal(messages.at(-1).details.status, 'complete');
      assert.equal(messages.at(-1).details.mode, 'scripted');
    } finally {
      for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({}, ctx);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
