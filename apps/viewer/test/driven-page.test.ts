// The Chrome driver the viewer's page tests share (driven-page.ts): an expression that throws in the page is an error, never a
// value of undefined that a test reads as an answer; `once` waits through a condition that throws (not so yet); and `until`
// gives the first value of a read that is its own readiness check, so nothing on the page changes between a check and a read.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

test('in Chrome: a throw in the page is an error; once waits through a condition that throws; until gives the first value a read returns', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'driven-page-'));
  writeFileSync(join(dir, 'page.html'), '<!doctype html><html><head><title>page</title></head><body></body></html>');
  const page = await drivenPage(pathToFileURL(join(dir, 'page.html')).href, join(dir, 'profile'), { signal: t.signal });
  t.after(() => closeAll([page], () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })), { timeout: 20_000 });
  await assert.rejects(page.evaluate(`(() => { throw new Error('boom'); })()`), /the page threw: Error: boom/);
  await assert.rejects(page.evaluate('document.querySelector(".none").textContent'), /the page threw: TypeError/);
  assert.equal(await page.evaluate('1 + 1'), 2, 'a value is still a value');
  assert.equal(await page.evaluate('undefined'), undefined, 'and an expression whose value is undefined is still undefined, not an error');
  // A condition that throws until the page sets what it reads is not so yet, then so.
  await page.evaluate('setTimeout(() => { window.ready = { n: 3 }; }, 300)');
  assert.equal(await page.once('window.ready.n === 3', 'window.ready.n', 5_000, 'the page ready'), 3);
  // A read that gives nothing (undefined, '', or a throw) until the page has it, then its value.
  await page.evaluate(`setTimeout(() => { window.late = { text: 'here' }; }, 300)`);
  assert.equal(await page.until('window.late.text', 5_000, 'the late value'), 'here');
  await assert.rejects(page.until('window.never', 500, 'a value that never comes'), /a value that never comes: no value after 0.5 s/);
});
