// the recording: secrets and the sign-in, the live follower, blobs and the lines written as the run goes.
// One of the files the reference entry's demo tests are split into (each under about two minutes serial on CI); the shared helpers are in reference-demo-helpers.mjs.
// The reference entry as a demo's platform (item A of the entry brief): the spec's kills list through the supervisor (a named crossing, a storm, a box kind),
// --input, --max-usd, the browser choice, and the box the job's tools run in. The demo here is the reference job itself, started through demo-fixture.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { effectiveBoxes } from './reference/demo-spec.ts';
import { BOX_CROSSINGS, localPlace, capJudge, chooseBrowser, crossings, demo, tapBox, JEV_CAPS, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from './reference/index.ts';
import { ORIGINAL, FIXTURE, BASELINE, run, composeHost, destroyBoxes, meterKnown, RUN_LABEL, localBoxes, ctx, finish, lines, planFor, recordingPlace, specWith, SITES, signInHome, filesIn, killSpec, boxed } from './reference-demo-helpers.mjs';

test('the sign-in\'s secret strings are read from auth.json by key (access, refresh, id token and an API key), a missing file is fine, and an unreadable or non-JSON one fails without a value in the message', async (t) => {
  const { signInSecrets, signInFile } = await import('./reference/secrets.ts');
  const { home, tokens } = await signInHome(t);
  const found = signInSecrets(join(home, 'auth.json'));
  assert.deepEqual(found.map((secret) => secret.key.replace(`${home}/auth.json `, '')), ['credentials.openai.access', 'credentials.openai.refresh', 'credentials.openai.idToken', 'credentials.other.key']);
  assert.deepEqual(found.map((secret) => secret.value), [tokens.access, tokens.refresh, tokens.idToken, tokens.key], 'every secret string a credential holds, and no expiry, client id, host id or scope');
  writeFileSync(join(home, 'short.json'), JSON.stringify({ credentials: { openai: { type: 'oauth', access: 'short', refresh: 'tiny' } } }));
  assert.deepEqual(signInSecrets(join(home, 'short.json')), [], 'a short string is a word, not a secret');
  assert.deepEqual(signInSecrets(join(home, 'absent.json')), [], 'no sign-in is fine');
  mkdirSync(join(home, 'dir.json'));
  assert.throws(() => signInSecrets(join(home, 'dir.json')), /cannot be read/);
  writeFileSync(join(home, 'bad.json'), `{ not json ${tokens.access}`);
  assert.throws(() => signInSecrets(join(home, 'bad.json')), (error) => /is not JSON/.test(error.message) && !error.message.includes(tokens.access));
  assert.equal(signInFile({ AGENTRUN_HOME: '/elsewhere' }), '/elsewhere/auth.json');
  assert.match(signInFile({}), /\.config\/agentrun\/auth\.json$/);
});
test('--record holds none of the sign-in\'s tokens in any line, text blob or the manifest, though a tool result carried each; a recording without a sign-in is unchanged', { timeout: 300_000 }, async (t) => {
  const { home, tokens } = await signInHome(t);
  const values = Object.values(tokens);
  const leaked = await run(t, {}, ['--json'], { AGENTRUN_HOME: home, DEMO_LEAK: JSON.stringify(values), DEMO_RESULT: '1' });
  assert.equal(leaked.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(leaked.result.processes.at(-1)));
  const files = filesIn(leaked.recording);
  assert.ok(files.some((file) => file.endsWith('events.jsonl')) && files.some((file) => file.endsWith('manifest.json')));
  for (const file of files) for (const value of values) assert.ok(!readFileSync(file).includes(value), `${file.slice(leaked.recording.length)} holds a token`);
  assert.ok(readFileSync(join(leaked.recording, 'events.jsonl'), 'utf8').includes('[redacted]'), 'the tool result is there, with the values taken out');
  // A text blob is redacted before it is hashed and named: the result's cited blob carried every value, and the recording passes the validator and the gallery gate (every blob hashes to its own name).
  const blobs = readdirSync(join(leaked.recording, 'blobs')).filter((name) => name.endsWith('.txt'));
  assert.equal(blobs.length, 1, 'the cited text blob');
  assert.equal(readFileSync(join(leaked.recording, 'blobs', blobs[0]), 'utf8').match(/\[redacted\]/g).length, values.length, 'every value in it is taken out');
  assert.deepEqual(validateRecording(leaked.recording), []);
  const dist = await mkdtemp(join(tmpdir(), 'reference-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  cpSync(leaked.recording, join(dist, 'recordings', 'leaked'), { recursive: true });
  // The build that ships recordings as files: an index of the manifest and each blob's path, no more.
  const manifest = JSON.parse(readFileSync(join(leaked.recording, 'manifest.json'), 'utf8'));
  const held = readdirSync(join(leaked.recording, 'blobs'));
  writeFileSync(join(dist, 'recordings', 'index.json'), JSON.stringify([{ id: 'leaked', manifest, blobs: Object.fromEntries(held.map((name) => [name.split('.')[0], `blobs/${name}`])) }]));
  writeFileSync(join(dist, 'gallery.js'), "window.AGENTRUN_GALLERY_INDEX = 'recordings/index.json';\n");
  const { gateProblems } = await import('../scripts/recording/gate.mjs');
  assert.deepEqual(gateProblems(dist), [], 'the gallery gate passes the redacted recording');
  // No sign-in: nothing to redact, nothing refused, and the lines are what they were.
  const bare = await mkdtemp(join(tmpdir(), 'reference-nosignin-'));
  t.after(() => rm(bare, { recursive: true, force: true }));
  const plain = await run(t, {}, ['--json'], { AGENTRUN_HOME: bare, DEMO_LEAK: JSON.stringify(values) });
  assert.equal(plain.result.processes.at(-1).outcome.status, 'complete');
  assert.ok(readFileSync(join(plain.recording, 'events.jsonl'), 'utf8').includes(values[0]), 'a recording without a sign-in is not touched');
  assert.ok(!readFileSync(join(plain.recording, 'events.jsonl'), 'utf8').includes('[redacted]'));
});
test('a sign-in file that cannot be read fails the record before the run, and the record-time scan refuses a secret that slipped through, naming the key and the file and never the value', async (t) => {
  const { scanRecording } = await import('./reference/secrets.ts');
  const unreadable = await mkdtemp(join(tmpdir(), 'reference-unreadable-'));
  t.after(() => rm(unreadable, { recursive: true, force: true }));
  mkdirSync(join(unreadable, 'auth.json'));
  await assert.rejects(() => run(t, {}, ['--json'], { AGENTRUN_HOME: unreadable }), /sign-in file .* cannot be read/);
  const recording = await mkdtemp(join(tmpdir(), 'reference-slipped-'));
  t.after(() => rm(recording, { recursive: true, force: true }));
  mkdirSync(join(recording, 'blobs'));
  const value = `made-up-slipped-token-${'y'.repeat(24)}`;
  writeFileSync(join(recording, 'blobs', 'a.txt'), `a blob with ${value} in it`);
  assert.throws(() => scanRecording(recording, [{ key: 'DEMO_SECRET', value }]), (error) => /DEMO_SECRET is in blobs\/a\.txt/.test(error.message) && !error.message.includes(value));
  assert.doesNotThrow(() => scanRecording(recording, []));
});
test('the child uses the sign-in file the recorder reads (AGENTRUN_HOME is handed down), a token the sign-in refreshes mid-run is redacted from the next write on, and a token that was written before the recorder saw the file change refuses the recording', { timeout: 300_000 }, async (t) => {
  const { home, tokens } = await signInHome(t);
  const files = (recording) => filesIn(recording).filter((file) => !file.endsWith('.png'));
  const holds = (recording, value) => files(recording).some((file) => readFileSync(file).includes(value));
  // (c) A child that reads its token from its own AGENTRUN_HOME gets the file the recorder reads, so what it returns is redacted.
  const child = await run(t, {}, ['--json'], { AGENTRUN_HOME: home, DEMO_LEAK_STEPS: 'homeToken' });
  assert.equal(child.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(child.result.processes.at(-1)));
  assert.ok(!holds(child.recording, tokens.access), 'the child\'s token is not in the recording');
  assert.ok(readFileSync(join(child.recording, 'events.jsonl'), 'utf8').includes('[redacted]'), 'and it was there to be redacted');
  // (d) A refresh mid-run: the sign-in rewrites auth.json with a new access token, and a later line carries it.
  const refreshed = `made-up-refreshed-access-token-${'r'.repeat(30)}`;
  const mid = await run(t, {}, ['--json'], { AGENTRUN_HOME: home, DEMO_LEAK_STEPS: 'rotate,homeToken', DEMO_ROTATE_TOKEN: refreshed });
  assert.equal(mid.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(mid.result.processes.at(-1)));
  assert.ok(!holds(mid.recording, refreshed), 'the refreshed token, unknown at the start, is not in the recording');
  assert.ok((readFileSync(join(mid.recording, 'events.jsonl'), 'utf8').match(/\[redacted\]/g) ?? []).length >= 1);
  // (e) An event carries the new token BEFORE the file shows it. The follower redacts every line it places with the latest union a second behind, so by default the line is placed clean and the finished recording never holds the token.
  const late = `made-up-late-access-token-${'l'.repeat(30)}`;
  const { home: lateHome } = await signInHome(t);
  const clean = await run(t, {}, ['--json'], { AGENTRUN_HOME: lateHome, DEMO_LEAK: JSON.stringify([late]), DEMO_LEAK_STEPS: 'leak,rotate', DEMO_ROTATE_TOKEN: late });
  assert.equal(clean.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(clean.result.processes.at(-1)));
  assert.ok(!holds(clean.recording, late), 'the token is not in the finished recording: the line was redacted as it was placed');
  // But a line already placed (a hold of 0) before the file changed was already fetchable: the recording is refused (no manifest, the key and the file named, the value never).
  const { home: placedHome } = await signInHome(t);
  const recording = join(await mkdtemp(join(tmpdir(), 'reference-late-')), 'recording');
  t.after(() => rm(join(recording, '..'), { recursive: true, force: true }));
  await assert.rejects(() => run(t, {}, ['--json', '--record', recording], { AGENTRUN_HOME: placedHome, DEMO_FOLLOW_HOLD_MS: '0', DEMO_ROTATE_DELAY_MS: '800', DEMO_LEAK: JSON.stringify([late]), DEMO_LEAK_STEPS: 'leak,rotate', DEMO_ROTATE_TOKEN: late }), (error) => /credentials\.openai\.access/.test(error.message) && /while the run was followed/.test(error.message) && !error.message.includes(late));
  assert.ok(!existsSync(join(recording, 'manifest.json')), 'the refused recording is not a finished one');
});
test('a token the sign-in rotated twice during the run, which the child learned and returned in its result, is not in the recording: the child redacts what it tells the supervisor with every token it has seen', { timeout: 300_000 }, async (t) => {
  const { home } = await signInHome(t);
  const second = `made-up-second-access-token-${'s'.repeat(30)}`;
  const third = `made-up-third-access-token-${'h'.repeat(30)}`;
  const recording = join(await mkdtemp(join(tmpdir(), 'reference-rotated-')), 'recording');
  t.after(() => rm(join(recording, '..'), { recursive: true, force: true }));
  // The access token goes first -> second -> third inside one run; the result the child returns carries the second, which the supervisor's own list (the first, then the file's last) never held.
  const done = await run(t, {}, ['--json', '--record', recording], { AGENTRUN_HOME: home, DEMO_LEAK_STEPS: 'rotate,rotate2', DEMO_ROTATE_TOKEN: second, DEMO_ROTATE_TOKEN_2: third, DEMO_RESULT: '1', DEMO_RESULT_LEAK: second });
  assert.equal(done.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(done.result.processes.at(-1)));
  const files = filesIn(recording).filter((file) => !file.endsWith('.png'));
  for (const value of [second, third]) assert.ok(!files.some((file) => readFileSync(file).includes(value)), 'an intermediate token is not in the recording');
  assert.ok(files.some((file) => readFileSync(file, 'utf8').includes('[redacted]')), 'it was there to be redacted');
});
test('the final scan finds a token as a line stores it, JSON-escaped: one with a quote, a backslash or a newline', async (t) => {
  const { scanRecording } = await import('./reference/secrets.ts');
  const dir = await mkdtemp(join(tmpdir(), 'reference-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const value = 'made-up-token-with-"quote"-and-\\back\nline-' + 'q'.repeat(20);
  writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ data: { text: value } })}\n`);
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes(value), 'the line holds only the escaped form');
  assert.throws(() => scanRecording(dir, [{ key: 'the key', value }]), /the key is in events\.jsonl/);
  writeFileSync(join(dir, 'events.jsonl'), '{"data":{"text":"[redacted]"}}\n');
  assert.doesNotThrow(() => scanRecording(dir, [{ key: 'the key', value }]));
});
test('the tracker keeps the union of every value seen, reads a changed auth.json before the next write, and reads it once more at the end', async (t) => {
  const { trackSecrets } = await import('./reference/secrets.ts');
  const { home, tokens } = await signInHome(t);
  const file = join(home, 'auth.json');
  const tracked = trackSecrets({ AGENTRUN_HOME: home }, { name: 'x' });
  assert.equal(tracked.redact(`a line with ${tokens.access}`), 'a line with [redacted]');
  const next = `made-up-next-access-token-${'n'.repeat(30)}`;
  assert.equal(tracked.redact(`a line with ${next}`), `a line with ${next}`, 'a token the file does not hold yet is not known');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.credentials.openai.access = next;
  writeFileSync(file, JSON.stringify(stored));
  assert.equal(tracked.redact(`a line with ${next}`), 'a line with [redacted]', 'the changed file is read before the write');
  assert.equal(tracked.redact(`a line with ${tokens.access}`), 'a line with [redacted]', 'the old token is still known: the union');
  const last = `made-up-last-access-token-${'t'.repeat(30)}`;
  stored.credentials.openai.access = last;
  writeFileSync(file, JSON.stringify(stored));
  assert.ok(tracked.final().some((secret) => secret.value === last), 'the final read sees the newest token');
  assert.ok(tracked.final().some((secret) => secret.value === tokens.access), 'and every earlier one');


});
// ---- a blob appears whole or not at all --------------------------------------------------------------------------------------------------------

test('a blob read while it is being written is absent or whole (written to a temporary name, synced, renamed), a blob already there is left alone, and the validator, the gate and the scan skip a temporary name', { timeout: 120_000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-blob-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const bytes = 192 * 1024 * 1024;
  const sha = createHash('sha256').update(Buffer.alloc(bytes, 7)).digest('hex');
  const finalName = `${sha}.bin`;
  const blobs = join(tmp, 'blobs');
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', `import("./examples/reference/record.ts").then((m) => process.stdout.write(m.keepBlob(process.argv[1], Buffer.alloc(${bytes}, 7), "bin")))`, tmp], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.on('close', resolve));
  const seen = { temporary: 0, whole: 0, absent: 0, torn: [] };
  while (child.exitCode === null && child.signalCode === null) {
    const names = existsSync(blobs) ? readdirSync(blobs) : [];
    if ((existsSync(join(tmp, '.spool')) ? readdirSync(join(tmp, '.spool')) : []).some((name) => /^blob-.*\.tmp-\d+$/.test(name))) seen.temporary += 1;
    if (names.includes(finalName)) {
      const size = statSync(join(blobs, finalName)).size;
      if (size === bytes) seen.whole += 1; else seen.torn.push(size);
    } else seen.absent += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await exited;
  assert.deepEqual(seen.torn, [], 'the blob was never seen half written');
  assert.ok(seen.temporary > 0, 'it was written under a temporary name in .spool/ first');
  assert.equal(statSync(join(blobs, finalName)).size, bytes);
  assert.deepEqual(readdirSync(blobs), [finalName], 'blobs/ holds only the whole blob');
  assert.deepEqual(readdirSync(join(tmp, '.spool')).filter((name) => name.startsWith('blob-')), [], 'no temporary file is left');
  assert.equal(createHash('sha256').update(readFileSync(join(blobs, finalName))).digest('hex'), sha, 'whole, and named by its own hash');
  // Already there: left alone.
  const { keepBlob } = await import('./reference/record.ts');
  const before = statSync(join(blobs, finalName)).mtimeMs;
  assert.equal(keepBlob(tmp, Buffer.alloc(bytes, 7), 'bin'), sha);
  assert.equal(statSync(join(blobs, finalName)).mtimeMs, before);
});
// ---- live mode, the recorder half ---------------------------------------------------------------------------------------------------------------

test('the follower appends whole lines to events.jsonl in section 3\'s order as the spools fill; finishRecording completes the file, and the finished file equals a fresh export (a late line is placed by replacing the file whole)', async (t) => {
  const { startedAt, followRecording, finishRecording, compareLines, assignMemoOrders } = await import('./reference/record.ts');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-follow-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'rec');
  mkdirSync(join(dir, '.spool'), { recursive: true });
  startedAt(dir);
  const spool = (name) => join(dir, '.spool', name);
  const line = (over) => JSON.stringify({ channel: 'live', source: 'workflow', kind: 'x', gen: 1, seq: 0, data: {}, ...over });
  const follower = followRecording(dir, { holdMs: 30 });
  const snapshots = [];
  const look = () => { const text = readFileSync(join(dir, 'events.jsonl'), 'utf8'); snapshots.push(text.slice(0, text.lastIndexOf('\n') + 1)); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A supervisor line and a process\'s lines, one of them torn mid-write.
  appendFileSync(spool('supervisor-1.jsonl'), `${line({ source: 'host', kind: 'process.started', t: 1, seq: 0, gen: undefined, data: { gen: 1 } })}\n`);
  appendFileSync(spool('live-1.jsonl'), `${line({ t: 5, seq: 0 })}\n${line({ t: 9, seq: 1 }).slice(0, 20)}`);
  await wait(80); follower.poll(); look();
  appendFileSync(spool('live-1.jsonl'), `${line({ t: 9, seq: 1 }).slice(20)}\n`);
  // Durable lines: commit 1 with its lines and a memo (order null), then commit 2, which closes commit 1 for the memo.
  appendFileSync(spool('durable-1.jsonl'), [{ t: 10, commit: 1, order: 0, seq: 0 }, { t: 10, commit: 1, order: 1, seq: 1 }, { t: 11, commit: 1, order: null, seq: 2 }, { t: 14, commit: 2, order: 0, seq: 3 }].map((over) => `${line({ channel: 'durable', source: 'workflow', ...over })}\n`).join(''));
  await wait(80); follower.poll(); look();
  // A line that arrives later than the hold, from before what was placed: the file cannot stay a prefix of the final order.
  appendFileSync(spool('live-2.jsonl'), `${line({ t: 3, seq: 0, source: 'pi' })}\n`);
  await wait(80); follower.poll(); look();
  follower.close();
  // Every snapshot a reader took holds whole lines only, in section 3\'s order, and each is a prefix of the next until the late line: append only.
  for (const text of snapshots.slice(0, 2)) {
    const lines = text.split('\n').filter(Boolean).map((entry) => JSON.parse(entry));
    for (let index = 1; index < lines.length; index += 1) assert.ok(compareLines(lines[index - 1], lines[index]) <= 0, 'in order');
  }
  assert.ok(snapshots[1].startsWith(snapshots[0]) && snapshots[2].startsWith(snapshots[1]), 'appended to, never rewritten, while the run is going');
  assert.ok(snapshots[2].trimEnd().endsWith(line({ source: 'pi', t: 3, seq: 0 })), 'a line later than the hold is appended where it arrived, and the final file puts it in its place');
  assert.ok(snapshots[0].length > 0 && !snapshots[0].includes('"seq":1'), 'the torn line was not placed');
  assert.ok(snapshots[1].includes('"seq":1'), 'and it is placed once whole');
  // The fresh export: every spool line, sorted, memo orders assigned.
  const fresh = [];
  for (const name of readdirSync(join(dir, '.spool')).filter((entry) => entry.endsWith('.jsonl'))) for (const entry of readFileSync(spool(name), 'utf8').split('\n').filter(Boolean)) fresh.push(JSON.parse(entry));
  fresh.sort(compareLines);
  assignMemoOrders(fresh);
  const expected = fresh.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  finishRecording(dir, { title: 't', task: 't', model: 'faux/faux-1', kills: 0, code: { repo: 'r', commit: 'c', packages: {} }, cost: { usd: 0, parts: {} }, source: { run: 'x', store_sha256: '0'.repeat(64) } });
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), expected, 'the finished file is the fresh export');
  assert.ok(existsSync(join(dir, 'manifest.json')) && !existsSync(spool('')), 'the manifest is last, and the spool is gone');
});
test('the follower holds later lines behind a memo that waits, decodes a character a read cut in two whole, and reads only new bytes', async (t) => {
  const { startedAt, followRecording } = await import('./reference/record.ts');
  const { syncBuiltinESMExports } = await import('node:module');
  const fs = (await import('node:fs')).default;
  const tmp = await mkdtemp(join(tmpdir(), 'reference-follow-order-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'rec');
  mkdirSync(join(dir, '.spool'), { recursive: true });
  startedAt(dir);
  const spool = (name) => join(dir, '.spool', name);
  const line = (over) => JSON.stringify({ channel: 'live', source: 'workflow', kind: 'x', gen: 1, seq: 0, data: {}, ...over });
  const durable = (over) => JSON.stringify({ channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, data: {}, ...over });
  const events = () => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((entry) => JSON.parse(entry));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const follower = followRecording(dir, { holdMs: 0 });
  // A memo (t 10, commit 1) waits for a later commit; a live line at t 20 must not be placed before it.
  appendFileSync(spool('durable-1.jsonl'), `${durable({ t: 8, commit: 1, order: 0, seq: 0 })}\n${durable({ t: 10, commit: 1, order: null, seq: 1 })}\n`);
  appendFileSync(spool('live-1.jsonl'), `${line({ t: 20, seq: 2 })}\n`);
  await wait(40); follower.poll();
  assert.deepEqual(events().map((entry) => entry.t), [8], 'the memo waits, and the later live line waits behind it');
  appendFileSync(spool('durable-1.jsonl'), `${durable({ t: 15, commit: 2, order: 0, seq: 3 })}\n`);
  await wait(40); follower.poll();
  assert.deepEqual(events().map((entry) => entry.t), [8, 10, 15, 20], 'the next poll places the memo, then what follows it, in order');
  // A multibyte character cut by a read: both halves are decoded together.
  const whole = Buffer.from(`${line({ t: 30, seq: 4, data: { text: 'caf\u00e9 \u2014 \u{1f680}' } })}\n`);
  const cut = whole.indexOf(Buffer.from('\u00e9')) + 1;
  appendFileSync(spool('live-2.jsonl'), whole.subarray(0, cut));
  await wait(40); follower.poll();
  appendFileSync(spool('live-2.jsonl'), whole.subarray(cut));
  await wait(40); follower.poll();
  assert.equal(events().at(-1).data.text, 'caf\u00e9 \u2014 \u{1f680}', 'no replacement characters');
  // Reading: the spools are read from the saved offset, not whole again: no readFileSync of a spool file once the follower is made.
  const real = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (path, ...rest) => { if (String(path).includes('.spool')) reads.push(String(path)); return real(path, ...rest); };
  syncBuiltinESMExports();
  t.after(() => { fs.readFileSync = real; syncBuiltinESMExports(); });
  appendFileSync(spool('live-1.jsonl'), `${line({ t: 40, seq: 5 })}\n`);
  await wait(40); follower.poll(); follower.poll();
  assert.deepEqual(reads, [], 'the spools are not read whole on a poll');
  assert.equal(events().at(-1).t, 40);
});
test('--record: a reader polling events.jsonl mid-run sees only whole lines in order and append-only, the finished file validates, and the manifest names the job blob (always, when the entry knows the job)', { timeout: 300_000 }, async (t) => {
  const { compareLines } = await import('./reference/record.ts');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-live-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const recording = join(tmp, 'recording');
  const seen = [];
  const reader = setInterval(() => { try { const text = readFileSync(join(recording, 'events.jsonl'), 'utf8'); seen.push(text.slice(0, text.lastIndexOf('\n') + 1)); } catch { /* not there yet */ } }, 5);
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording] });
  clearInterval(reader);
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.ok(seen.some((text) => text.length > 0), 'the reader saw lines while the run was going');
  let previous = '';
  for (const text of seen) {
    const lines = text.split('\n').filter(Boolean).map((entry) => JSON.parse(entry));
    for (let index = 1; index < lines.length; index += 1) assert.ok(compareLines(lines[index - 1], lines[index]) <= 0, 'in order');
    if (text.length >= previous.length) assert.ok(text.startsWith(previous), 'append only');
    previous = text.length >= previous.length ? text : previous;
  }
  assert.deepEqual(validateRecording(recording), []);
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.match(manifest.job.blob, /^[0-9a-f]{64}$/);
  assert.equal(manifest.job.sha256, manifest.job.blob);
  const job = JSON.parse(readFileSync(join(recording, 'blobs', `${manifest.job.blob}.json`), 'utf8'));
  assert.deepEqual([job.workflow.name, job.input.company, Array.isArray(job.files)], ['reference-company-check', 'Acme Ltd', true]);
});
test('the follower redacts every line it places (a line a box\'s child wrote without the secret values is cleaned on its way in), live and in the finished file', async (t) => {
  const { startedAt, followRecording, finishRecording } = await import('./reference/record.ts');
  const { redactorOf } = await import('./reference/secrets.ts');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-follow-redact-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'rec');
  mkdirSync(join(dir, '.spool'), { recursive: true });
  startedAt(dir);
  const secret = `made-up-box-token-${'b'.repeat(24)}`;
  const redact = redactorOf([{ key: 'K', value: secret }]);
  appendFileSync(join(dir, '.spool', 'live-9.jsonl'), `${JSON.stringify({ channel: 'live', source: 'workflow', kind: 'x', gen: 1, seq: 0, t: 1, data: { text: `a box wrote ${secret}` } })}\n`);
  const follower = followRecording(dir, { holdMs: 10, redact });
  await new Promise((resolve) => setTimeout(resolve, 60));
  follower.poll();
  const live = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  assert.ok(live.includes('a box wrote [redacted]') && !live.includes(secret), 'cleaned as it is placed');
  follower.close();
  finishRecording(dir, { title: 't', task: 't', model: 'faux/faux-1', kills: 0, code: { repo: 'r', commit: 'c', packages: {} }, cost: { usd: 0, parts: {} }, source: { run: 'x', store_sha256: '0'.repeat(64) }, redact });
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes(secret) && !readFileSync(join(dir, 'manifest.json'), 'utf8').includes(secret));

});
test('a path in a detail is replaced whole, spaces and all; and a machine named like one of the recording\'s own words is not redacted out of its lines', async () => {
  const { plainText } = await import('./reference/demo.ts');
  const { machineSecrets, redactorOf } = await import('./reference/secrets.ts');
  assert.equal(plainText('cannot open /tmp/Client Files/store: no such file'), 'cannot open <path>: no such file');
  const aliceHome = ['', 'home', 'alice'].join('/');
  assert.equal(plainText(`wrote ${aliceHome}/Private Documents/report.txt, then stopped`), 'wrote <path>, then stopped');
  assert.equal(machineSecrets('host').some((secret) => secret.key.includes('host name')), false, 'a machine named host: its name is a word of the recording');
  assert.equal(machineSecrets('build-box-7').some((secret) => secret.value === 'build-box-7'), true, 'an ordinary name is taken');
  const line = '{"channel":"live","source":"host","kind":"run.json","data":{"holder":{"host":"host-1"}}}';
  const redact = redactorOf(machineSecrets('host').filter((secret) => secret.key.includes('host name')));
  assert.equal(redact ? redact(line) : line, line, 'the lines of the format are unchanged');
});
test('the placed-lines scan finds a token as a line stores it, JSON-escaped', async (t) => {
  const { scanPlaced } = await import('./reference/secrets.ts');
  const dir = await mkdtemp(join(tmpdir(), 'reference-placed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const value = 'made-up-token-with-"quote"-and-\\back\nline-' + 'p'.repeat(20);
  writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ data: { text: value } })}\n`);
  assert.throws(() => scanPlaced(dir, [{ key: 'the key', value }]), /a secret was in events\.jsonl while the run was followed/);
});
test('a follower that cannot write ends the run through the normal path: the running child is stopped, the place is released, and the error is the follower\'s', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference' });
  process.env.DEMO_LINGER_MS = '20000';
  const recording = join(tmp, 'recording');
  const calls = [];
  const started = Date.now();
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    // Appending to events.jsonl fails from now on: it is a directory.
    return { ...inner, start: async (order) => { rmSync(join(recording, 'events.jsonl'), { force: true }); mkdirSync(join(recording, 'events.jsonl')); return inner.start(order); }, release: async () => { calls.push('release'); return inner.release(); } };
  } }), /EISDIR|is a directory/i);
  assert.deepEqual(calls, ['release'], 'the place was released');
  assert.ok(Date.now() - started < 60_000, 'the child was stopped, not waited for');
});
test('the follower does not publish a line that holds a credential shape: it stops the recording instead; and a recording that cannot be set up closes what it opened', { timeout: 120_000 }, async (t) => {
  const { startedAt, followRecording } = await import('./reference/record.ts');
  const dir = await mkdtemp(join(tmpdir(), 'reference-follow-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.spool'), { recursive: true });
  startedAt(dir);
  const follower = followRecording(dir, { holdMs: 0 });
  const secret = `sk-${'a1'.repeat(20)}`;
  appendFileSync(join(dir, '.spool', 'live-1.jsonl'), `${JSON.stringify({ channel: 'live', source: 'workflow', kind: 'x', gen: 1, seq: 0, t: 1, data: { header: secret } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => follower.poll(), /holds a provider secret.*not published/);
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes(secret), 'the line was never placed');
  // A setup that fails (here the blobs directory is a file) rejects, and leaves no timer running.
  const { options } = await specWith(t, { name: 'reference' });
  const broken = await mkdtemp(join(tmpdir(), 'reference-setup-fails-'));
  t.after(() => rm(broken, { recursive: true, force: true }));
  writeFileSync(join(broken, 'blobs'), 'not a directory');
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = timers();
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--record', broken] }));
  assert.ok(timers() <= before, 'the follower\'s timer was stopped');
});
test('the follower looks at the text blobs a line names before it places the line; and a failing kill after a follower error ends the attempt with the follower\'s error', { timeout: 120_000 }, async (t) => {
  const { startedAt, followRecording } = await import('./reference/record.ts');
  const dir = await mkdtemp(join(tmpdir(), 'reference-follow-blob-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.spool'), { recursive: true });
  mkdirSync(join(dir, 'blobs'));
  startedAt(dir);
  const secret = `sk-${'b2'.repeat(20)}`;
  const hash = 'c'.repeat(64);
  writeFileSync(join(dir, 'blobs', `${hash}.json`), JSON.stringify({ body: secret }));
  const follower = followRecording(dir, { holdMs: 0 });
  appendFileSync(join(dir, '.spool', 'live-1.jsonl'), `${JSON.stringify({ channel: 'live', source: 'workflow', kind: 'x', gen: 1, seq: 0, t: 1, blobs: [hash], data: { evidence: 'a receipt' } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => follower.poll(), /a blob the run kept holds a provider secret/);
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes(hash), 'the line was not placed');
  // Follower error and a kill that fails too: the attempt ends and the call rejects with the follower\'s error.
  const { tmp, options } = await specWith(t, { name: 'reference' });
  process.env.DEMO_LINGER_MS = '20000';
  const recording = join(tmp, 'recording');
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner,
      start: async (order) => { rmSync(join(recording, 'events.jsonl'), { force: true }); mkdirSync(join(recording, 'events.jsonl')); const runner = await inner.start(order); return { ...runner, exited: new Promise(() => {}) }; },
      kill: async () => { throw Object.assign(new Error('the provider refused'), { code: 'KILL_REFUSED' }); } };
  } }), /EISDIR|is a directory/i);
});

