// A conversation a call made (a fork) is drawn under that call, named by its own label or its parent's and its place, and its
// maker's messages are the tool's, never "You". Only a person's submitted input (a recording that keeps submissions) is "You".
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { extractChat } from '../src/chat-extract.ts';
import type { ChatItem, ChatModel } from '../src/chat-model.ts';
import { parseLines, type Recording } from '../src/format.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const fixture = new URL('fixtures/chat-forks/', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const opened = (manifest?: (m: Record<string, unknown>) => Record<string, unknown>): Recording => {
  const m = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf8'));
  return { id: 'chat-forks', manifest: manifest ? manifest(m) : m, lines: parseLines(readFileSync(join(fixture, 'events.jsonl'), 'utf8')), blobUrl: () => undefined, blobType: () => undefined } as Recording;
};
const chat = (recording: Recording, muse = false): Promise<ChatModel> => extractChat(recording, async () => undefined, { muse });
const said = (items: ChatItem[]) => items.flatMap((item) => (item.kind === 'user' || item.kind === 'host' ? [`${item.kind === 'user' ? 'You' : item.by ?? 'Host'}: ${item.text}`] : []));

test('a call\'s forks are its conversations: under its card, named by their own label or the parent\'s and their place, opened by the tool', async () => {
  const model = await chat(opened());
  const call = model.threads.flatMap((thread) => thread.items).find((item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool' && item.tool === 'fork_threads')!;
  const forks = (call.forks ?? []).map((id) => model.threads.find((thread) => thread.id === id)!);
  assert.deepEqual(forks.map((fork) => fork.label), ['threads · 1', 'threads · 2', 'warm start'], 'a copied label is the parent\'s, so the place names it; its own label stands');
  assert.ok(forks.every((fork) => fork.under === call.id), 'each is drawn under the call that made it');
  assert.equal(call.plumbing, undefined, 'a call that made conversations is never folded into the commands line');
  assert.deepEqual(model.threads.filter((thread) => !thread.under).map((thread) => thread.id), ['thread-1'], 'no fork is a conversation of its own at the top');
  assert.deepEqual(said(model.threads.find((thread) => thread.id === 'thread-1')!.items), ['You: Train a tiny regression three ways and report the best loss.'], 'the person who asked is You');
  assert.deepEqual(forks.map((fork) => said(fork.items)), [
    ['fork_threads: Thread 1 of 3. Train a tiny regression and report its final loss.'],
    ['fork_threads: Thread 2 of 3. Train a tiny regression and report its final loss.', 'You: Use a smaller learning rate.'],
    ['fork_threads: Thread 3 of 3. Train a tiny regression and report its final loss.'],
  ], 'the opening is the tool\'s; the one input a person submitted (draft 45) is You');
  assert.equal((await chat(opened(), true)).agent?.name, 'threads', 'the header names the agent by its own label, not a fork\'s');
  // A fork with a parent and no owner sits in its parent at the entry it was forked at: the person's first message.
  const ownerless = model.threads.find((thread) => thread.id === 'thread-13')!;
  const asked = model.threads.find((thread) => thread.id === 'thread-1')!.items.find((item) => item.kind === 'user')!;
  assert.equal(ownerless.under, asked.id, 'drawn at parent.at, never a top-level row');
  assert.equal(ownerless.label, 'threads · 4', 'named by its parent\'s label and its place among the parent\'s conversations');
  assert.deepEqual(said(ownerless.items), ['You: Look again from the start.'], 'no owner: its user entry follows the submission rule, a person\'s here');
});

test('without the submissions a recording keeps, nothing in a fork a call made is You', async () => {
  const model = await chat(opened((m) => ({ ...m, recorded: { started: (m.recorded as { started: string }).started, ended: (m.recorded as { ended: string }).ended } })));
  const forks = model.threads.filter((thread) => ['thread-10', 'thread-11', 'thread-12'].includes(thread.id));
  assert.equal(forks.length, 3);
  assert.ok(forks.every((fork) => fork.items.every((item) => item.kind !== 'user')), 'in an owned fork a steer no submission names is the maker\'s, not a person\'s');
});

test('in Chrome: the forks fold under the fork_threads card, labelled, opened by the tool, and only the person\'s steer reads You', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-forks-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  cpSync(fixture, join(out, 'recordings', 'chat-forks'), { recursive: true });
  build(join(out, 'dist'), join(out, 'recordings'), { files: true });
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jsonl': 'text/plain', '.css': 'text/css', '.webp': 'image/webp' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const page = await drivenPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat.html?r=chat-forks`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  try {
    await page.once(`document.querySelectorAll('.forks details.fold').length === 4`, 'true', 20_000, 'the three forks under the call and the one at the person\'s message');
    const seen = JSON.parse(String(await page.evaluate(`JSON.stringify({
      underCall: [...document.querySelectorAll('.step .forks details.fold')].map((fold) => fold.querySelector('summary .lab').textContent),
      top: [...document.querySelectorAll('.thread > details.fold')].length,
      atMessage: [...document.querySelectorAll('.thread > .forks > details.fold')].map((fold) => [fold.querySelector('summary .lab').textContent, fold.previousElementSibling === null && fold.parentElement.previousElementSibling.classList.contains('user')]),
      who: [...document.querySelectorAll('.forks .host-who')].map((who) => who.textContent),
      you: [...document.querySelectorAll('.forks .msg.user')].map((you) => you.textContent),
    })`)));
    assert.deepEqual(seen.underCall, ['threads · 1', 'threads · 2', 'warm start']);
    assert.equal(seen.top, 0, 'no fork is a top-level row');
    assert.deepEqual(seen.atMessage, [['threads · 4', true]], 'the ownerless fork folds right after the message it was forked at');
    assert.deepEqual(seen.who, ['fork_threads', 'fork_threads', 'fork_threads'], 'each opening is the tool\'s');
    assert.equal(seen.you.length, 2, 'only the people\'s submitted inputs read You');
    assert.deepEqual([...seen.you].sort().map((you: string) => you.replace(/^You/, '')), ['Look again from the start.', 'Use a smaller learning rate.']);
  } finally {
    await page.close();
  }
});
