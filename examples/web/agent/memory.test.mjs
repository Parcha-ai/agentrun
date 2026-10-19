// The agent's memory between runs, the downloads folder its Chrome saves into, and the "What I remember" page: the host's
// side, offline, on plain directories.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareProfile } from './chrome.ts';
import { EMPTY_INDEX, keepMemory, MAX_MEMORY_BYTES, MAX_MEMORY_FILE_BYTES, readMemory, seedMemory } from './memory.ts';
import { REMEMBER_PAGE, rememberHtml, writeRememberPage } from './remember.ts';

async function dirs(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'web-memory-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, 'home');
  const work = join(tmp, 'run', 'work');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  return { tmp, home, work };
}
const OWNER = { changed: true, profiles: ['local-chrome'], released: [] };
const write = async (dir, files) => { await mkdir(dir, { recursive: true }); for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text); };

test('a new run starts with the home\'s memory folder in its workspace; a resumed run keeps its own; a home with none gives an index that says so, and the agent\'s files go home', async (t) => {
  const { home, work } = await dirs(t);
  assert.equal(await seedMemory(home, work), 1, 'a first run');
  assert.deepEqual(readdirSync(join(work, 'memory')), ['index.md']);
  assert.equal(readFileSync(join(work, 'memory', 'index.md'), 'utf8'), EMPTY_INDEX);
  // The agent keeps something: it replaces the index and adds a file, and the owner's carry back takes them home.
  await write(join(work, 'memory'), { 'index.md': '- preferences.md: how\n', 'preferences.md': '- Amount and due date only\n' });
  assert.deepEqual(await keepMemory(home, work, OWNER), { written: ['index.md', 'preferences.md'], removed: [] });
  await rm(join(home, 'memory'), { recursive: true });
  await rm(join(work, 'memory'), { recursive: true });
  await write(join(home, 'memory'), { 'index.md': '- preferences.md: how\n', 'preferences.md': '- Amount and due date only\n' });
  assert.equal(await seedMemory(home, work), 2);
  assert.deepEqual(readdirSync(join(work, 'memory')).sort(), ['index.md', 'preferences.md']);
  assert.equal(readFileSync(join(work, 'memory', 'preferences.md'), 'utf8'), '- Amount and due date only\n');
  writeFileSync(join(work, 'memory', 'preferences.md'), '- Changed in this run\n');
  assert.equal(await seedMemory(home, work), 0, 'a resumed run has its own folder');
  assert.equal(readFileSync(join(work, 'memory', 'preferences.md'), 'utf8'), '- Changed in this run\n');
});

test('only the run that owns the sign-in writes the home\'s memory: each file whole and owner-only, a removed file removed, nothing over the caps or not a memory file', async (t) => {
  const { home, work } = await dirs(t);
  // A permissive umask, so owner-only is the code's doing and not the process's.
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  assert.deepEqual(await readMemory(home), []);
  await write(join(work, 'memory'), { 'index.md': '- accounts.md\n- preferences.md\n', 'accounts.md': '- the utility account\n', 'preferences.md': '- Flag anything over 100\n' });
  for (const back of [undefined, { changed: false, profiles: ['local-chrome'], released: [] }, { changed: true, profiles: [], released: [] }]) {
    assert.equal(await keepMemory(home, work, back), null, `not for ${JSON.stringify(back)}`);
  }
  assert.equal(existsSync(join(home, 'memory')), false);
  await mkdir(join(home, 'memory'), { mode: 0o755 });
  assert.deepEqual(await keepMemory(home, work, OWNER), { written: ['accounts.md', 'index.md', 'preferences.md'], removed: [] }, 'the run that made or carried back the sign-in');
  assert.deepEqual((await readMemory(home)).map((file) => file.name), ['accounts.md', 'index.md', 'preferences.md']);
  assert.equal(statSync(join(home, 'memory')).mode & 0o777, 0o700);
  for (const name of readdirSync(join(home, 'memory'))) assert.equal(statSync(join(home, 'memory', name)).mode & 0o777, 0o600, name);

  // The next owner changed one file and dropped another: only those move, and nothing partial is left.
  await rm(join(work, 'memory', 'accounts.md'));
  writeFileSync(join(work, 'memory', 'preferences.md'), '- Flag anything over 100\n- Newest first\n');
  assert.deepEqual(await keepMemory(home, work, { changed: true, profiles: [], released: ['local-chrome'] }), { written: ['preferences.md'], removed: ['accounts.md'] });
  assert.deepEqual(readdirSync(join(home, 'memory')).sort(), ['index.md', 'preferences.md']);

  // Refused whole, the home unchanged: a file over its cap, the folder over its cap, a name that is no memory file, a link.
  const kept = JSON.stringify(await readMemory(home));
  for (const [what, make] of [
    ['a file over its cap', () => writeFileSync(join(work, 'memory', 'big.md'), 'x'.repeat(MAX_MEMORY_FILE_BYTES + 1))],
    ['the folder over its cap', () => { for (let i = 0; i < 5; i++) writeFileSync(join(work, 'memory', `part-${i}.md`), 'x'.repeat(MAX_MEMORY_BYTES / 4)); }],
    ['a name that is no memory file', () => writeFileSync(join(work, 'memory', 'notes.txt'), 'x')],
    ['a link', () => symlinkSync('/etc/hostname', join(work, 'memory', 'link.md'))],
  ]) {
    await rm(join(work, 'memory'), { recursive: true });
    await write(join(work, 'memory'), { 'index.md': '- one\n' });
    make();
    assert.equal(await keepMemory(home, work, OWNER), null, what);
    assert.equal(JSON.stringify(await readMemory(home)), kept, `${what}: the home keeps what it had`);
  }
  await rm(join(work, 'memory'), { recursive: true });
  assert.equal(await keepMemory(home, work, OWNER), null, 'a run with no folder changes nothing');
  assert.equal(JSON.stringify(await readMemory(home)), kept);
});

