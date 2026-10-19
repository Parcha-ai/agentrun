// The agent's preferences between runs, the downloads folder its Chrome saves into, and the "What I remember" page:
// the host's side, offline, on plain directories.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareProfile } from './chrome.ts';
import { keepPreferences, MAX_PREFERENCES_BYTES, readPreferences, seedPreferences } from './preferences.ts';
import { REMEMBER_PAGE, rememberHtml, writeRememberPage } from './remember.ts';

async function dirs(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'web-prefs-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, 'home');
  const work = join(tmp, 'run', 'work');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  return { tmp, home, work };
}
const OWNER = { changed: true, profiles: ['local-chrome'], released: [] };

test('a new run starts with the home\'s preferences in its workspace; a resumed run keeps its own; a home with none seeds nothing', async (t) => {
  const { home, work } = await dirs(t);
  assert.equal(await seedPreferences(home, work), false);
  assert.equal(existsSync(join(work, 'preferences.md')), false);
  writeFileSync(join(home, 'preferences.md'), '- Newest first\n');
  assert.equal(await seedPreferences(home, work), true);
  assert.equal(readFileSync(join(work, 'preferences.md'), 'utf8'), '- Newest first\n');
  writeFileSync(join(work, 'preferences.md'), '- Newest first\n- PDF only\n');
  assert.equal(await seedPreferences(home, work), false, 'a resumed run has its own file');
  assert.equal(readFileSync(join(work, 'preferences.md'), 'utf8'), '- Newest first\n- PDF only\n');
});

test('only the run that owns the sign-in writes the home\'s preferences, whole and owner-only, within the size cap', async (t) => {
  const { home, work } = await dirs(t);
  assert.equal(await readPreferences(home), null);
  writeFileSync(join(work, 'preferences.md'), '- PDF only\n');
  for (const back of [undefined, { changed: false, profiles: ['local-chrome'], released: [] }, { changed: true, profiles: [], released: [] }]) {
    assert.equal(await keepPreferences(home, work, back), false, `not for ${JSON.stringify(back)}`);
  }
  assert.equal(await readPreferences(home), null);
  assert.equal(await keepPreferences(home, work, OWNER), true, 'the run that made or carried back the sign-in');
  assert.equal(await readPreferences(home), '- PDF only\n');
  assert.equal(statSync(join(home, 'preferences.md')).mode & 0o777, 0o600);
  assert.equal(await keepPreferences(home, work, { changed: true, profiles: [], released: ['local-chrome'] }), true, 'the run that held the save lease');
  assert.deepEqual(readdirSync(home), ['preferences.md'], 'no partial file is left');

  writeFileSync(join(work, 'preferences.md'), 'x'.repeat(MAX_PREFERENCES_BYTES + 1));
  assert.equal(await keepPreferences(home, work, OWNER), false, 'over the cap');
  assert.equal(await readPreferences(home), '- PDF only\n', 'the home keeps what it had');
  await rm(join(work, 'preferences.md'));
  assert.equal(await keepPreferences(home, work, OWNER), false, 'a run with no file changes nothing');
  assert.equal(await readPreferences(home), '- PDF only\n');
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

test('"What I remember" sits beside the report: the sites by host and when they were checked, the preferences, no ref, no script, nothing loaded', async (t) => {
  const { work } = await dirs(t);
  // A profile as the store holds it, ref included: the page takes its sites and time only.
  const signIns = [{ sites: ['https://bills.example', 'not a site'], verifiedAt: '2026-10-19T22:00:00.000Z', ref: 'ctx-secret-ref' }];
  assert.equal(await writeRememberPage(work, { signIns }), false, 'no report, no page');
  await mkdir(join(work, 'report'));
  writeFileSync(join(work, 'report', 'index.html'), '<p>report</p>');
  writeFileSync(join(work, 'preferences.md'), '# Preferences\n- Newest first <b>\n\n* PDF only\n');
  assert.equal(await writeRememberPage(work, { signIns }), true);
  const page = readFileSync(join(work, 'report', REMEMBER_PAGE), 'utf8');
  assert.match(page, /<li>bills\.example, checked 2026-10-19T22:00:00\.000Z<\/li>/);
  assert.match(page, /<li>Newest first &lt;b&gt;<\/li>\n<li>PDF only<\/li>/);
  assert.doesNotMatch(page, /<script|\son[a-z]+=|https?:|ctx-secret-ref|not a site/i);
  assert.match(page, /<a href="index\.html">/);
  assert.match(rememberHtml({ signIns: [], preferences: null }), /No site\.[\s\S]*None yet\./);
});
