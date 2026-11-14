import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { scratch } from './support.mjs';
import { claudeSession, codexSession } from './fixtures/import-sessions.mjs';
import { exportRemoteHistory } from '../dist/import.js';

for (const runtime of ['claude-code', 'codex']) for (const preserveMetadata of [false, true]) {
  test(`${runtime} refuses a replaced approved source after enumeration${preserveMetadata ? ' even when size and mtime are preserved' : ''}`, async t => {
    const root = await scratch(t), home = join(root, 'home'), project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    const makeSession = runtime === 'claude-code' ? claudeSession : codexSession;
    const file = makeSession(home, project, 1, { prompt: 'Approved prompt.' });
    const original = readFileSync(file, 'utf8'), approvedStat = statSync(file);
    const replacement = original.replaceAll('Approved prompt.', preserveMetadata ? 'Unwanted secret.' : 'Unapproved conversation from an older archive.');
    if (preserveMetadata) assert.equal(Buffer.byteLength(replacement), approvedStat.size);
    const target = { runtime, project, selector: { kind: 'project' } }, options = { home, env: {} };
    const preview = await exportRemoteHistory(target, { ...options, preview: true });
    assert.equal(preview.total, 1);
    assert.deepEqual(preview.sessions, []);
    const originalStat = fs.stat;
    let replaced = false;
    // Replace only after the export captured its enumeration stamp. Reading the replacement itself is stable,
    // and its project/session identity is unchanged: only comparison with the approved stamp can refuse it.
    const mocked = t.mock.method(fs, 'stat', async (path, ...args) => {
      const result = await originalStat(path, ...args);
      if (path === file && !replaced) {
        replaced = true;
        const archive = join(root, 'archive.jsonl');
        writeFileSync(archive, replacement);
        utimesSync(archive, approvedStat.atime, preserveMetadata ? approvedStat.mtime : new Date(approvedStat.mtimeMs - 60_000));
        renameSync(archive, file);
        if (preserveMetadata) {
          const replacedStat = statSync(file);
          assert.equal(replacedStat.size, approvedStat.size);
          assert.equal(replacedStat.mtimeMs, approvedStat.mtimeMs);
          assert.notEqual(replacedStat.ino, approvedStat.ino);
        }
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    const exported = await exportRemoteHistory(target, { ...options, inventory: preview.inventory });
    assert.equal(replaced, true, 'the race happened after enumeration');
    assert.deepEqual(exported.sessions, [], 'changed conversation text must not leave under the old approval');
    assert.ok(exported.skipped.some(row => /changed during export/.test(row.reason)));
    assert.doesNotMatch(JSON.stringify(exported), /Unwanted secret|Unapproved conversation/);
    await assert.rejects(exportRemoteHistory(target, { ...options, inventory: preview.inventory }), /inventory changed/);
    const fresh = await exportRemoteHistory(target, { ...options, preview: true });
    assert.notEqual(fresh.inventory, preview.inventory, 'a new preview is required for the replacement');
    const reviewed = await exportRemoteHistory(target, { ...options, inventory: fresh.inventory });
    assert.equal(reviewed.sessions.length, 1, 'a fresh approval can export the historical replacement');
    assert.match(reviewed.sessions[0].firstPrompt, /Unwanted secret|Unapproved conversation/);
  });
}