test('each run\'s Chrome saves downloads into that run\'s workspace without asking: the folder is set again for every run, and the profile\'s other settings stay', async (t) => {
  const { tmp } = await dirs(t);
  const profile = join(tmp, 'profile');
  await mkdir(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: '/old/place', prompt_for_download: true, directory_upgrade: true }, session: { restore_on_startup: 4 }, kept: 1 }));
  const prefs = () => JSON.parse(readFileSync(join(profile, 'Default', 'Preferences'), 'utf8'));
  for (const run of ['run-1', 'run-2']) {
    const downloads = join(tmp, run, 'work', 'downloads');
    await prepareProfile(profile, { downloads });
    assert.deepEqual(prefs().download, { default_directory: downloads, prompt_for_download: false, directory_upgrade: true });
    assert.ok(statSync(downloads).isDirectory());
  }
  assert.deepEqual([prefs().session.restore_on_startup, prefs().kept], [1, 1]);
  await prepareProfile(profile);
  assert.equal(prefs().download.default_directory, join(tmp, 'run-2', 'work', 'downloads'), 'without a folder, the download settings are left alone');
});

test('"What I remember" sits beside the report: the sites by host and when they were checked, each memory file with its text, the runs; no ref, no script, nothing loaded', async (t) => {
  const { work } = await dirs(t);
  // A profile as the store holds it, ref included: the page takes its sites and time only.
  const signIns = [{ sites: ['https://bills.example', 'not a site'], verifiedAt: '2026-10-19T22:00:00.000Z', ref: 'ctx-secret-ref' }];
  const runs = [{ startedAt: '2026-10-19T21:00:00.000Z', outcome: 'completed' }, { startedAt: '2026-10-19T22:00:00.000Z', outcome: null }];
  assert.equal(await writeRememberPage(work, { signIns, runs }), false, 'no report, no page');
  await mkdir(join(work, 'report'));
  writeFileSync(join(work, 'report', 'index.html'), '<p>report</p>');
  await write(join(work, 'memory'), { 'preferences.md': '- Flag anything over 100 <b>\n', 'index.md': '- preferences.md\n', '.hidden': 'x' });
  assert.equal(await writeRememberPage(work, { signIns, runs }), true);
  const page = readFileSync(join(work, 'report', REMEMBER_PAGE), 'utf8');
  assert.match(page, /<li>bills\.example, checked 2026-10-19T22:00:00\.000Z<\/li>/);
  assert.match(page, /<h3>index\.md<\/h3>\n<pre>- preferences\.md<\/pre>\n<h3>preferences\.md<\/h3>\n<pre>- Flag anything over 100 &lt;b&gt;<\/pre>/);
  assert.match(page, /<li>2026-10-19T21:00:00\.000Z, completed<\/li>\n<li>2026-10-19T22:00:00\.000Z, this run<\/li>/);
  assert.doesNotMatch(page, /<script|\son[a-z]+=|https?:|ctx-secret-ref|not a site|hidden/i);
  assert.match(page, /<a href="index\.html">/);
  assert.match(rememberHtml({ signIns: [], memory: [], runs: [] }), /No site\.[\s\S]*Nothing yet\.[\s\S]*None\./);
});
