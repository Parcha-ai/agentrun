// One process of the two-process refresh test. It sends OpenAI's hosts to the parent's fake, signals that it is ready,
// waits for the parent's go, resolves the model (which refreshes the expired sign-in under the store's lock), and prints
// when it started and finished and a hash of the key it got: never the key.
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redirect } from './fake-openai.mjs';

const [home, barrier, name] = process.argv.slice(2);
globalThis.fetch = redirect(process.env.FAKE_OPENAI_BASE, process.env.FAKE_OPENAI_SECRET);
const { resolveModel } = await import('@parcha/agentrun-pi/signin');
writeFileSync(join(barrier, `ready-${name}`), '');
while (!existsSync(join(barrier, 'go'))) await new Promise((done) => setTimeout(done, 5));
const started = Date.now();
const resolved = await resolveModel({ name: 'refresh', models: { lead: { needs: ['text'] } }, keys: [], programs: [], expectedCalls: 1, expectedCost: 0 }, { home, env: {} });
const key = await resolved.getApiKey();
process.stdout.write(JSON.stringify({ started, finished: Date.now(), key: createHash('sha256').update(key).digest('hex') }));
