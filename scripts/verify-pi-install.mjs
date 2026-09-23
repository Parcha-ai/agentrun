// Executed from an empty consumer containing only the packed release artifacts.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager, ModelRuntime, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from '@earendil-works/pi-ai';
const cwd = process.cwd();
const agentDir = resolve(cwd, 'isolated-pi-settings');
await mkdir(agentDir, { recursive: true });
const settingsManager = SettingsManager.create(cwd, agentDir);
const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
await packages.installAndPersist(resolve('node_modules/@parcha/agentrun-pi'), { local: true });
await settingsManager.flush();
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
await loader.reload({ resolveProjectTrust: async () => true });
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert(extension.commands.has('agentrun'));
assert(extension.tools.has('agentrun'));
assert(loader.getSkills().skills.some(skill => skill.name === 'agentrun-author'));
const messages = [];
Object.assign(loaded.runtime, {
  getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => 'off',
  sendMessage: message => messages.push(message),
});
const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => 'installed-smoke' } };
const command = extension.commands.get('agentrun');
await command.handler('demo', ctx);
assert.equal(messages.at(-1).details.status, 'complete');
assert.equal(messages.at(-1).details.mode, 'scripted');
assert(messages.some(message => /plan/.test(message.content)));
await command.handler('', ctx);
assert.match(messages.at(-1).content, /plan/);
await command.handler('demo empty', ctx);
assert.equal(messages.at(-1).details.status, 'escalated');
for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({}, ctx);


const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const faux = fauxProvider({ tokensPerSecond: Infinity });
let skillExpanded = false;
faux.setResponses([transcript => {
  const text = JSON.stringify(transcript.messages);
  assert.match(text, /<skill name=\\"agentrun-author\\"/);
  assert.match(text, /References are relative to/);
  assert.match(text, /Inspect, then execute/);
  assert.match(text, /Read the release notes/);
  skillExpanded = true;
  return fauxAssistantMessage('Skill loaded.');
}]);
runtime.registerNativeProvider(faux.provider);
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader,
  modelRuntime: runtime, model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd), noTools: 'all' });
try {
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const unsubscribe = session.subscribe(event => { if (event.type === 'agent_end') finish(); });
  const timer = setTimeout(() => finish(), 10_000);
  try {
    await session.prompt('/agentrun Read the release notes');
    await completed;
    assert.equal(skillExpanded, true);
  } finally { clearTimeout(timer); unsubscribe(); }
} finally { session.dispose(); }
console.log(JSON.stringify({ discovery: true, skill: true, nativeSkillExpansion: true, demo: 'complete', empty: 'escalated', network: 'prohibited' }));
