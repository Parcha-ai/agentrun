// The paths a run hands back are paths a program opens: the --json result's dir and recording are the real ones, wherever the run sits, while
// the recording itself still has the machine taken out. The scrub that takes the user name and the home out of what is recorded (a path
// segment named after the user becomes [user], the home ~) once ran over the result too, so a run under a directory holding the user's name, or
// under the home, handed back a path that did not exist. One of the files the reference entry's demo tests are split into; the shared helpers are
// in reference-demo-helpers.mjs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { run } from './reference-demo-helpers.mjs';

const user = userInfo().username;
const skip = user.length < 3 ? 'the scrub takes a user name of three characters or more' : false;
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
const recorded = (recording) => filesUnder(recording).map((file) => readFileSync(file, 'utf8')).join('\n');

/** A fresh directory for one test, removed after it. */
async function scratch(t) {
  const base = await mkdtemp(join(tmpdir(), 'reference-paths-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

test("a run under a directory named after the user hands back its real dir and recording, and its recording still says [user]", { skip, timeout: 300_000 }, async (t) => {
  const under = join(await scratch(t), user, 'tmp');
  mkdirSync(under, { recursive: true });
  // The run's directory and its recording (made under TMPDIR by the helper) both sit below the user's name.
  process.env.TMPDIR = under;
  const dir = join(under, 'run');
  const named = join(under, 'named', 'file.txt');
  const { result, recording } = await run(t, {}, ['--json', '--dir', dir], { DEMO_BASH: `echo "seen ${named}"` });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.equal(result.dir, dir, 'the dir handed back is the one the run used');
  assert.ok(statSync(result.dir).isDirectory(), 'and it opens');
  assert.equal(result.recording, recording);
  assert.ok(existsSync(join(result.recording, 'manifest.json')), 'the recording handed back opens');
  const text = recorded(recording);
  assert.ok(text.includes('[user]'), 'the command named a path below the user: the recording holds it scrubbed');
  assert.ok(!text.includes(`/${user}/`), 'the recording never names the user');
});

test('a run under the home hands back an absolute dir, never one that starts with ~, and its recording still says ~', { timeout: 300_000 }, async (t) => {
  const home = join(await scratch(t), 'home');
  mkdirSync(home, { recursive: true });
  const dir = join(home, 'runs', 'one');
  const named = join(home, 'named', 'file.txt');
  // os.homedir() reads HOME: the scrub maps this home to ~, as it would a user's TMPDIR=~/tmp.
  const { result, recording } = await run(t, {}, ['--json', '--dir', dir], { HOME: home, DEMO_BASH: `echo "seen ${named}"` });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.equal(homedir(), home, 'the run saw this home');
  assert.ok(isAbsolute(result.dir) && !result.dir.startsWith('~'), `an absolute path: ${result.dir}`);
  assert.equal(result.dir, dir);
  assert.ok(statSync(result.dir).isDirectory(), 'and it opens');
  const text = recorded(recording);
  assert.ok(text.includes('seen ~/named/file.txt'), 'the command named a path in the home: the recording holds it as ~');
  assert.ok(!text.includes(home), 'the recording never names the home');
});
