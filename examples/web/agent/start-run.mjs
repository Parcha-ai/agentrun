#!/usr/bin/env node
// Start one run of the web example's agent: `node examples/web/agent/start-run.mjs <home>/runs/<id>`, on a run that
// `startRun` of @parcha/pi-durable-agent created (the server does that). It runs `pi-durable-disk run --dir
// <home>/runs/<id> --app examples/web/agent/app.ts --serve 0` on loopback, so the run's door address is in its run.json
// (`holder.serve`). SIGTERM or SIGINT goes to the run, which releases its browser and exits 0; starting the same
// directory again resumes it. Credentials come from the environment and nothing here prints them.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir] = process.argv.slice(2);
if (!dir || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(basename(resolve(dir)))) {
  console.error('usage: start-run.mjs <home>/runs/<id>   (id: lower-case letters, digits and dashes)');
  process.exit(2);
}
const missing = ['BROWSERBASE_API_KEY', 'AGENT_MODEL_BASE_URL', 'AGENT_MODEL'].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`set ${missing.join(', ')} first (see examples/web/agent/README.md)`);
  process.exit(2);
}

const run = resolve(dir);
if (!existsSync(join(run, 'store', 'run.sqlite'))) {
  console.error(`${run} is not a started run: create it with startRun of @parcha/pi-durable-agent first (the server does)`);
  process.exit(2);
}
const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@parcha/pi-durable-disk')));
const app = join(import.meta.dirname, 'app.ts');
const child = spawn(process.execPath, [
  '--no-warnings=ExperimentalWarning', cli, 'run', '--dir', run, '--app', app,
  '--serve', '0', '--serve-host', '127.0.0.1', '--drain-timeout', '30s',
], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
