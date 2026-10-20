// (A saved answer is read from a blob the page fetches, so those two tests ship the blobs as files, as a gallery does.)
// The Muse layout draws what a run delivered, whichever way it delivered it, and reads its pages as they are, in a real Chrome under the docs site's policy:
// a saved answer (manifest.result) is the agent's last bubble unless the conversation already said it; a file an answer names by its address still gets its chip;
// the memory page's headings, lists and notes are kept when the page wraps them in layout containers; and a finished run is "Done" only when the END of the
// last card has been reached, never while its top is in view, nor while it still says it is reading.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import { chrome, closeLeftBrowsers } from './driven-page.ts';
import { readEvents, readManifest, served, writeBlob, writeEvents, writeManifest } from './muse-served.ts';

const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

/** The fixture's last assistant message with `text` in place of what it said (null: none at all). */
const finalText = (dir: string, text: string | null) => {
  const lines = readEvents(dir);
  const at = lines.map((line, index) => (line.kind === 'pi.assistant' && JSON.stringify(line).includes('"type":"text"') ? index : -1)).filter((index) => index >= 0).at(-1)!;
  if (text === null) lines.splice(at, 1);
  else lines[at].data.model[0].content = [{ type: 'text', text }];
  writeEvents(dir, lines);
};
/** A submitted result record as the run's saved answer (manifest.result). */
const savedAnswer = (dir: string, record: Record<string, unknown>) => {
  const sha = writeBlob(dir, JSON.stringify({ record, evidence: [] }), 'json');
  writeManifest(dir, { ...readManifest(dir), result: { blob: sha, title: 'The record' } });
};
/** The agent's memory page, in place of the fixture's. */
const memoryPage = (dir: string, html: string) => {
  const manifest = readManifest(dir) as { artifact: { entry: string; files: Record<string, string> } };
  manifest.artifact.files[manifest.artifact.entry] = writeBlob(dir, html, 'html');
  writeManifest(dir, manifest);
};
const bubbles = `[...d().querySelectorAll('.mu-row.agent .mu-bubble')].map((b) => b.textContent)`;

test('in Chrome: an answer the run saved (manifest.result) is the agent\'s last bubble when the conversation does not already say it', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { files: true, edit: (dir) => { finalText(dir, null); savedAnswer(dir, { answer: 'The balance is 42 dollars.', flagged: true }); } });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  const said = await value<string[]>(bubbles);
  assert.ok(said.some((text) => /The balance is 42 dollars\./.test(text)), `the saved answer is drawn, got ${JSON.stringify(said)}`);
  assert.equal(await value<string>(`[...d().querySelector('.mu-chat').children].filter((n) => n.classList.contains('mu-row') || n.classList.contains('mu-card')).at(-2).className`), 'mu-row agent', 'as the last bubble, before What I remember');
});

test('in Chrome: a saved answer is always drawn as the last bubble, even when a message says the same words (a short row such as "Yes" is no reason to hide it)', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { files: true, edit: (dir) => { finalText(dir, 'Yes, 35.'); savedAnswer(dir, { answer: 'Yes', amount: '35' }); } });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  const said = await value<string[]>(bubbles);
  assert.equal(said.length, 2, `the message and the saved answer, got ${JSON.stringify(said)}`);
  assert.match(said[1]!, /answer: Yes\s*amount: 35/, 'the saved answer is the last bubble, its rows as lines');
});

test('in Chrome: a file an answer names only by its address still gets its chip, and the address is shortened to its host', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { edit: (dir) => finalText(dir, 'The summary is at https://example.com/reports/summary.pdf') });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  assert.deepEqual(await value(`[[...d().querySelectorAll('.mu-row.agent .mu-file')].map((f) => f.textContent), ${bubbles}.at(-1)]`), [['summary.pdf'], 'The summary is at example.com']);
});

test('in Chrome: What I remember keeps its headings, lists and notes when the page wraps them in layout containers, and its file-name and index rules hold for nested headings', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { edit: (dir) => memoryPage(dir, `<!doctype html><html><body><main>
<h1>Memory</h1>
<section><h2>Accounts</h2><ul><li>Utility: shop.example.test</li></ul></section>
<div><h3>index.md</h3><ul><li>the host's table of contents</li></ul><h3>preferences.md</h3><p>Only the amount.</p></div>
</main></body></html>`) });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  assert.deepEqual(await value(`(() => { const c = d().querySelector('.mu-memory'); return [[...c.querySelectorAll('.mu-rh')].map((n) => n.textContent), [...c.querySelectorAll('.mu-rsub')].map((n) => n.textContent), [...c.querySelectorAll('li')].map((n) => n.textContent), [...c.querySelectorAll('.mu-rp')].map((n) => n.textContent), c.textContent.includes('table of contents')]; })()`),
  [['Accounts'], ['Preferences'], ['Utility: shop.example.test'], ['Only the amount.'], false]);
});

const LONG = `<!doctype html><html><body><h2>Everything I know</h2><ul>${Array.from({ length: 60 }, (_, index) => `<li>Note number ${index + 1} about the account</li>`).join('')}</ul></body></html>`;

test('in Chrome: a long last card does not mark the run Done while only its top is in view; Done comes when its end is', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { height: 360, edit: (dir) => memoryPage(dir, LONG) });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  const state = () => value<string>(`d().querySelector('.mu-state').textContent`);
  // The card's top is well inside the frame, its end far below it.
  await value(`(() => { const chat = d().querySelector('.mu-chat'); const card = d().querySelector('.mu-memory'); chat.scrollTop = card.offsetTop - 120; return [card.getBoundingClientRect().top, card.getBoundingClientRect().height]; })()`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(await value<boolean>(`(() => { const r = d().querySelector('.mu-memory').getBoundingClientRect(); return r.top < 300 && r.bottom > 700; })()`), true, 'its top is in view and its end is not');
  assert.equal(await state(), 'is working', 'not Done with the end of the card still below');
  await value(`(() => { const chat = d().querySelector('.mu-chat'); chat.scrollTop = chat.scrollHeight; return 0; })()`);
  await until(`d().querySelector('.mu-state').textContent === 'Done'`, 'Done at the end of the card');
});

test('in Chrome: a card that still says it is reading does not mark the run Done', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { height: 360, files: true, delayBlobMs: 3000 });
  await until(`!!d()?.querySelector('.mu-memory')`, 'the card drawn, still reading');
  await value(`(() => { const chat = d().querySelector('.mu-chat'); chat.scrollTop = chat.scrollHeight; return 0; })()`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await value<string>(`d().querySelector('.mu-memory .mu-remember').textContent`), 'Reading what the agent kept…', 'it is still reading');
  assert.equal(await value<string>(`d().querySelector('.mu-state').textContent`), 'is working', 'so the run is not Done');
  await until(`!!d().querySelector('.mu-memory .mu-rh')`, 'the card read');
  await value(`(() => { const chat = d().querySelector('.mu-chat'); chat.scrollTop = chat.scrollHeight; return 0; })()`);
  await until(`d().querySelector('.mu-state').textContent === 'Done'`, 'Done once it has been read and its end reached');
});
