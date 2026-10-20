// "What I remember" and the agent's state in the Muse layout, in a real Chrome, under the exact policy the docs site serves (`connect-src 'self'`): an embedded
// recording keeps its blobs as data: URLs, which that policy will not let a fetch() read, so the card decodes them itself; a page that cannot be read is said on
// the card; and a finished run reads "is working" until the end of the conversation is in view, then "Done".
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import { chrome, closeLeftBrowsers } from './driven-page.ts';
import { served } from './muse-served.ts';

const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

test('in Chrome: under connect-src \'self\' an embedded recording\'s What I remember is read from its data: URL, not said unreadable', IN_CHROME, async (t) => {
  const { value, until } = await served(t);
  await until(`!!d()?.querySelector('.mu-memory .mu-rh') || /could not be read/.test(d()?.querySelector('.mu-memory .mu-remember')?.textContent ?? '')`, 'the card was read or said unreadable');
  const card = await value<{ headings: string[]; text: string }>(`({ headings: [...d().querySelectorAll('.mu-memory .mu-rh')].map((h) => h.textContent), text: d().querySelector('.mu-memory .mu-remember').textContent })`);
  assert.doesNotMatch(card.text, /could not be read/, `the card read its page, got: ${card.text.slice(0, 120)}`);
  assert.ok(card.headings.length > 0, 'its headings are drawn');
});

test('in Chrome: a page that cannot be read is said on the card, with the reason', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { files: true, removeEntry: true });
  await until(`/could not be read/.test(d()?.querySelector('.mu-memory .mu-remember')?.textContent ?? '')`, 'the card said it could not be read');
  assert.match(await value<string>(`d().querySelector('.mu-memory .mu-remember').textContent`), /^What the agent remembers could not be read here \(the page answered 404\)\./);
});

test('in Chrome: a finished run reads "is working" while the end of the conversation is out of view, and "Done" once it is in view', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { height: 360 });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  const state = () => value<string>(`d().querySelector('.mu-state').textContent`);
  assert.equal(await value<boolean>(`(() => { const chat = d().querySelector('.mu-chat'); return chat.scrollHeight > chat.clientHeight + 400; })()`), true, 'the conversation is longer than the frame');
  assert.equal(await state(), 'is working', 'at the top the end is not in view');
  await value(`(() => { const chat = d().querySelector('.mu-chat'); chat.scrollTop = chat.scrollHeight; return 0; })()`);
  await until(`d().querySelector('.mu-state').textContent === 'Done'`, 'the state said Done at the end');
  await value(`(() => { d().querySelector('.mu-chat').scrollTop = 0; return 0; })()`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await state(), 'Done', 'scrolled back up it stays Done: the end has been read');
});
