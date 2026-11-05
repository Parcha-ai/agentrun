// CI's test shards: `node scripts/ci-shard.mjs <shard>` runs one shard's tests, a command per suite, and fails if any
// failed. scripts/ci-plan.mjs names the shards (`<pool>-<k>`, the pools in scripts/ci-shards.json) and assigns each suite's
// files to them by time; every shard job plans every shard and fails unless they cover every test file once, so a new
// package or test file is tested without editing this file. `node scripts/ci-shard.mjs --list` prints each shard's
// commands.
//
// Two limits make a stall fail by name, its log kept, before the test job's 30 minutes (ci.yml) cancel it:
// - A `node --test` a shard runs gets --test-timeout, 10 min (CI_SHARD_TEST_TIMEOUT_MS), unless its script sets its own.
//   On Node 24 a test still running then fails, named; Node 22 applies the flag to each test file instead, and names the
//   file. On main's CI the slowest test takes 45 s and the slowest file (serve's recovery.test.mjs) 4 min. A test's own
//   `timeout` holds on Node 24. The kill below names no test: on SIGTERM node --test 24 names the file still running, and
//   22 nothing.
// - A shard's suites get 24 min in all (CI_SHARD_TIMEOUT_MS): the suite still running then is killed with every process it
//   started, those after it are not run, and an ::error:: line names each. This catches a suite whose tests all end but
//   whose process stays alive. The slowest shard takes 5 min; the steps before this one, up to 3.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:os';
import { commandsOf, testShards, timingDrift } from './ci-plan.mjs';

const limit = (name, fallback) => {
  const value = process.env[name] ?? String(fallback);
  if (!/^[1-9]\d*$/.test(value)) { console.error(`${name} is a whole number of milliseconds, not "${value}"`); process.exit(2); }
  return Number(value);
};
const TEST_TIMEOUT_MS = limit('CI_SHARD_TEST_TIMEOUT_MS', 10 * 60_000);
const SHARD_TIMEOUT_MS = limit('CI_SHARD_TIMEOUT_MS', 24 * 60_000);

let shards;
try { shards = testShards(process.cwd()); } catch (error) { console.error(`ci-shard: ${error.message}`); process.exit(1); }
const commands = (shard) => commandsOf(shard.suites, shard.units, { timeoutMs: TEST_TIMEOUT_MS }).map(({ command }) => command);
// A command as the log shows it, one a shell runs as it is.
const shown = (command) => command.map((arg) => (arg === process.execPath ? 'node' : /\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');

const [wanted] = process.argv.slice(2);
if (wanted === '--list') {
  for (const [name, shard] of Object.entries(shards)) console.log(`${name} (${shard.seconds} s modelled): ${commands(shard).map(shown).join('; ')}`);
  process.exit(0);
}
const shard = shards[wanted];
if (!shard) { console.error(`usage: node scripts/ci-shard.mjs <${Object.keys(shards).join('|')}> | --list`); process.exit(2); }
if (!commands(shard).length) { console.error(`shard ${wanted} has nothing to run`); process.exit(1); }
console.log(`ci-shard: ${wanted} runs ${shard.units.length} test files and suites, ${shard.seconds} s modelled`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A signal to a command's process group; false when nothing in it is left.
const signalGroup = (pid, signal) => { try { process.kill(-pid, signal); return true; } catch { return false; } };

// The command runs in a process group of its own, so a kill reaches every process it started (npm, its shell, node --test
// and each test file's process), not npm alone, which would leave the suite running. Its exit status, or 'killed' when it
// was still running after `ms`.
async function run(command, ms) {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true });
  // The one way a command is stopped, by the limit or by a cancel: `signal` to its group (on SIGTERM node --test prints its
  // summary), SIGKILL to what is left 10 s on. Begun once; a second caller waits on the first.
  let stopping;
  const stop = (signal) => (stopping ??= (async () => {
    signalGroup(child.pid, signal);
    for (const until = Date.now() + 10_000; Date.now() < until && signalGroup(child.pid, 0);) await sleep(100);
    signalGroup(child.pid, 'SIGKILL');
  })());
  // A Ctrl-C or a cancel that reaches this process stops the command, which no longer shares its process group, then ends
  // this process with the signal's status; nothing after it runs.
  let cancelled;
  const forward = (signal) => { cancelled ??= stop(signal).then(() => process.exit(128 + constants.signals[signal])); };
  process.on('SIGINT', forward).on('SIGTERM', forward);
  let timer;
  const status = await Promise.race([once(child, 'exit').then(([code]) => code), new Promise((resolve) => { timer = setTimeout(resolve, ms, 'killed'); })]);
  clearTimeout(timer);
  if (status === 'killed') await stop('SIGTERM');
  if (cancelled) await cancelled;
  process.off('SIGINT', forward).off('SIGTERM', forward);
  return status;
}

const minutes = (ms) => Number((ms / 60_000).toFixed(1));
const ends = Date.now() + SHARD_TIMEOUT_MS;
const failed = [];
const shardStarted = Date.now();
for (const command of commands(shard)) {
  if (Date.now() >= ends) {
    console.log(`::error::ci-shard: ${shown(command)} was not run: the shard's ${minutes(SHARD_TIMEOUT_MS)}-minute limit had passed`);
    failed.push(shown(command));
    continue;
  }
  console.log(`::group::${shown(command)}`);
  const started = Date.now();
  const status = await run(command, ends - started);
  console.log('::endgroup::');
  if (status === 'killed') console.log(`::error::ci-shard: ${shown(command)} ran ${minutes(Date.now() - started)} min and was killed at the shard's ${minutes(SHARD_TIMEOUT_MS)}-minute limit`);
  if (status !== 0) failed.push(shown(command));
}
// Its time against its model, whatever the result: a shard far over it means scripts/ci-timings.json is stale.
const took = Math.round((Date.now() - shardStarted) / 1000);
console.log(`ci-shard: ${wanted} ran ${took} s, modelled ${shard.seconds} s`);
const drift = timingDrift(wanted, shard.seconds, took);
if (drift) console.log(drift);
if (failed.length) { console.error(`failed: ${failed.join(', ')}`); process.exit(1); }
