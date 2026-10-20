// The chat page's Workflow view in a real Chrome, at 1440 and 390 px, over a hand run with no times that starts two
// workflows whose paths collide: the right pane's switch, a graph per execution in order, a node opening its conversation
// or the call that started it, the replay's place (a line of the file) set by a press and a drag on the timeline and by
// the scrubber, a phone's sheet, and a recording with no workflow, which has no switch at all.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';
import { KEY_A, KEY_B, lines, placeOf, SUMMARY, writeRecording } from './workflow-hand.ts';

const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const HARNESS = `<!doctype html><body style="margin:0">
<iframe id="wide" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=two-workflows"></iframe>
<iframe id="phone" style="position:absolute;top:0;left:0;width:390px;height:844px;border:0" src="chat.html?r=two-workflows"></iframe>
<iframe id="none" style="position:absolute;top:0;left:0;width:1440px;height:900px;border:0" src="chat.html?r=no-workflow"></iframe>
<script>
const doc = (id) => document.getElementById(id).contentDocument;
const ready = (id) => !!doc(id)?.querySelector('main#chat-root > .app .thread');
const STATES = ['done', 'working', 'escalated', 'failed', 'stopped', 'not-run'];
const statuses = (id, run) => Object.fromEntries([...doc(id).querySelectorAll('#' + run + ' .wg-node')].map((node) => [node.title, STATES.find((state) => node.classList.contains(state))]));
const row = (id, run, path) => doc(id).querySelector('#' + run + ' .wg-row[data-path="' + path + '"]');
const shown = (node) => !!node && node.checkVisibility();
const view = (id, name) => doc(id).querySelector('.views [data-view="' + name + '"]');
const pointer = (id, type, target, at) => {
  const track = doc(id).querySelector('.tl .track');
  const box = track.getBoundingClientRect();
  const end = Number(doc(id).querySelector('.scrub').max);
  (target ?? track).dispatchEvent(new (doc(id).defaultView.PointerEvent)(type, { bubbles: true, button: 0, clientX: box.left + box.width * at / end, clientY: box.top + 4 }));
};
const press = (id, at, target) => { pointer(id, 'pointerdown', target, at); pointer(id, 'pointerup', doc(id).defaultView, at); };
const flat = (id) => doc(id).documentElement.scrollWidth - doc(id).documentElement.clientWidth;
</script></body>`;

