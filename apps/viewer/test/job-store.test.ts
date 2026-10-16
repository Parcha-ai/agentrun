// The manifest's job and store (RECORDING.md draft 24): the job that ran, as JSON, and the run's store at its end, a
// SQLite file. The viewer counts both among the blobs a recording names, checks they are there, and links them in the
// header: the job opens in a tab, the store downloads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { blobsNamed } from '../src/app.ts';
import { opensInPage, typeOfName } from '../src/blobs.ts';
import { parseLines, validate, type Manifest } from '../src/format.ts';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const fixture = new URL('fixtures/reference-killed/', import.meta.url).pathname;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const job = Buffer.from(JSON.stringify({ workflow: { name: 'reference' }, input: { company: 'Acme Ltd' }, files: [] }));
const store = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]);
const manifest = (): Manifest => ({ ...JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf8')),
  job: { blob: sha(job), sha256: sha(job) }, store: { blob: sha(store), at: { gen: 2, commit: 76 } } });
const lines = parseLines(readFileSync(join(fixture, 'events.jsonl'), 'utf8'));

test('the job and the store are blobs the recording names, and the format wants them in blobs/', () => {
  const named = blobsNamed(manifest(), lines);
  assert.ok(named.includes(sha(job)) && named.includes(sha(store)));
  const present = new Set([...named.filter((each) => each !== sha(store))]);
  assert.deepEqual(validate(manifest(), lines, present).filter((problem) => problem.includes('manifest.')), [`manifest.store.blob ${sha(store)} is not in blobs/`]);
});

test('a job or store of the wrong shape is a format problem, never one that stops the run from playing', () => {
  const problems = (over: Partial<Manifest>) => validate({ ...manifest(), ...over }, lines).filter((problem) => problem.startsWith('manifest.job') || problem.startsWith('manifest.store'));
  assert.deepEqual(problems({ store: { blob: sha(store) } as never }), ['manifest.store is not { blob, at: { gen, commit } }']);
  assert.deepEqual(problems({ job: { blob: 'not-a-sha' } as never }), ['manifest.job is not { blob, sha256 }']);
  assert.deepEqual(problems({}), [], 'the right shapes');
});

test('a store is a SQLite file, which downloads; the job is JSON, which opens', () => {
  assert.equal(typeOfName(`${sha(store)}.sqlite`), 'application/vnd.sqlite3');
  assert.equal(opensInPage(typeOfName(`${sha(store)}.sqlite`)), false);
  assert.equal(opensInPage(typeOfName(`${sha(job)}.json`)), true);
});

test('on the page, the header links the job, which opens in a tab, and the store, which downloads', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-job-store-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const dir = join(out, 'recordings', 'with-job');
  cpSync(fixture, dir, { recursive: true });
  writeFileSync(join(dir, 'blobs', `${sha(job)}.json`), job);
  writeFileSync(join(dir, 'blobs', `${sha(store)}.sqlite`), store);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest()));
  build(join(out, 'dist'), join(out, 'recordings'));
  const ran = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
    '--virtual-time-budget=4000', '--dump-dom', `${pathToFileURL(join(out, 'dist', 'index.html')).href}?r=with-job`], { encoding: 'utf8', timeout: 60_000 });
  const header = ran.stdout.slice(0, ran.stdout.indexOf('</header>'));
  const jobLink = header.match(/<a [^>]*class="job"[^>]*>The job<\/a>/)?.[0] ?? '';
  assert.match(jobLink, /target="_blank"/);
  assert.doesNotMatch(jobLink, /download=/);
  const storeLink = header.match(/<a [^>]*class="store"[^>]*>The store at commit 76 of generation 2<\/a>/)?.[0] ?? '';
  assert.match(storeLink, new RegExp(`download="${sha(store)}"`));
  assert.doesNotMatch(storeLink, /target=/);
  assert.doesNotMatch(ran.stdout, /breaks the format/);
  // A store with no `at`: the page plays, notes the format problem, and links no store.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest(), store: { blob: sha(store) } }));
  build(join(out, 'dist'), join(out, 'recordings'));
  const broken = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
    '--virtual-time-budget=4000', '--dump-dom', `${pathToFileURL(join(out, 'dist', 'index.html')).href}?r=with-job`], { encoding: 'utf8', timeout: 60_000 });
  assert.match(broken.stdout, /paid calls made/, 'the run still plays');
  assert.match(broken.stdout, /breaks the format: [^<]*manifest\.store is not/);
  assert.doesNotMatch(broken.stdout, /class="store"/);
});
