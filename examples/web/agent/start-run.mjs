#!/usr/bin/env node
// Start one run of the web example's agent: `node examples/web/agent/start-run.mjs <home>/runs/<id>`, on a run that
// `startRun` of @parcha/pi-durable-agent created (the server does that). It runs `pi-durable-disk run --dir
// <home>/runs/<id> --app examples/web/agent/app.ts --serve 0` on loopback, so the run's door address is in its run.json
// (`holder.serve`). SIGTERM or SIGINT goes to the run, which releases its browser and exits 0; starting the same
// directory again resumes it. With `AGENT_BROWSER=chrome` it first starts the run's own Chrome (chrome.ts) and stops it,
// by its pid, once the run has exited. Credentials come from the environment and nothing here prints them.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgentHome, readAgentHome } from '@parcha/pi-durable-agent';
import { browserOf, chromeProfileFor, startChrome } from './chrome.ts';

const [dir] = process.argv.slice(2);
if (!dir || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(basename(resolve(dir)))) {
  console.error('usage: start-run.mjs <home>/runs/<id>   (id: lower-case letters, digits and dashes)');
  process.exit(2);
}
let browser;
try {
  browser = browserOf(process.env);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const needed = ['AGENT_MODEL_BASE_URL', 'AGENT_MODEL', browser === 'chrome' ? 'CHROME_PATH' : 'BROWSERBASE_API_KEY'];
const missing = needed.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`set ${missing.join(', ')} first (see examples/web/agent/README.md)`);
  process.exit(2);
}

const run = resolve(dir);
if (!existsSync(join(run, 'store', 'run.sqlite'))) {
  console.error(`${run} is not a started run: create it with startRun of @parcha/pi-durable-agent first (the server does)`);
  process.exit(2);
}

let chrome = null;
let profile = null;
const env = { ...process.env };
if (browser === 'chrome') {
  const home = resolve(run, '..', '..');
  profile = chromeProfileFor(home, { runId: basename(run), dir: run }, await readAgentHome(await openAgentHome(home)));
  chrome = await startChrome(process.env.CHROME_PATH, profile.dir, { sandbox: process.env.PI_BROWSER_NO_SANDBOX !== '1' });
  Object.assign(env, { AGENT_CHROME_ENDPOINT: chrome.endpoint, AGENT_CHROME_PROFILE: profile.shared ? 'shared' : 'own' });
}

const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@parcha/pi-durable-disk')));
const app = join(import.meta.dirname, 'app.ts');
const child = spawn(process.execPath, [
  '--no-warnings=ExperimentalWarning', cli, 'run', '--dir', run, '--app', app,
  '--serve', '0', '--serve-host', '127.0.0.1', '--drain-timeout', '30s',
], { stdio: 'inherit', env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', async (code, signal) => {
  // The run has let go of its browser; its Chrome goes now. A profile of the run's own holds nothing the agent keeps.
  await chrome?.stop().catch(() => {});
  if (profile && !profile.shared) await rm(profile.dir, { recursive: true, force: true }).catch(() => {});
  process.exit(code ?? (signal ? 1 : 0));
});
