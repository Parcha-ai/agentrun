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
import { effectiveBoxes } from '../packages/reference/dist/demo-spec.js';
import { BOX_CROSSINGS, localPlace, capJudge, chooseBrowser, crossings, demo, tapBox, JEV_CAPS, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from '@parcha/agentrun-reference';
import { ORIGINAL, FIXTURE, BASELINE, run, composeHost, destroyBoxes, meterKnown, RUN_LABEL, localBoxes, ctx, finish, lines, planFor, recordingPlace, specWith, SITES, signInHome, filesIn, killSpec, boxed } from './reference-demo-helpers.mjs';

test('the sign-in\'s secret strings are read from auth.json by key (access, refresh, id token and an API key), a missing file is fine, and an unreadable or non-JSON one fails without a value in the message', async (t) => {
  const { signInSecrets, signInFile } = await import('../packages/reference/dist/secrets.js');
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
  const { scanRecording } = await import('../packages/reference/dist/secrets.js');
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
  const { scanRecording } = await import('../packages/reference/dist/secrets.js');
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
  const { trackSecrets } = await import('../packages/reference/dist/secrets.js');
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
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', `import("./packages/reference/dist/record.js").then((m) => process.stdout.write(m.keepBlob(process.argv[1], Buffer.alloc(${bytes}, 7), "bin")))`, tmp], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'] });
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
  const { keepBlob } = await import('../packages/reference/dist/record.js');
  const before = statSync(join(blobs, finalName)).mtimeMs;
  assert.equal(keepBlob(tmp, Buffer.alloc(bytes, 7), 'bin'), sha);
  assert.equal(statSync(join(blobs, finalName)).mtimeMs, before);
});
// ---- live mode, the recorder half ---------------------------------------------------------------------------------------------------------------

test('the follower appends whole lines to events.jsonl in section 3\'s order as the spools fill; finishRecording completes the file, and the finished file equals a fresh export (a late line is placed by replacing the file whole)', async (t) => {
  const { startedAt, followRecording, finishRecording, compareLines, assignMemoOrders } = await import('../packages/reference/dist/record.js');
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
  const { startedAt, followRecording } = await import('../packages/reference/dist/record.js');
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
  const { compareLines } = await import('../packages/reference/dist/record.js');
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
  const { startedAt, followRecording, finishRecording } = await import('../packages/reference/dist/record.js');
  const { redactorOf } = await import('../packages/reference/dist/secrets.js');
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
  const { plainText } = await import('../packages/reference/dist/demo.js');
  const { machineSecrets, redactorOf } = await import('../packages/reference/dist/secrets.js');
  assert.equal(plainText('cannot open /tmp/Client Files/store: no such file'), 'cannot open <path>: no such file');
  const aliceHome = ['', 'home', 'alice'].join('/');
  assert.equal(plainText(`wrote ${aliceHome}/Private Documents/report.txt, then stopped`), 'wrote <path>, then stopped');
  assert.equal(machineSecrets('host').some((secret) => secret.key.includes('host name')), false, 'a machine named host: its name is a word of the recording');
  assert.equal(machineSecrets('greppy-mrb').some((secret) => secret.value === 'greppy-mrb'), true, 'an ordinary name is taken');
  const line = '{"channel":"live","source":"host","kind":"run.json","data":{"holder":{"host":"host-1"}}}';
  const redact = redactorOf(machineSecrets('host').filter((secret) => secret.key.includes('host name')));
  assert.equal(redact ? redact(line) : line, line, 'the lines of the format are unchanged');
});
test('the placed-lines scan finds a token as a line stores it, JSON-escaped', async (t) => {
  const { scanPlaced } = await import('../packages/reference/dist/secrets.js');
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
  const { startedAt, followRecording } = await import('../packages/reference/dist/record.js');
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
  const { startedAt, followRecording } = await import('../packages/reference/dist/record.js');
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

test('the scrub takes the run\'s user name (a whole token in a path segment or an ls column), its home directory and the paths under its directories out of lines and text blobs; ordinary words are left alone', async () => {
  const { scrubOf } = await import('../packages/reference/dist/secrets.js');
  const user = 'someuser';
  const home = ['', 'home', user].join('/');
  const run = ['', 'tmp', 'agentrun-demo-ab12cd'].join('/');
  const scrub = scrubOf({ user, home, dirs: [run] });
  // The user name in an ls -la row, as a tool result holds it, inside a JSON line (the newline is the two characters \\n).
  const listing = `total 8\ndrwxr-xr-x  2 ${user} ${user} 4096 Oct 18 10:00 work\n-rw-r--r--  1 root root 12 Oct 18 10:00 notes.txt\n`;
  const out = scrub(JSON.stringify({ data: { text: listing } }));
  assert.ok(!out.includes(user), `the user name is gone from the ls columns: ${out}`);
  assert.ok(out.includes('root root'), 'other owners stay');
  assert.ok(scrub(listing).includes('[user] [user] 4096'), 'and the same in a plain text blob');
  // The home directory, a path under it, a path under the run's directory.
  assert.equal(scrub(`cd ${home}/projects && ls`), 'cd ~/projects && ls');
  assert.equal(scrub(`wrote ${run}/work/out.json and ${run}`), 'wrote <run>/work/out.json and <run>');
  // A path segment that is the user name, outside the home.
  assert.equal(scrub(`/srv/${user}/data`), '/srv/[user]/data');
  // Ordinary words: the name as a word, a longer word that holds it, a version.
  const plain = `Ubuntu 24.04 is what ${user}s like; the word ${user} in a sentence stays`;
  assert.equal(scrub(plain), plain);
  assert.equal(scrub('Ubuntu 24.04'), 'Ubuntu 24.04');
  const ubuntu = scrubOf({ user: 'ubuntu', home: '/home/ubuntu', dirs: [] });
  assert.equal(ubuntu('Ubuntu 24.04 LTS, ubuntu 24.04'), 'Ubuntu 24.04 LTS, ubuntu 24.04', 'a user named ubuntu does not mangle "Ubuntu 24.04"');
  assert.equal(scrubOf({ dirs: [] }), undefined, 'nothing to take out: no scrub');
});

test('a tool result that carries the run\'s user name, home and run directory is recorded scrubbed, in the line and in a text blob', { timeout: 300_000 }, async (t) => {
  const { userInfo, homedir } = await import('node:os');
  const user = userInfo().username;
  const text = `drwxr-xr-x  2 ${user} ${user} 4096 Oct 18 10:00 work\nhome ${homedir()}/projects`;
  const { recording } = await run(t, {}, ['--json'], { DEMO_LEAK: JSON.stringify([text]), DEMO_RESULT: '1' });
  const all = filesIn(recording).filter((file) => !file.endsWith('.png')).map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.ok(!all.includes(homedir()), 'the home directory is not in the recording');
  assert.ok(!new RegExp(`\\s${user}\\s+${user}\\s`).test(all), 'nor the user name in an ls column');
});
