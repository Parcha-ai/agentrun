// The move card of the chat view: where a run moved between hosts at a host `handoff` line, the timeline holds one card there, read from fields only (the handoff's gen, point, n and
// `from`, the next generation's `run.json` holder: its host label and its driver kind), worded as a move or, where the holder's label is the one it left, a reopening; never a kill, a restart
// or a process; the holder's pid and boot id and the handoff's prose are never read; a `handoff.failed` draws nothing.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FORBIDDEN, credentialInFile } from '../../../packages/harness/src/scan.ts';
import { extractChat } from '../src/chat-extract.ts';
import type { ChatItem } from '../src/chat-model.ts';
import { parseLines, type Recording } from '../src/format.ts';
import { chrome, closeLeftBrowsers } from './driven-page.ts';
import { movedRun, served } from './muse-served.ts';

const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const D2 = { gens: [{ host: 'host-1', driver: 'daytona' }, { host: 'host-2', driver: 'daytona' }], moves: [{ t: 10_000, point: 'effect.kept charge', n: 5 }] };
const D3 = { gens: [{ host: 'host-1', driver: 'local' }, { host: 'host-1', driver: 'local' }, { host: 'host-1', driver: 'local' }], moves: [{ t: 4_000, point: 'effect.kept hand_over', n: 1 }, { t: 10_000, point: 'effect.kept hand_back', n: 1 }] };

/** The fixture made into a moved run in a scratch directory, and what extractChat makes of it. */
async function moved(t: { after(fn: () => unknown): void }, options: Parameters<typeof movedRun>[1] | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-move-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(here, 'fixtures', 'chat-browser'), dir, { recursive: true });
  if (options) movedRun(dir, options);
  const files = Object.fromEntries(readdirSync(join(dir, 'blobs')).map((name) => [name.split('.')[0]!, name]));
  const recording: Recording = { id: 'run', manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), lines: parseLines(readFileSync(join(dir, 'events.jsonl'), 'utf8')),
    blobUrl: (sha) => (files[sha] ? `blobs/${files[sha]}` : undefined), blobType: () => undefined };
  const model = await extractChat(recording, async () => undefined);
  const items = model.threads.flatMap((thread) => thread.items);
  return { items, cards: items.filter((item): item is Extract<ChatItem, { kind: 'move' }> => item.kind === 'move') };
}

test('a move between hosts is one card at the handoff, in words from fields: after the point\'s effect and its ordinal, on the host it left, then where it went', async (t) => {
  const { cards, items } = await moved(t, D2);
  assert.deepEqual(cards.map((card) => [card.lead, card.text]), [['after the 5th charge on host-1 (daytona)', 'Moved to host-2 (daytona) from the same disk; the conversation goes on']]);
  // Between the last line of generation 1 and the first of generation 2: after what was recorded at or before the handoff, before what came next.
  const at = items.findIndex((item) => item.kind === 'move');
  assert.ok(items.slice(0, at).every((item) => (item.t ?? 0) <= 10_000) && items.slice(at + 1).every((item) => (item.t ?? 0) > 10_000), 'in time order, at its handoff line');
});

test('where the holder\'s label is the one it left, the card says it reopened, never that it moved; the labels are the recorded ones, and an ordinal follows its number', async (t) => {
  const { cards } = await moved(t, D3);
  assert.deepEqual(cards.map((card) => [card.lead, card.text]), [
    ['after the 1st hand over on host-1 (local)', 'Reopened on host-1 (local) from the same disk; the conversation goes on'],
    ['after the 1st hand back on host-1 (local)', 'Reopened on host-1 (local) from the same disk; the conversation goes on'],
  ]);
  const ordinals = await moved(t, { ...D2, moves: [{ ...D2.moves[0]!, n: 2 }] });
  assert.match(ordinals.cards[0]!.lead, /^after the 2nd charge/);
  const third = await moved(t, { ...D2, moves: [{ ...D2.moves[0]!, n: 3 }] });
  assert.match(third.cards[0]!.lead, /^after the 3rd charge/);
  const eleventh = await moved(t, { ...D2, moves: [{ ...D2.moves[0]!, n: 11 }] });
  assert.match(eleventh.cards[0]!.lead, /^after the 11th charge/);
});

test('a point that is not an effect kept drops the "after" clause, and nothing else is read from it', async (t) => {
  const { cards } = await moved(t, { ...D2, moves: [{ t: 10_000, point: 'model.request', n: 3 }] });
  assert.deepEqual(cards.map((card) => [card.lead, card.text]), [['On host-1 (daytona)', 'Moved to host-2 (daytona) from the same disk; the conversation goes on']]);
});

test('a handoff.failed line draws no card, and a run with no handoff line draws none', async (t) => {
  assert.equal((await moved(t, { ...D2, moves: [], gens: [D2.gens[0]!], failed: [10_000] })).cards.length, 0, 'a failed handoff');
  assert.equal((await moved(t, undefined)).cards.length, 0, 'no handoff line');
});

test('the card holds no kill, restart or process, no pid, boot id or id-shaped string, no prose of the handoff, and no value the recorder\'s scanner refuses', async (t) => {
  const text = (await moved(t, D3)).cards.concat((await moved(t, D2)).cards).map((card) => `${card.lead}\n${card.text}`).join('\n');
  assert.doesNotMatch(text, /kill|restart|process|crash|pid|boot|generation|gen\b/i, 'a move, not a kill');
  assert.doesNotMatch(text, /[0-9a-f]{8,}|\d{6,}|[0-9a-f]{4,}-[0-9a-f]{4,}|boot-/i, 'no id-shaped string');
  assert.doesNotMatch(text, /brief is written|a VM opens|disk refused/, 'the handoff\'s prose never shows');
  assert.equal(credentialInFile('card.txt', text), undefined, 'no credential shape');
  assert.equal(FORBIDDEN.find(([name]) => name === 'machine path')![1].test(text), false, 'no machine path');
});

test('in Chrome: the chat view draws one card per handoff line, in words of a move, and none without one; the Muse layout draws none', IN_CHROME, async (t) => {
  const two = await served(t, { query: '', height: 900, edit: (dir) => movedRun(dir, D3) });
  await two.until(`!!d()?.querySelector('main#chat-root .thread')`, 'the chat view drawn');
  assert.deepEqual(await two.value(`[...d().querySelectorAll('.move-card')].map((card) => card.textContent)`), [
    'after the 1st hand over on host-1 (local)Reopened on host-1 (local) from the same disk; the conversation goes on',
    'after the 1st hand back on host-1 (local)Reopened on host-1 (local) from the same disk; the conversation goes on',
  ]);
  const none = await served(t, { query: '', height: 900 });
  await none.until(`!!d()?.querySelector('main#chat-root .thread')`, 'the chat view drawn');
  assert.equal(await none.value<number>(`d().querySelectorAll('.move-card').length`), 0, 'nothing drawn without a handoff line');
  const muse = await served(t, { query: '&muse', height: 900, edit: (dir) => movedRun(dir, D2) });
  await muse.until(`!!d()?.querySelector('.muse .mu-chat')`, 'the Muse layout drawn');
  assert.equal(await muse.value<number>(`d().querySelectorAll('.move-card').length`), 0, 'the Muse layout has no move card');
});
