// CI's test shards: `node scripts/ci-shard.mjs <shard>` runs one shard's suites, each in turn, and fails if any failed.
// `rest` runs every workspace suite no other shard names, so a new package is tested without editing this file, and
// `examples-<n>` each run every third file of `npm run test:examples`'s globs, so a new example file is tested too.
// `node scripts/ci-shard.mjs --list` prints each shard's suites.
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';

const shards = {
  transport: { workspaces: ['@parcha/pi-transport'] },
  browser: { workspaces: ['@parcha/pi-browser'] },
  durable: { workspaces: ['@parcha/pi-durable-disk', '@parcha/pi-durable-agent', '@parcha/agentrun-serve'] },
  core: { workspaces: ['@parcha/agentrun-dsl', '@parcha/agentrun-jev', '@parcha/agentrun-pi'] },
  viewer: { scripts: ['test:viewer'] },
  rest: { scripts: ['test:release'] },
};

const examplesScript = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:examples'];
if (!examplesScript.startsWith('node --test ')) throw new Error(`test:examples is no longer a plain node --test: ${examplesScript}`);
const exampleFiles = examplesScript.slice('node --test '.length).split(/\s+/).flatMap((pattern) => globSync(pattern)).sort();
const EXAMPLE_SHARDS = 3;
for (let n = 1; n <= EXAMPLE_SHARDS; n += 1) {
  shards[`examples-${n}`] = { files: exampleFiles.filter((_, index) => index % EXAMPLE_SHARDS === n - 1) };
}

const tested = readdirSync('packages')
  .map((name) => `packages/${name}/package.json`)
  .filter((path) => existsSync(path))
  .map((path) => JSON.parse(readFileSync(path, 'utf8')))
  .filter((manifest) => manifest.scripts?.test)
  .map((manifest) => manifest.name);
const named = new Set(Object.values(shards).flatMap((shard) => shard.workspaces ?? []));
for (const name of named) if (!tested.includes(name)) throw new Error(`shard names ${name}, which has no test script`);
shards.rest.workspaces = tested.filter((name) => !named.has(name));

const commands = (shard) => [
  ...(shard.workspaces ?? []).map((name) => ['npm', 'run', 'test', '-w', name]),
  ...(shard.scripts ?? []).map((script) => ['npm', 'run', script]),
  ...(shard.files?.length ? [[process.execPath, '--test', ...shard.files]] : []),
];

const [wanted] = process.argv.slice(2);
if (wanted === '--list') {
  for (const [name, shard] of Object.entries(shards)) console.log(`${name}: ${commands(shard).map((c) => c.slice(2).join(' ')).join('; ')}`);
  process.exit(0);
}
const shard = shards[wanted];
if (!shard) { console.error(`usage: node scripts/ci-shard.mjs <${Object.keys(shards).join('|')}> | --list`); process.exit(2); }
if (!commands(shard).length) { console.error(`shard ${wanted} has nothing to run`); process.exit(1); }
const failed = [];
for (const command of commands(shard)) {
  console.log(`::group::${command.join(' ')}`);
  const status = spawnSync(command[0], command.slice(1), { stdio: 'inherit' }).status;
  console.log('::endgroup::');
  if (status !== 0) failed.push(command.join(' '));
}
if (failed.length) { console.error(`failed: ${failed.join(', ')}`); process.exit(1); }