test('in Chrome: the Workflow view beside the report, a graph per run, its nodes, the replay on the timeline, at 1440 and 390', IN_CHROME, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-workflow-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  writeRecording(join(out, 'recordings', 'two-workflows'));
  writeRecording(join(out, 'recordings', 'no-workflow'), lines.filter((line) => line.kind !== 'agentrun.workflow'));
  build(join(out, 'dist'), join(out, 'recordings'));
  writeFileSync(join(out, 'dist', 'harness.html'), HARNESS);
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const page = await drivenPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/harness.html`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  const value = async <T>(expression: string) => JSON.parse(String(await page.evaluate(`JSON.stringify(${expression})`))) as T;
  const until = (expression: string, what: string) => page.once(expression, 'true', 20_000, what);
  const A = 'workflow-1';
  const B = 'workflow-2';
  const END_A = { '/root': 'done', '/root/steps/0': 'done', '/root/steps/1': 'done' };
  const END_B = { '/root': 'stopped', '/root/steps/0': 'done', '/root/steps/1': 'escalated', '/root/steps/2': 'not-run' };
  const ENDED = `({ a: doc(ID).querySelector('#${A} .wf-outcome')?.textContent, b: doc(ID).querySelector('#${B} .wf-outcome')?.textContent, title: doc(ID).querySelector('#${B} .wf-outcome')?.title,
    counts: [...doc(ID).querySelectorAll('#${B} .wf-count')].map((each) => each.textContent) })`;
  const ESCALATED = { a: 'complete', b: `escalated at misspelt: ${SUMMARY.slice(0, 139).trimEnd()}…`, title: SUMMARY, counts: ['1 done', '1 escalated', '1 stopped', '1 not run'] };
  await until(`['wide', 'phone', 'none'].every(ready)`, 'every chat page drawn');

  // 1440: the switch, the report first, then the Workflow view with a graph per run, in run order, each at its end.
  assert.deepEqual(await value(`[...doc('wide').querySelectorAll('.views .view')].map((each) => [each.textContent, each.getAttribute('aria-pressed')])`), [['Report', 'true'], ['Workflow', 'false']]);
  assert.equal(await value(`shown(doc('wide').querySelector('.wf-host'))`), false, 'the report shows first');
  await page.evaluate(`view('wide', 'workflow').click()`);
  assert.deepEqual(await value(`({ host: shown(doc('wide').querySelector('.wf-host')), report: shown(doc('wide').querySelector('.report-host')), hash: doc('wide').defaultView.location.hash,
    titles: [...doc('wide').querySelectorAll('.wf-run')].map((run) => [run.id, run.querySelector('.kicker').textContent, run.querySelector('.wf-title').textContent]) })`),
  { host: true, report: false, hash: '#workflow', titles: [[A, 'Workflow 1 of 2', 'gather-and-tally'], [B, 'Workflow 2 of 2', 'check-and-judge']] });
  assert.deepEqual(await value(`[statuses('wide', '${A}'), statuses('wide', '${B}')]`), [END_A, END_B], 'at the end of the run');
  assert.deepEqual(await value(`[...doc('wide').querySelectorAll('#${B} .wg-row')].map((each) => each.textContent)`), ['chain chain stopped', 'agent check done', 'escalate misspelt escalated', 'judge verdict not run']);
  assert.deepEqual(await value(ENDED.replaceAll('ID', `'wide'`)), ESCALATED, 'each execution\'s header reads its outcome; the summary is clipped, whole in its title');
  assert.equal(await value<string>(`doc('wide').querySelector('.wf-at').textContent`), `end · ${lines.length} lines`);
  assert.doesNotMatch(await value<string>(`doc('wide').querySelector('.wf-host').textContent`), /kill|chaos|ledger|restor/i, 'no durability marks');

  // A node with a conversation opens it in the thread; one with none shows the call that started its execution.
  await page.evaluate(`row('wide', '${B}', '/root/steps/0').click()`);
  await until(`doc('wide').querySelector('details.fold[data-item="thread-3"]')?.open === true`, 'the check node\'s conversation opened');
  assert.equal(await value(`doc('wide').querySelector('details.fold[data-item="thread-2"]').open`), false, 'not the other execution\'s node at the same path');
  await page.evaluate(`row('wide', '${A}', '/root/steps/1').click()`);
  await until(`!!doc('wide').querySelector('.step.flash')?.textContent.includes('gather-and-tally')`, 'the call that started the tally node\'s execution');

  // The replay, by the file's lines: a press on the timeline sets the line, a drag moves it, the scrubber and End too.
  const drivers = (key: string) => lines.filter((line) => line.kind === 'agentrun.driver' && (line.data as { key: string }).key === key).map(placeOf);
  const [, aGather, aTally] = drivers(KEY_A);
  const [, bEscalate] = drivers(KEY_B);
  await page.evaluate(`doc('wide').querySelector('.tl-toggle').click()`);
  await page.evaluate(`press('wide', ${aGather! + 0.4})`);
  assert.deepEqual(await value(`[statuses('wide', '${A}'), statuses('wide', '${B}')]`), [
    { '/root': 'working', '/root/steps/0': 'working', '/root/steps/1': 'not-run' }, { '/root': 'not-run', '/root/steps/0': 'not-run', '/root/steps/1': 'not-run', '/root/steps/2': 'not-run' }]);
  assert.deepEqual(await value(`[...doc('wide').querySelectorAll('.wf-outcome')].length`), 0, 'no outcome before an execution ends');
  assert.equal(await value<string>(`doc('wide').querySelector('.wf-at').textContent`), `line ${aGather} of ${lines.length}`, 'a press lands on a line');
  assert.deepEqual(await value(`[...new Set([...doc('wide').querySelectorAll('.tl .playhead')].map((head) => parseFloat(head.style.left).toFixed(2)))]`), [(aGather! / lines.length * 100).toFixed(2)], 'the playhead at the press');
  await page.evaluate(`(() => { pointer('wide', 'pointerdown', undefined, ${aGather}); pointer('wide', 'pointermove', doc('wide').defaultView, ${aTally}); pointer('wide', 'pointermove', doc('wide').defaultView, ${bEscalate}); pointer('wide', 'pointerup', doc('wide').defaultView, ${bEscalate}); })()`);
  assert.deepEqual(await value(`[statuses('wide', '${A}'), statuses('wide', '${B}')]`), [END_A, { '/root': 'working', '/root/steps/0': 'done', '/root/steps/1': 'working', '/root/steps/2': 'not-run' }],
    'dragged on to the escalate node, before the terminal line: unchanged');
  await page.evaluate(`(() => { const scrub = doc('wide').querySelector('.scrub'); scrub.value = '${aTally}'; scrub.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.deepEqual(await value(`statuses('wide', '${A}')`), { '/root': 'working', '/root/steps/0': 'done', '/root/steps/1': 'working' }, 'the scrubber: gather done, tally under way');
  await page.evaluate(`doc('wide').querySelector('.wf-end').click()`);
  assert.deepEqual(await value(`[statuses('wide', '${A}'), statuses('wide', '${B}'), doc('wide').querySelector('.wf-end').disabled]`), [END_A, END_B, true]);
  assert.deepEqual(await value(ENDED.replaceAll('ID', `'wide'`)), ESCALATED);
  // A click on a span still jumps to its conversation, and sets the place where it was pressed.
  await page.evaluate(`(() => { const bar = [...doc('wide').querySelectorAll('.tbar')].find((each) => each.title === 'node gather'); press('wide', ${aGather! + 1}, bar); bar.click(); })()`);
  await until(`doc('wide').querySelector('details.fold[data-item="thread-2"]')?.open === true`, 'the gather node\'s conversation opened from its span');
  assert.deepEqual(await value(`statuses('wide', '${A}')`), { '/root': 'working', '/root/steps/0': 'working', '/root/steps/1': 'not-run' });
  // The chip on the call that started a run opens the Workflow view at that run.
  await page.evaluate(`view('wide', 'report').click()`);
  assert.equal(await value(`[...doc('wide').querySelectorAll('.wf-chip')].every(shown)`), true, 'each call that started a run shows its chip');
  await page.evaluate(`doc('wide').querySelectorAll('.wf-chip')[1].click()`);
  assert.deepEqual(await value(`[doc('wide').querySelector('.art').dataset.view, shown(doc('wide').querySelector('#${B}'))]`), ['workflow', true]);
  // A citation or the report button turns the pane back to the report.
  await page.evaluate(`view('wide', 'report').click()`);
  assert.deepEqual(await value(`[shown(doc('wide').querySelector('.wf-host')), shown(doc('wide').querySelector('.report-host')), doc('wide').defaultView.location.hash]`), [false, true, '']);
  assert.equal(await value(`flat('wide')`), 0, 'no page scroll sideways at 1440');

  // 390: the switch is inside the bottom sheet; a node opens its conversation and closes the sheet; a call's chip opens its run.
  await page.evaluate(`doc('phone').querySelector('.report-btn').click()`);
  await page.evaluate(`view('phone', 'workflow').click()`);
  assert.deepEqual(await value(`({ open: doc('phone').querySelector('.art').classList.contains('open'), inSheet: !!doc('phone').querySelector('.art .views'), host: shown(doc('phone').querySelector('.wf-host')),
    page: flat('phone'), pane: doc('phone').querySelector('.wf-host').scrollWidth - doc('phone').querySelector('.wf-host').clientWidth, runs: doc('phone').querySelectorAll('.wf-run').length })`),
  { open: true, inSheet: true, host: true, page: 0, pane: 0, runs: 2 }, 'the graph scrolls inside its own box, never the page');
  assert.deepEqual(await value(`[statuses('phone', '${A}'), statuses('phone', '${B}')]`), [END_A, END_B]);
  assert.deepEqual(await value(ENDED.replaceAll('ID', `'phone'`)), ESCALATED);
  assert.equal(await value(`shown(doc('phone').querySelector('#${B} .wf-outcome'))`), true);
  await page.evaluate(`row('phone', '${B}', '/root/steps/0').click()`);
  await until(`doc('phone').querySelector('details.fold[data-item="thread-3"]')?.open === true && !doc('phone').querySelector('.art').classList.contains('open')`, 'the sheet closed on the conversation');
  assert.deepEqual(await value(`[...doc('phone').querySelectorAll('.wf-chip')].map((each) => each.textContent)`), ['Workflow gather-and-tally', 'Workflow check-and-judge'], 'each call that started a run');
  await page.evaluate(`doc('phone').querySelectorAll('.wf-chip')[1].click()`);
  assert.deepEqual(await value(`[doc('phone').querySelector('.art').classList.contains('open'), doc('phone').querySelector('.art').dataset.view]`), [true, 'workflow']);

  // A recording with no workflow: no switch, no Workflow view, no replay on its timeline.
  assert.deepEqual(await value(`({ views: !!doc('none').querySelector('.views'), host: !!doc('none').querySelector('.wf-host'), replay: !!doc('none').querySelector('.tl.replay, .playhead'), chips: doc('none').querySelectorAll('.wf-chip').length })`),
    { views: false, host: false, replay: false, chips: 0 });
});