test('a machine named like an ordinary word (gateway) is redacted only as a whole token in text: never inside a JSON key, a dotted event name, a longer word or a source value; and a name of the format\'s own words (node) is not taken', async () => {
  const { machineSecrets, redactorOf, scanRecording } = await import('./reference/secrets.ts');
  assert.equal(machineSecrets('node').filter((secret) => secret.key.includes('host name')).length, 0, 'a name of the format\'s own words is not taken');
  const word = machineSecrets('gateway').filter((secret) => secret.key.includes('host name'));
  assert.equal(word.length, 1);
  const line = '{"gateway":1,"source":"gateway","kind":"gateway.start","data":{"text":"connected to gateway on port 22; the gateway.example.org host; gateways"}}';
  const out = redactorOf(word)(line);
  assert.ok(out.includes('"gateway":1'), 'a JSON key is not rewritten');
  assert.ok(out.includes('"kind":"gateway.start"') && out.includes('gateway.example.org') && out.includes('gateways'), 'a dotted name and a longer word are not rewritten');
  assert.ok(out.includes('connected to [redacted] on port 22'), 'the name as a whole token in text is');
  const dir = await mkdtemp(join(tmpdir(), 'reference-whole-'));
  try {
    writeFileSync(join(dir, 'events.jsonl'), '{"gateway":1,"kind":"gateway.start"}\n');
    assert.doesNotThrow(() => scanRecording(dir, word), 'a key and a format word are not a mention');
    writeFileSync(join(dir, 'events.jsonl'), 'connected to gateway\n');
    assert.throws(() => scanRecording(dir, word), /host name/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the placed-lines scan finds a token as a line stores it, JSON-escaped', async (t) => {
  const { scanPlaced } = await import('./reference/secrets.ts');
  const dir = await mkdtemp(join(tmpdir(), 'reference-placed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const value = 'made-up-token-with-"quote"-and-\\back\nline-' + 'p'.repeat(20);
  writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ data: { text: value } })}\n`);
  assert.throws(() => scanPlaced(dir, [{ key: 'the key', value }]), /a secret was in events\.jsonl while the run was followed/);
});

test('a follower that cannot write ends the run through the normal path: the running child is stopped, the place is released, and the error is the follower\'s', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference' });
  process.env.DEMO_LINGER_MS = '20000';
  const recording = join(tmp, 'recording');
  const calls = [];
  const started = Date.now();
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    // Appending to events.jsonl fails from now on: it is a directory.
    return { ...inner, start: async (order) => { rmSync(join(recording, 'events.jsonl'), { force: true }); mkdirSync(join(recording, 'events.jsonl')); return inner.start(order); }, release: async () => { calls.push('release'); return inner.release(); } };
  } }), /EISDIR|is a directory/i);
  assert.deepEqual(calls, ['release'], 'the place was released');
  assert.ok(Date.now() - started < 60_000, 'the child was stopped, not waited for');
});

// ---- LiveParts.tools ---------------------------------------------------------------------------------------------------------------------------

test('on --live the effect door dispatches to LiveParts.tools (with its receipt); a tool missing there runs from the fakes only when demo.json says local: "fakes", else the call fails "no live source"; on fakes nothing changes', { timeout: 300_000 }, async (t) => {
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }, { name: 'fixture tools', env: 'DEMO_LIVE_TOOLS' }];
  const keys = [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }]];
  const browser = Object.fromEntries(['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  const answers = (dir) => readdirSync(join(dir, 'answers')).map((name) => JSON.parse(readFileSync(join(dir, 'answers', name), 'utf8')));
  const fromLive = (dir) => answers(dir).some((answer) => answer.value?.from === 'live');
  // A live tool: dispatched through the door, its answer kept as the receipt (the same wrapper as a fakes tool).
  const live = await run(t, { keys, programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_LIVE_TOOLS: 'search', ...browser });
  assert.equal(live.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(live.result.processes.at(-1)));
  assert.ok(fromLive(live.result.dir), 'the live tool ran, and its receipt is the kept answer');
  // A tool missing from the live tools, declared local: "fakes": the fakes\' own runs.
  const declared = await run(t, { keys, programs, tools: [{ name: 'search', local: 'fakes', hosted: null }] }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_LIVE_TOOLS: 'other', ...browser });
  assert.equal(declared.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(declared.result.processes.at(-1)));
  assert.ok(!fromLive(declared.result.dir) && answers(declared.result.dir).length > 0, 'the fakes\' search ran');
  // Not declared: the call fails clearly.
  const missing = await run(t, { keys, programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_LIVE_TOOLS: 'other', ...browser });
  assert.notEqual(missing.result.processes.at(-1).outcome.status, 'complete');
  assert.ok(JSON.stringify(missing.result.processes.at(-1)).includes('no live source for search') || readFileSync(join(missing.recording, 'events.jsonl'), 'utf8').includes('no live source for search'), 'it says why');
  // On fakes, live tools are never looked at.
  const fakes = await run(t, {}, ['--json'], { DEMO_LIVE_PROBE: '1', DEMO_LIVE_TOOLS: 'search' });
  assert.equal(fakes.result.processes.at(-1).outcome.status, 'complete');
  assert.ok(!fromLive(fakes.result.dir), 'fakes.tools never see LIVE');
  assert.ok(!existsSync(join(fakes.result.dir, 'models-seen.json')), 'the live hook is supplied and is never called on fakes');


});

test('the follower does not publish a line that holds a credential shape: it stops the recording instead; and a recording that cannot be set up closes what it opened', { timeout: 120_000 }, async (t) => {
  const { startedAt, followRecording } = await import('./reference/record.ts');
  const dir = await mkdtemp(join(tmpdir(), 'reference-follow-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.spool'), { recursive: true });
  startedAt(dir);
  const follower = followRecording(dir, { holdMs: 0 });
  const secret = `sk-${'a1'.repeat(20)}`;
  appendFileSync(join(dir, '.spool', 'live-1.jsonl'), `${JSON.stringify({ channel: 'live', source: 'workflow', kind: 'x', gen: 1, seq: 0, t: 1, data: { header: secret } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => follower.poll(), /holds a provider secret.*not published/);
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes(secret), 'the line was never placed');
  // A setup that fails (here the blobs directory is a file) rejects, and leaves no timer running.
  const { options } = await specWith(t, { name: 'reference' });
  const broken = await mkdtemp(join(tmpdir(), 'reference-setup-fails-'));
  t.after(() => rm(broken, { recursive: true, force: true }));
  writeFileSync(join(broken, 'blobs'), 'not a directory');
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = timers();
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--record', broken] }));
  assert.ok(timers() <= before, 'the follower\'s timer was stopped');
});

// ---- the live host's crossings ------------------------------------------------------------------------------------------------------------------

test('a kill at "judge.asked <label>" or "model.request turn <n>" lands on a live-shaped host (no tapFakes: the judge and model are the live host\'s), the resume pays the judge once, and repeated is 0', { timeout: 300_000 }, async (t) => {
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }];
  const keys = [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }]];
  const browser = Object.fromEntries(['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  const judged = (dir) => readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row)).filter((row) => row.kind === 'judge');
  for (const point of ['judge.asked verdict', 'model.request turn 1']) {
    const { result, recording } = await run(t, { keys, programs, kills: [{ point, why: `a kill at ${point} on a live host` }] }, ['--live', '--kill', '--json'], { DEMO_LIVE_PROBE: '1', ...browser });
    assert.deepEqual(result.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']], `${point}: ${JSON.stringify(result.processes)}`);
    assert.deepEqual(result.kills.map((kill) => kill.point), [point]);
    assert.deepEqual(result.unlanded, []);
    assert.equal(judged(result.dir).length, 1, `${point}: the judge was paid for once across the kill and the resume`);
    const counted = fold(readEvents(recording));
    assert.deepEqual([counted.processes, counted.kills, counted.repeated], [2, 1, 0], point);
  }
});

// ---- the demo's own Jev caps, and a model whose key the demo does not declare ----------------------------------------------------------------------

test('models.judge.caps sets the demo\'s own Jev caps (positive integers at most 4 times the default), the default is unchanged, a value past the ceiling is refused at load, and the run still refuses past the caps', { timeout: 300_000 }, async (t) => {
  const { judgeCapsOf } = await import('./reference/demo-spec.ts');
  const { composeHost } = await import('./reference/demo.ts');
  const { localHost, placeAt, crossings } = await import('./reference/index.ts');
  assert.deepEqual(judgeCapsOf({ name: 'x' }), { requests: 50, tokens: 40_000 }, 'the default is unchanged');
  assert.deepEqual(judgeCapsOf({ name: 'x', models: { judge: { jev: true } } }), { requests: 50, tokens: 40_000 });
  assert.deepEqual(judgeCapsOf({ name: 'x', models: { judge: { jev: true, caps: { requests: 2, tokens: 100 } } } }), { requests: 2, tokens: 100 });
  assert.deepEqual(judgeCapsOf({ name: 'x', models: { judge: { caps: { requests: 200 } } } }), { requests: 200, tokens: 40_000 }, 'one given, the other default');
  assert.deepEqual(judgeCapsOf({ name: 'x', models: { judge: { caps: { requests: 200, tokens: 160_000 } } } }), { requests: 200, tokens: 160_000 }, 'the ceiling itself is allowed');
  for (const [name, value] of [['requests', 201], ['tokens', 160_001], ['requests', 0], ['requests', -1], ['tokens', 1.5], ['requests', '3'], ['tokens', null]]) {
    assert.throws(() => judgeCapsOf({ name: 'x', models: { judge: { caps: { [name]: value } } } }), new RegExp(`models\\.judge\\.caps\\.${name} is a positive integer at most`), `${name} ${value}`);
  }
  // Refused at load, before any process starts.
  await assert.rejects(() => run(t, { models: { judge: { jev: true, caps: { requests: 201 } } }, keys: [{ oneOf: [{ env: 'TYPESAFE_API_KEY', required: true, where: 'w', why: 'y' }], why: 'a Jev key' }] }, ['--json']), /models\.judge\.caps\.requests is a positive integer at most 200/);
  // The caps are the judge seam\'s: the third question of a demo that set 2 is refused and never sent.
  const tmp = await mkdtemp(join(tmpdir(), 'reference-caps-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { fakes } = await import('./reference/job.ts');
  const place = await placeAt(join(tmp, 'run'));
  const asked = [];
  const local = localHost(place, { ...fakes, judge: async (request) => { asked.push(request.label); return { answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }; } });
  composeHost(local.host, undefined, crossings(undefined, undefined), { open: 0 }, join(place.root, 'judge-spent.jsonl'), false, judgeCapsOf({ name: 'x', models: { judge: { jev: true, caps: { requests: 2, tokens: 100 } } } }));
  const ask = () => local.host.decisions.runJudge({ label: 'q', questions: {} });
  await ask(); await ask();
  await assert.rejects(ask, (error) => error.code === 'JEV_CAP_REACHED' && /2 of 2 requests/.test(error.message));
  assert.equal(asked.length, 2, 'the refused one was never sent');
});

test('a demo that names models.judge (Jev) without a Jev key group is refused at load, naming the group to add; a TYPESAFE_API_KEY or an OPENROUTER_API_KEY group is enough, and no key is implied', { timeout: 300_000 }, async (t) => {
  await assert.rejects(() => run(t, { models: { judge: { jev: true } } }, ['--json']), /models\.judge \(Jev\) but declares no key for it: add a keys group .*TYPESAFE_API_KEY.*OPENROUTER_API_KEY/s);
  await assert.rejects(() => run(t, { models: { judge: { jev: true } }, keys: [{ env: 'GEMINI_API_KEY', required: true, where: 'w', why: 'y' }] }, ['--json']), /declares no key for it/);
  for (const env of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']) {
    const ok = await run(t, { models: { judge: { jev: true } }, keys: [{ oneOf: [{ env, required: true, where: 'w', why: 'y' }], why: 'a Jev key', for: 'live' }] }, ['--json']);
    assert.equal(ok.result.processes.at(-1).outcome.status, 'complete', env);
  }
  // A demo that names no Jev judge is not asked for the key.
  assert.equal((await run(t, { models: { lead: { needs: ['text'] } } }, ['--json'])).result.processes.at(-1).outcome.status, 'complete');

});

test('a live host whose fallback judge is the fakes\' (already tapped) has each crossing counted once; a judge the live parts supply is tapped here', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-tap-once-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('./reference/index.ts');
  const { composeHost } = await import('./reference/demo.ts');
  const place = await placeAt(join(tmp, 'run'));
  const crossed = [];
  const cross = (point) => { crossed.push(point); return false; };
  const fakes = { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' };
  // The entry taps the fakes when the live parts supply tools; the live parts here supply tools only.
  const { tapFakes } = await import('./reference/crossings.ts');
  const host = localHost(place, tapFakes(fakes, cross)).host;
  composeHost(host, { tools: { runEffect: async () => 'live' } }, cross, { open: 0 }, join(tmp, 'spent.jsonl'), true, undefined, true);
  await host.decisions.runJudge({ label: 'verdict' });
  assert.deepEqual(crossed.filter((point) => point.startsWith('judge.')), ['judge.asked verdict', 'judge.answered verdict'], 'once, not twice');
  // A judge the live parts supply has no crossings of its own: it is tapped.
  crossed.length = 0;
  const other = localHost(place, tapFakes(fakes, cross)).host;
  composeHost(other, { decisions: { runJudge: async () => ({ answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }) } }, cross, { open: 0 }, join(tmp, 'spent2.jsonl'), true, undefined, true);
  await other.decisions.runJudge({ label: 'verdict' });
  assert.deepEqual(crossed.filter((point) => point.startsWith('judge.')), ['judge.asked verdict', 'judge.answered verdict']);


});

test('the follower looks at the text blobs a line names before it places the line; and a failing kill after a follower error ends the attempt with the follower\'s error', { timeout: 120_000 }, async (t) => {
  const { startedAt, followRecording } = await import('./reference/record.ts');
  const dir = await mkdtemp(join(tmpdir(), 'reference-follow-blob-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.spool'), { recursive: true });
  mkdirSync(join(dir, 'blobs'));
  startedAt(dir);
  const secret = `sk-${'b2'.repeat(20)}`;
  const hash = 'c'.repeat(64);
  writeFileSync(join(dir, 'blobs', `${hash}.json`), JSON.stringify({ body: secret }));
  const follower = followRecording(dir, { holdMs: 0 });
  appendFileSync(join(dir, '.spool', 'live-1.jsonl'), `${JSON.stringify({ channel: 'live', source: 'workflow', kind: 'x', gen: 1, seq: 0, t: 1, blobs: [hash], data: { evidence: 'a receipt' } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => follower.poll(), /a blob the run kept holds a provider secret/);
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes(hash), 'the line was not placed');
  // Follower error and a kill that fails too: the attempt ends and the call rejects with the follower\'s error.
  const { tmp, options } = await specWith(t, { name: 'reference' });
  process.env.DEMO_LINGER_MS = '20000';
  const recording = join(tmp, 'recording');
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner,
      start: async (order) => { rmSync(join(recording, 'events.jsonl'), { force: true }); mkdirSync(join(recording, 'events.jsonl')); const runner = await inner.start(order); return { ...runner, exited: new Promise(() => {}) }; },
      kill: async () => { throw Object.assign(new Error('the provider refused'), { code: 'KILL_REFUSED' }); } };
  } }), /EISDIR|is a directory/i);
});

// ---- delegation and revoke lines ---------------------------------------------------------------------------------------------------------------

test('delegation lines are written from place.status() when a delegation appears or its orphaned state changes (none for a stable one), a revoke line from recover()\'s { revoked, ms }, and a place without them writes none; the recording validates', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-delegations-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const lines = (recording, kind) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === kind);
  const recording = join(tmp, 'recording');
  const first = { clientId: 'c-9a41', inodeId: 7001, path: '/runs/the-run', isOrphaned: false, isPending: false };
  await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    let generation = 0;
    let delegations = [];
    const record = () => ({ run: paths.id, status: 'running', generation, sealedSeq: 0, holder: { driver: 'fake', host: 'h', bootId: 'b', pid: generation, since: 's' } });
    return {
      ...inner,
      status: async () => ({ record: generation ? record() : null, delegations }),
      start: async (order) => { generation = 1; delegations = [first]; return inner.start(order); },
      // The old holder\'s delegation is orphaned the moment its box is gone; the takeover revokes it and a new holder has its own.
      kill: async (runner, kind) => { delegations = [{ ...first, isOrphaned: true }]; await inner.kill(runner, kind); },
      recover: async (last, kind, order) => { const next = await inner.recover(last, kind, order); generation = 2; delegations = [{ clientId: 'c-b2e7', inodeId: 'f-7002', path: '/runs/the-run', isOrphaned: false, isPending: true }]; return { ...next, revoked: [{ ...first, isOrphaned: true }], ms: 1234 }; },
    };
  } });
  assert.deepEqual(lines(recording, 'delegation').map((line) => [line.data.gen, line.data.clientId, line.data.isOrphaned, line.data.isPending]), [[1, 'client-1', false, false], [1, 'client-1', true, false], [2, 'client-2', false, true]], 'one line when each appears, one more when the first became orphaned, none for a stable one');
  assert.deepEqual(Object.keys(lines(recording, 'delegation')[0].data).sort(), ['clientId', 'gen', 'inodeId', 'isOrphaned', 'isPending', 'path']);
  assert.deepEqual(lines(recording, 'revoke').map((line) => [line.data.gen, line.data.revoked, line.data.ms]), [[2, [{ clientId: 'client-1', inodeId: 'inode-1', path: '/runs/the-run', isOrphaned: true }], 1234]]);
  assert.deepEqual(lines(recording, 'delegation').map((line) => line.data.inodeId), ['inode-1', 'inode-1', 'inode-2'], 'the same value the same label, a new one the next');
  const text = readFileSync(join(recording, 'events.jsonl'), 'utf8');
  // The ids as the place wrote them: the strings as text, and the number as the field's value (a bare 7001 can occur in a timestamp).
  for (const raw of ['c-9a41', 'c-b2e7', '"inodeId":7001', 'f-7002']) assert.ok(!text.includes(raw), `${raw} is not in the recording`);
  assert.deepEqual(validateRecording(recording), []);
  // A place without delegations or a revoke writes none.
  const plain = join(tmp, 'plain');
  await demo({ ...options, argv: ['--kill', '--json', '--record', plain] });
  assert.equal(lines(plain, 'delegation').length + lines(plain, 'revoke').length, 0);
});

// ---- a box place's recording, brought home ------------------------------------------------------------------------------------------------------

/** A place whose child writes its recording in a directory of its own (a box's, here a folder; the child writes the recording's clock there itself, from RECORD_STARTED), and that brings it home the way the seam says: blobs first (hash-checked, temp name, rename), then the new bytes of each spool file up to its last whole line. */
const boxed = (tmp, { failOn, calls = [], kind = 'process' } = {}) => ({ paths, self, destroyBoxes, requestFile }) => {
  const inner = localPlace({ self, paths, ...(kind === 'box' ? { destroyBoxes: async () => undefined } : {}), requestFile });
  const dirs = new Map();
  const offsets = new Map();
  let into;
  const dir = (attempt) => join(tmp, 'box', `record-${attempt}`);
  const home = {
    dir,
    bringHome: async (target, { final = false } = {}) => {
      calls.push({ final, manifest: existsSync(join(target, 'manifest.json')), attempts: [...dirs.keys()] });
      const failure = failOn?.({ final, calls: calls.length });
      if (failure) throw Object.assign(new Error(`the box could not be read at ${tmp}/box: ${failure}`), { code: failure });
      for (const [attempt, from] of dirs) {
        const blobs = join(from, 'blobs');
        for (const name of existsSync(blobs) ? readdirSync(blobs).filter((entry) => !entry.startsWith('.')) : []) {
          const bytes = readFileSync(join(blobs, name));
          if (createHash('sha256').update(bytes).digest('hex') !== name.split('.')[0]) throw Object.assign(new Error('a blob does not hash to its name'), { code: 'BLOB_MISMATCH' });
          mkdirSync(join(target, 'blobs'), { recursive: true });
          if (!existsSync(join(target, 'blobs', name))) { const temporary = join(target, 'blobs', `.${name}.tmp-${process.pid}`); writeFileSync(temporary, bytes); renameSync(temporary, join(target, 'blobs', name)); }
        }
        const spool = join(from, '.spool');
        for (const name of existsSync(spool) ? readdirSync(spool).filter((entry) => entry.endsWith('.jsonl')) : []) {
          const text = readFileSync(join(spool, name), 'utf8');
          const done = offsets.get(`${attempt}/${name}`) ?? 0;
          const whole = text.slice(0, text.lastIndexOf('\n') + 1);
          if (whole.length > done) { appendFileSync(join(target, '.spool', name), whole.slice(done)); offsets.set(`${attempt}/${name}`, whole.length); }
        }
      }
    },
  };
  const start = async (order) => { into = order.env.RECORD_DIR; const own = dir(order.gen); mkdirSync(own, { recursive: true }); dirs.set(order.gen, own); return { order: { ...order, env: { ...order.env, RECORD_DIR: own } } }; };
  return {
    ...inner, recordHome: home,
    start: async (order) => { const { order: next } = await start(order); return inner.start(next); },
    recover: async (last, kindOf, order) => { const { order: next } = await start(order); return inner.recover(last, kindOf, next); },
  };
};

test('a place with recordHome: the child writes its recording inside the place, the supervisor brings it home each tick and once final before the manifest, blobs first, and the recording validates', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-recordhome-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  Object.assign(process.env, { DEMO_SPEC: file, DEMO_RESULT: '1' });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const calls = [];
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--json', '--record', recording], place: boxed(tmp, { calls }) });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.ok(calls.length >= 1 && calls.at(-1).final === true, 'the last call is the final one');
  assert.ok(calls.every((call) => call.manifest === false), 'every call, the final one too, is before the manifest');
  assert.deepEqual(calls.at(-1).attempts, [1]);
  assert.equal(readFileSync(join(tmp, 'box', 'record-1', '.spool', 'started'), 'utf8'), readFileSync(join(recording, 'manifest.json'), 'utf8') && JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')).recorded.started, 'the child wrote the recording\'s clock into its own directory from RECORD_STARTED');
  const lines = readEvents(recording);
  assert.ok(lines.some((line) => line.source === 'workflow'), 'the child\'s own lines came home');
  assert.ok(existsSync(join(recording, 'blobs')) && readdirSync(join(recording, 'blobs')).every((name) => !name.startsWith('.')), 'its blobs came home, none left half written');
  assert.deepEqual(validateRecording(recording), []);
});

test('recording.carry.failed: a tick that fails is retried, a final failure refuses the recording when the attempt ended on its own, and does not when its box was lost (lost: true, the recording stands)', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-carry-failed-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const failed = (recording) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'recording.carry.failed');
  // A tick that fails once: a line, no refusal, and the final call brings everything home.
  const tick = join(tmp, 'tick');
  const retried = await demo({ ...options, argv: ['--json', '--record', tick], place: boxed(join(tmp, 'b1'), { failOn: ({ final, calls }) => (!final && calls === 1 ? 'CARRY_FAILED' : undefined) }) });
  assert.equal(retried.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(failed(tick).map((line) => [line.data.gen, line.data.code, 'lost' in line.data]), [[1, 'CARRY_FAILED', false]]);
  assert.ok(!failed(tick)[0].data.message.includes(tmp) && failed(tick)[0].data.message.includes('<path>'), 'paths in the message are <path>');
  assert.ok(readEvents(tick).some((line) => line.source === 'workflow'), 'and the child\'s lines are home');
  // A final failure after a runner that ended on its own: refused, no manifest.
  const refused = join(tmp, 'refused');
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--record', refused], place: boxed(join(tmp, 'b2'), { failOn: ({ final }) => (final ? 'CARRY_FAILED' : undefined) }) }), /the recording is refused: the place could not bring home process 1's recording \(CARRY_FAILED\)/);
  assert.ok(!existsSync(join(refused, 'manifest.json')));
  // The same failure for an attempt whose box was lost: the recording stands, with lost: true.
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'the box is taken away', kind: 'box' }] }));
  const { options: boxKill } = await import(`${FIXTURE}?options=${Date.now()}`);
  const lost = join(tmp, 'lost');
  let firstFinal = true;
  const stood = await demo({ ...boxKill, argv: ['--kill', '--json', '--record', lost], place: boxed(join(tmp, 'b3'), { kind: 'box', failOn: ({ final }) => { if (!final || !firstFinal) return undefined; firstFinal = false; return 'BOX_GONE'; } }) });
  assert.equal(stood.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(failed(lost).map((line) => [line.data.gen, line.data.code, line.data.lost]), [[1, 'BOX_GONE', true]]);
  assert.ok(existsSync(join(lost, 'manifest.json')), 'the recording stands');
  assert.deepEqual(validateRecording(lost), []);
});

test('the box child\'s own recorder redacts the box\'s host name and boot id even where no sign-in file is handed down (no AGENTRUN_HOME): a box-side line holding them is clean', async () => {
  const { trackSecrets } = await import('./reference/secrets.ts');
  const { hostname } = await import('node:os');
  const boot = existsSync('/proc/sys/kernel/random/boot_id') ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : undefined;
  const { redact } = trackSecrets({}, { name: 'x' }, join(tmpdir(), 'no-such-sign-in', 'auth.json'));
  const line = JSON.stringify({ data: { text: `the box ${hostname()} booted as ${boot ?? 'no-boot-id'} and says hello` } });
  const cleaned = redact(line);
  if (hostname().length >= 4 && hostname() !== 'localhost') assert.ok(!cleaned.includes(hostname()), 'the box\'s host name is gone');
  if (boot) assert.ok(!cleaned.includes(boot), 'and its boot id');
  assert.ok(cleaned.includes('says hello'));
});

test('RECORD_STARTED gives a fresh recording directory its clock (an existing one is left alone), and a spool rolls into segments past segmentBytes that a second process still counts as one', async (t) => {
  const { openRecorder, startedAt } = await import('./reference/record.ts');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-segments-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const clock = '2026-10-16T09:00:00.000Z';
  const fresh = join(tmp, 'fresh');
  assert.equal(startedAt(fresh, clock), clock, 'a fresh directory takes the value it is given');
  assert.equal(startedAt(fresh, '2030-01-01T00:00:00.000Z'), clock, 'an existing one is left alone');
  // Segments: a tiny segment size rolls the stream; the lines are all there, in segments `<stream>.<n>.jsonl`.
  const dir = join(tmp, 'rec');
  const first = openRecorder({ dir, started: clock, segmentBytes: 300 });
  for (let index = 0; index < 8; index += 1) first.live('workflow', 'x', { text: 'x'.repeat(100), index });
  await first.detach();
  const names = readdirSync(join(dir, '.spool')).filter((name) => name.endsWith('.jsonl')).sort();
  assert.ok(names.length >= 3 && names.every((name) => /^live-\d+-\d+\.\d+\.jsonl$/.test(name)), names.join(','));
  const lines = names.flatMap((name) => readFileSync(join(dir, '.spool', name), 'utf8').split('\n').filter(Boolean)).map((entry) => JSON.parse(entry));
  assert.deepEqual(lines.map((line) => line.data.index).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(names.every((name) => statSync(join(dir, '.spool', name)).size <= 600), 'each segment is small');
  // A second process counts the first as one process, not one per segment.
  const second = openRecorder({ dir, segmentBytes: 300 });
  second.live('workflow', 'x', { index: 'second' });
  await second.detach();
  const all = readdirSync(join(dir, '.spool')).filter((name) => name.endsWith('.jsonl')).flatMap((name) => readFileSync(join(dir, '.spool', name), 'utf8').split('\n').filter(Boolean)).map((entry) => JSON.parse(entry));
  assert.equal(all.find((line) => line.data.index === 'second').gen, 2, 'the second process is process 2');
  assert.equal(all.find((line) => line.data.index === 0).gen, 1);


});

test('a box.receipt line is written for each box place.status() reports once its `to` appears: box-N by first appearance, seconds, the price and the cost (null with no price), never the provider\'s id; a place that reports none writes none', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-box-receipts-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const lines = (recording, kind) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === kind);
  const recording = join(tmp, 'recording');
  const priced = { provider: 'prov', kind: 'sandbox', id: 'sbx-9f31c0', from: '2026-10-16T10:00:00.000Z', usdPerSecond: 0.0001, source: 'https://prices.example/page 2026-10-01', priced: true };
  const unpriced = { provider: 'prov', kind: 'sandbox', id: 'sbx-77ab12', from: '2026-10-16T10:01:00.000Z', source: 'none published', priced: false };
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    let boxes = [];
    return {
      ...inner,
      status: async () => ({ record: null, boxes }),
      start: async (order) => { boxes = [priced, unpriced]; return inner.start(order); },
      // The first box ends when the process is killed; the second ends with the takeover.
      kill: async (runner, kind) => { boxes = [{ ...priced, to: '2026-10-16T10:00:30.000Z' }, unpriced]; await inner.kill(runner, kind); },
      recover: async (last, kind, order) => { const next = await inner.recover(last, kind, order); boxes = [{ ...priced, to: '2026-10-16T10:00:30.000Z' }, { ...unpriced, to: '2026-10-16T10:03:00.000Z' }]; return next; },
    };
  } });
  const receipts = lines(recording, 'box.receipt').map((line) => line.data);
  assert.deepEqual(receipts.map((row) => [row.box, row.seconds, row.usd_per_second, row.cost_usd, row.priced]), [['box-1', 30, 0.0001, 0.003, true], ['box-2', 120, null, null, false]], 'one per box, in order of first appearance; the unpriced box has no cost');
  assert.deepEqual(Object.keys(receipts[0]).sort(), ['box', 'cost_usd', 'from', 'kind', 'priced', 'provider', 'seconds', 'source', 'to', 'usd_per_second']);
  assert.ok(!readFileSync(join(recording, 'events.jsonl'), 'utf8').match(/sbx-9f31c0|sbx-77ab12/), 'the provider\'s id is not in the recording');
  assert.equal(result.usd, null, 'one box has no price: the run\'s cost reads unknown, never the priced box alone');
  assert.deepEqual(validateRecording(recording), []);
  const plain = join(tmp, 'plain');
  await demo({ ...options, argv: ['--kill', '--json', '--record', plain] });
  assert.equal(lines(plain, 'box.receipt').length, 0);
});

// ---- a kill's n counts every crossing, and it lands at the first eligible one at or after the nth ------------------------------------------------------------

test('a kill\'s n counts EVERY crossing of its point, eligible or not, and lands at the first ELIGIBLE one at or after the nth (the kill line keeps the ordinal it landed on); it is unlanded only when the run ends before any eligible crossing at or after n', () => {
  const withWindow = (n, eligibility) => {
    const kills = [];
    const window = { open: 0 };
    const cross = crossings({ run: { point: 'p', kind: 'process', target: 'run', why: 'x', n }, tools: [] }, undefined, Date.now(), (crossing) => kills.push(crossing), window);
    for (const eligible of eligibility) { window.open = eligible ? 0 : 1; cross('p'); }
    return kills.map((kill) => [kill.point, kill.n]);
  };
  assert.deepEqual(withWindow(3, [true, true, true, true]), [['p', 3]], 'all eligible: the nth');
  assert.deepEqual(withWindow(3, [true, false, false, true, true]), [['p', 4]], 'the 3rd and the 2nd are inside a call: it lands at the 4th, and says so');
  assert.deepEqual(withWindow(3, [false, true, true, false, true]), [['p', 3]], 'the 3rd is eligible even though the first was not (the old count would have waited for a 5th)');
  assert.deepEqual(withWindow(3, [true, true, false, false]), [], 'the run ends before any eligible crossing at or after n: unlanded');
  assert.deepEqual(withWindow(1, [false, false, true]), [['p', 3]], 'n 1 with the first ones ineligible');
  assert.equal(withWindow(2, [true, true, true, true]).length, 1, 'once');
});

test('a kill at a point that is often ineligible lands every time across 8 runs, and the result and the summary say planned n and landed n when they differ', { timeout: 600_000 }, async (t) => {
  for (let index = 0; index < 8; index += 1) {
    const { result, recording } = await run(t, { kills: [{ point: 'event workflow.node.start', why: 'a node starts, often while another branch\'s call is in flight', n: 4 }] }, ['--kill', '--json'], { DEMO_FANOUT: '1' });
    assert.deepEqual(result.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']], `run ${index}: ${JSON.stringify(result.processes.map((process) => process.signal))}`);
    assert.deepEqual(result.unlanded, [], `run ${index}`);
    const [kill] = result.kills;
    assert.equal(kill.planned, 4);
    assert.ok(kill.n >= 4, `landed at n=${kill.n}, at or after the planned 4`);
    const line = readEvents(recording).find((entry) => entry.source === 'host' && entry.kind === 'kill');
    assert.equal(line.data.crossing.n, kill.n, 'the kill line keeps the ordinal it landed on');
  }
  const lines = [];
  const log = console.log;
  // The summary says it when they differ.
  const { summarize } = await import('./reference/demo.ts');
  console.log = (...args) => lines.push(args.join(' '));
  try { summarize({ spec: { name: 'x' } }, { processes: [{ outcome: { status: 'complete' } }], kills: [{ gen: 1, point: 'p', kind: 'process', why: 'w', n: 12, planned: 10 }, { gen: 2, point: 'q', kind: 'process', why: 'w', n: 3, planned: 3 }], failedKills: [], failedSignals: [], unlanded: [], usd: 0, maxUsd: null, overBudget: false }); } finally { console.log = log; }
  assert.ok(lines.some((line) => line.includes('at p (planned n=10, landed at n=12): w')) && lines.some((line) => line.includes('at q: w') && !line.includes('planned')), lines.join('\n'));

});

test('boxes of one provider, kind and start are two boxes, labelled box-N when they first appear (not when they end), and the cap counts the priced boxes beside an unpriced one', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] });
  const recording = join(tmp, 'recording');
  const same = { provider: 'prov', kind: 'sandbox', from: '2026-10-16T10:00:00.000Z', usdPerSecond: 1, source: 'list', priced: true };
  await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    let boxes = [];
    return {
      ...inner,
      status: async () => ({ record: null, boxes }),
      start: async (order) => { boxes = [same, same]; return inner.start(order); },
      // The second box ends first, then the first: the labels follow the order the boxes appeared in.
      kill: async (runner, kind) => { boxes = [same, { ...same, to: '2026-10-16T10:00:20.000Z' }]; await inner.kill(runner, kind); },
      recover: async (last, kind, order) => { const next = await inner.recover(last, kind, order); boxes = [{ ...same, to: '2026-10-16T10:00:10.000Z' }, { ...same, to: '2026-10-16T10:00:20.000Z' }]; return next; },
    };
  } });
  const receipts = readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'box.receipt').map((line) => [line.data.box, line.data.seconds]);
  assert.deepEqual(receipts, [['box-2', 20], ['box-1', 10]], 'two boxes with equal fields are two; box-1 is the one that appeared first, though it ended last');
  // The cap: a $1 box and an unpriced one: the cost is unknown, and the spend so far counts the $1.
  const dir = join(tmp, 'meter');
  mkdirSync(join(dir, '.spool'), { recursive: true });
  const receipt = (box, cost_usd) => JSON.stringify({ channel: 'live', source: 'host', kind: 'box.receipt', t: 1, seq: 0, data: { box, cost_usd } });
  writeFileSync(join(dir, '.spool', 'supervisor-1.jsonl'), `${receipt('box-1', 1)}\n${receipt('box-2', null)}\n`);
  assert.equal(meterKnown(dir), 1, 'the priced box counts against the cap, though the other has no price');
});

test('the slow tick does not queue a carry behind one still running: a place whose transfers take seconds is carried a bounded number of times', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference' });
  process.env.DEMO_LINGER_MS = '7000';
  let carries = 0;
  const started = Date.now();
  await demo({ ...options, argv: ['--json', '--record', join(tmp, 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => ({
    ...localPlace({ self, paths, destroyBoxes, requestFile }),
    recordHome: { dir: (attempt) => join(tmp, 'box', `record-${attempt}`), bringHome: async () => { carries += 1; await new Promise((resolve) => setTimeout(resolve, 2500)); } },
  }) });
  // The ticks that found no carry running, plus the final one; a tick queued behind every slow carry would make six or more.
  assert.ok(carries <= 4, `carried ${carries} times in ${Date.now() - started} ms`);

});

test('a box charge that first appears in the last status read counts against the cap: the run is over budget', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', expectedCost: 0.05 });
  const recording = join(tmp, 'recording');
  let reads = 0;
  const result = await demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    const box = { provider: 'prov', kind: 'sandbox', from: '2026-10-16T10:00:00.000Z', usdPerSecond: 1, source: 'list', priced: true };
    // The box's end is first reported by the third read, the last one the supervisor makes (start, exit, end): $60 against a cap of $0.10.
    return { ...inner, status: async () => { reads += 1; return { record: null, boxes: [reads >= 3 ? { ...box, to: '2026-10-16T10:01:00.000Z' } : box] }; } };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.equal(result.overBudget, true, 'the charge that arrived with the last read is over the cap');
});

test('a kill line carries the crossing\'s own number: a held kill the point\'s count (not the process\'s), and a storm the process\'s crossing counter (not zero)', async () => {
  const fired = [];
  const held = crossings({ run: { point: 'vision.filing', kind: 'process', target: 'run', why: 'held', n: 1, hold: 1 }, tools: [] }, undefined, Date.now(), (crossing) => fired.push(crossing.n));
  for (const other of ['judge.asked a', 'judge.answered a', 'model.request turn 0']) held(other);
  held('vision.filing');
  assert.ok(held.park('vision.filing') instanceof Promise);
  assert.deepEqual(fired, [1], 'the first filing is the first crossing of its point, whatever came before');
  const storm = crossings({ run: { storm: true, kills: 1, gapMs: 0 }, tools: [] }, undefined, Date.now() - 10_000, (crossing) => fired.push(crossing.n));
  storm('event workflow.node.start');
  storm('judge.asked a');
  assert.ok(fired.at(-1) > 0, `a storm kill has the process's crossing number, not 0: ${fired.at(-1)}`);


});

test('a delegation without a path (the package finds it by its inode) is kept: a delegation line and a revoke entry are written without one', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] });
  const recording = join(tmp, 'recording');
  const bare = { clientId: 'client-x', inodeId: 4242, isOrphaned: true, isPending: false };
  await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, status: async () => ({ record: null, delegations: [bare] }), recover: async (last, kind, order) => ({ ...(await inner.recover(last, kind, order)), revoked: [bare], ms: 5 }) };
  } });
  const lines = readEvents(recording).filter((line) => line.source === 'host');
  const delegation = lines.find((line) => line.kind === 'delegation');
  assert.ok(delegation, 'the delegation line is written');
  assert.equal('path' in delegation.data, false);
  const revoke = lines.find((line) => line.kind === 'revoke');
  assert.equal(revoke.data.revoked.length, 1, 'and the revoke names it');
});
