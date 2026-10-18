// The chat view's model is made from a recording's generic events alone: the same code gives every run its threads,
// tool cards and timeline, every label comes from an event field, and nothing is borrowed from another run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLines, type Json, type Recording } from '../src/format.ts';
import { chatCiteHref, chatToolTitle, extractChat } from '../src/chat-extract.ts';
import { blobsNamed } from '../src/load.ts';
import type { ChatItem, ChatModel } from '../src/chat-model.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', json: 'application/json', html: 'text/html' };

/** A recording directory as the shell opens it, and a reader of its blobs' JSON. */
function opened(dir: string, edit?: (text: string) => string): { recording: Recording; readJson: (sha: string) => Promise<Json | undefined> } {
  const files = Object.fromEntries(readdirSync(join(dir, 'blobs')).map((name) => [name.split('.')[0]!, name]));
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const recording: Recording = {
    id: dir, manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), lines: parseLines(edit ? edit(events) : events),
    blobUrl: (sha) => (files[sha] ? `blobs/${files[sha]}` : undefined), blobType: (sha) => (files[sha] ? types[files[sha]!.split('.').at(-1)!] : undefined),
  };
  return { recording, readJson: async (sha) => (files[sha]?.endsWith('.json') ? JSON.parse(readFileSync(join(dir, 'blobs', files[sha]!), 'utf8')) as Json : undefined) };
}
const model = async (dir: string, edit?: (text: string) => string): Promise<ChatModel> => { const { recording, readJson } = opened(dir, edit); return extractChat(recording, readJson); };
const items = (m: ChatModel): ChatItem[] => m.threads.flatMap((thread) => thread.items);
const tools = (m: ChatModel) => items(m).filter((item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool');

const referenceJob = join(here, '..', 'recordings', 'reference-job');
const hearAndFind = join(here, 'fixtures', 'chat-hear-and-find');
const artifact = join(here, 'fixtures', 'chat-artifact');

/** The first stored entry of `kind`, edited in place. */
const editFirst = (kind: string, change: (data: { model: Record<string, Json>[] }) => void) => (events: string) => {
  let done = false;
  return events.split('\n').map((text) => {
    if (done || !text.trim()) return text;
    const line = JSON.parse(text) as { channel: string; kind: string; data: { model: Record<string, Json>[] } };
    if (line.channel !== 'durable' || line.kind !== kind) return text;
    change(line.data);
    done = true;
    return JSON.stringify(line);
  }).join('\n');
};

test("a run is its input as given, then its recorded conversation: the host's prompt is no entry, one card per tool call", async () => {
  const m = await model(referenceJob);
  const { recording } = opened(referenceJob);
  assert.deepEqual(m.input, { fields: [{ name: 'company', value: 'Acme Ltd' }] });
  assert.equal(m.threads.length, 1);
  const prompt = (recording.lines.find((line) => line.kind === 'pi.user')!.data as { model: { content: string }[] }).model[0]!.content;
  assert.ok(items(m).every((item) => item.kind !== 'user' && !('text' in item && item.text === prompt)));
  const called = recording.lines.filter((line) => line.kind === 'tool_execution_start').map((line) => (line.data as { toolName: string }).toolName);
  assert.deepEqual(tools(m).map((card) => card.tool), called);
  for (const card of tools(m)) assert.ok(card.title.startsWith(`${card.tool}`), card.title);
  assert.equal(tools(m).find((card) => card.tool === 'submit')?.takeaway, '', "the runner's reply to a delivery is not the run's");
  assert.equal(m.title, recording.manifest.title, 'an input with no question titles nothing; the recording does');
});

test('a submitted result record is the answer: one row per field, its evidence paths as cites on the card that made them', async () => {
  const m = await model(referenceJob);
  assert.equal(m.answer?.from, 'record');
  const rows = Object.fromEntries((m.answer?.rows ?? []).map((row) => [row.label, row]));
  assert.equal(rows.company?.text, 'Acme Ltd');
  assert.equal(rows.supported?.text, 'yes');
  assert.ok(rows.answer?.text);
  const cites = rows.citations?.cites ?? [];
  assert.equal(cites.length, 2);
  assert.ok(cites.some((cite) => cite.item && tools(m).some((card) => card.id === cite.item)), 'the look cited is found on its card');
});

test('with no result, the answer is the final assistant text', async () => {
  const { recording, readJson } = opened(referenceJob, editFirst('pi.assistant', (data) => { (data.model[0]!.content as Json[]).push({ type: 'text', text: 'Incorporated on 2019-03-04.' }); }));
  delete (recording.manifest as { result?: unknown }).result;
  const m = await extractChat(recording, readJson);
  assert.equal(m.answer?.from, 'text');
  assert.equal(m.answer?.rows[0]?.text, 'Incorporated on 2019-03-04.');
});

test("a failed call's line is its error's first line, not the markup around it", async () => {
  const failed = (text: string) => editFirst('pi.tool-result', (data) => { data.model[0]!.isError = true; data.model[0]!.content = [{ type: 'text', text }]; });
  const wrapped = await model(referenceJob, failed('<harness>\n[error] Command exited with code 1\n</harness>'));
  assert.equal(tools(wrapped)[0]?.failed, true);
  assert.equal(tools(wrapped)[0]?.takeaway, '[error] Command exited with code 1');
  const record = await model(referenceJob, failed(JSON.stringify({ ok: false, error: { kind: 'script', message: 'not a function\nat line 3' } })));
  assert.equal(tools(record)[0]?.takeaway, 'not a function');
});

test("the title is the artifact's, else the first line of the input's question", async () => {
  assert.equal((await model(artifact)).title, 'A two-picture report');
  const asked = await model(referenceJob, (events) => events.replace('"input":{"company":"Acme Ltd"}', '"input":{"question":"When was Acme incorporated?\\nCite both.","company":"Acme Ltd"}'));
  assert.equal(asked.title, 'When was Acme incorporated?');
});

test('the timeline is spans from the events: LLM calls by model, tool calls by name, inner calls under their tool', async () => {
  const m = await model(hearAndFind);
  const lanes = new Set(m.spans.map((span) => span.lane));
  assert.ok([...lanes].some((lane) => lane.startsWith('LLM ')));
  assert.ok(lanes.has('tool code'));
  const inner = m.spans.filter((span) => span.actor === 'inner');
  assert.ok(inner.length > 0);
  for (const span of inner) assert.equal(span.parentLane, 'tool code', `${span.label} nests under the call that made it`);
  for (const span of m.spans) if (span.t1 !== undefined) assert.ok(span.t1 >= span.t0, span.label);
  assert.ok(m.spans.every((span) => span.item === undefined || items(m).some((item) => item.id === span.item) || m.threads.some((thread) => thread.id === span.item)));
});

test('every label comes from an event field: two different runs, the same kinds of labels, no constant titles', async () => {
  for (const dir of [referenceJob, hearAndFind]) {
    const m = await model(dir);
    const { recording } = opened(dir);
    const text = JSON.stringify(recording.lines);
    for (const span of m.spans) {
      if (span.actor === 'llm') assert.ok(text.includes(JSON.stringify(span.lane.slice('LLM '.length))), `${span.lane} is a model the recording names`);
      if (span.actor === 'tool') assert.ok(text.includes(`"toolName":${JSON.stringify(span.lane.slice('tool '.length))}`), `${span.lane} is a tool the recording calls`);
      if (span.actor === 'inner') assert.ok(text.includes(`"tool":${JSON.stringify(span.lane)}`), `${span.lane} is an inner call the recording files`);
      if (span.actor === 'node') assert.match(span.label, /^node /);
    }
  }
  const source = readdirSync(join(here, '..', 'src')).filter((name) => name.startsWith('chat')).map((name) => readFileSync(join(here, '..', 'src', name), 'utf8')).join('\n');
  for (const word of ['transcript', 'photo', 'film', 'apollo', 'acme', 'eagle', 'aveo', 'certificate', 'reference-job', 'hear-and-find']) {
    assert.ok(!source.toLowerCase().includes(word), `the chat view's code names no demo (${word})`);
  }
});

test("thinking is the run's own: none recorded means none shown; a recorded part is shown where it was written", async () => {
  assert.equal(items(await model(referenceJob)).filter((item) => item.kind === 'thinking').length, 0);
  // One thinking part written into the first stored assistant entry, before its tool call.
  const withThinking = await model(referenceJob, editFirst('pi.assistant', (data) => { (data.model[0]!.content as Json[]).unshift({ type: 'thinking', thinking: 'Open the registry page first.' }); }));
  const thinking = items(withThinking).filter((item) => item.kind === 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0] as { text: string }).text, 'Open the registry page first.');
});

test("a cited answer's cites land on the card that made each look", async () => {
  const m = await model(hearAndFind);
  const cites = m.answer?.rows.flatMap((row) => row.cites) ?? [];
  assert.ok(cites.length > 0);
  for (const cite of cites.filter((each) => each.item)) {
    const card = tools(m).find((each) => each.id === cite.item);
    assert.ok(card && cite.look && card.looks.includes(cite.look), cite.href);
  }
  for (const cite of cites) assert.match(cite.href, /#/, 'a cite keeps its source address with its fragment');
});

test("the agent's artifact (manifest.artifact) passes through with its files by hash", async () => {
  const m = await model(artifact);
  assert.equal(m.artifact?.entry, 'index.html');
  assert.equal(Object.keys(m.artifact?.files ?? {}).length, 3);
  assert.equal(m.threads.length, 0);
});

test('a tool call reads as its name, the file or URL it acted on, then its short arguments', () => {
  assert.equal(chatToolTitle('read', { path: 'notes.pdf#page=2' }), 'read notes.pdf#page=2');
  assert.equal(chatToolTitle('read', { path: 'clip.webm', from_s: 30, to_s: 50, ask: 'What happens in these frames, and what changes across them?' }), 'read clip.webm from_s=30 to_s=50');
  assert.equal(chatToolTitle('code', { code: 'const a = 1;\nreturn a;' }), 'code const a = 1;');
  assert.equal(chatToolTitle('submit', undefined), 'submit');
});

test("a cite's address keeps its file and fragment however the fragment is written", () => {
  assert.equal(chatCiteHref('#page=2', 'notes.pdf'), 'notes.pdf#page=2');
  assert.equal(chatCiteHref('page=2&xywh=percent:1,2,3,4', 'notes.pdf'), 'notes.pdf#page=2&xywh=percent:1,2,3,4');
  assert.equal(chatCiteHref('other.pdf#page=1', 'notes.pdf'), 'other.pdf#page=1');
  assert.equal(chatCiteHref('', 'notes.pdf', 'notes.pdf#page=9'), 'notes.pdf#page=9');
});

test('a line with its own start is a span under the call it names as parent, or under the call holding its start', async () => {
  const { recording } = opened(referenceJob);
  const start = recording.lines.find((line) => line.kind === 'tool_execution_start')!;
  const callId = (start.data as { toolCallId: string }).toolCallId;
  const inner = JSON.stringify({ channel: 'live', source: 'vision', kind: 'model.call', t0: start.t + 1, t: start.t + 2, conv: start.conv, data: { parentToolCallId: callId, tool: 'see', model: 'eyes-1' } });
  const m = await model(referenceJob, (events) => `${events.trimEnd()}\n${inner}\n`);
  const span = m.spans.find((each) => each.actor === 'inner' && each.lane === 'see');
  assert.ok(span, 'the inner call is drawn');
  assert.equal(span.t0, start.t + 1);
  assert.equal(span.t1, start.t + 2);
  assert.equal(span.parentLane, `tool ${(start.data as { toolName: string }).toolName}`);
  assert.equal(span.label, 'see eyes-1');
});

test('every look of a write is a source, keyed by its own record, with the picture it was shown', async () => {
  const { recording } = opened(referenceJob);
  const shown = recording.lines.flatMap((line) => line.blobs ?? []).find((sha) => (recording.blobType(sha) ?? '').startsWith('image/'))!;
  assert.ok(shown, 'the recording holds a picture');
  const look = (key: string, path: string) => ({ receipt: `evidence/${key}.json`, record: { tool: 'see', args: { path }, body: 'a seal', facts: { key } }, images: [{ type: 'image', mimeType: 'image/png', blob: shown }] });
  const write = JSON.stringify({ channel: 'durable', source: 'vision', kind: 'vision.looks', t: 1, data: { doc: 'vision.looks', key: 'k1', value: { looks: [look('k1', 'a.pdf#page=1'), look('k2', 'a.pdf#page=2')] }, version: 1 } });
  const m = await model(referenceJob, (events) => `${events.trimEnd()}\n${write}\n`);
  assert.equal(m.sources.k1?.href, 'a.pdf#page=1');
  assert.equal(m.sources.k2?.href, 'a.pdf#page=2');
  assert.deepEqual(m.sources.k2?.media, [shown]);
});

test('a look over several addresses opens at its first and keeps the rest in order', async () => {
  const write = JSON.stringify({ channel: 'durable', source: 'vision', kind: 'vision.looks', t: 1, data: { doc: 'vision.looks', key: 'k3', value: { looks: [{ record: { tool: 'see', args: { path: 'a.pdf#page=1, a.pdf#page=2, b.pdf#page=1' }, body: 'two notes', facts: { key: 'k3' } }, images: [] }] }, version: 1 } });
  const m = await model(referenceJob, (events) => `${events.trimEnd()}\n${write}\n`);
  assert.equal(m.sources.k3?.href, 'a.pdf#page=1');
  assert.deepEqual(m.sources.k3?.more, ['a.pdf#page=2', 'b.pdf#page=1']);
});

/** Each event line rewritten by `change`; a line it returns undefined for is dropped. */
const eachLine = (change: (line: Record<string, Json>) => Record<string, Json> | undefined) => (events: string) =>
  events.split('\n').filter((text) => text.trim()).flatMap((text) => { const line = change(JSON.parse(text) as Record<string, Json>); return line ? [JSON.stringify(line)] : []; }).join('\n');

test("a recording with no times keeps its timeline, placed by the file's order", async () => {
  const m = await model(referenceJob, eachLine(({ t: _t, t0: _t0, ...line }) => line));
  assert.equal(m.inOrder, true);
  assert.ok(m.spans.length > 0);
  const tools = m.spans.filter((span) => span.actor === 'tool');
  assert.deepEqual(tools.map((span) => span.t0), [...tools.map((span) => span.t0)].sort((a, b) => a - b), 'spans keep the order of their lines');
  assert.equal((await model(referenceJob)).inOrder, undefined);
});

test("with no workflow input, the conversation's first user entry is the person's message as recorded", async () => {
  const m = await model(referenceJob, eachLine((line) => (line.kind === 'agentrun.workflow' ? undefined : line)));
  assert.equal(m.input, undefined);
  assert.equal(items(m)[0]?.kind, 'user');
});

test("a cite with no look keeps its own picture and says what it is; a row keeps its note", async () => {
  const m = await model(hearAndFind);
  const cites = m.answer?.rows.flatMap((row) => row.cites) ?? [];
  const kept = cites.find((cite) => cite.blob);
  assert.ok(kept, 'the kept frame is cited by its blob');
  assert.equal(kept.look, undefined);
  assert.equal(kept.label, 'the frame, with the box Jev drew');
  assert.ok(kept.href.startsWith('#t=28'), kept.href);
  assert.ok(m.answer?.rows.every((row) => row.note), 'each row keeps its explanation');
});

test("a takeaway is the result's first line with words, and an artifact's files are blobs the recording names", async () => {
  for (const card of tools(await model(referenceJob))) assert.match(card.takeaway || 'x', /[\p{L}\p{N}]/u, card.title);
  const { recording } = opened(artifact);
  const files = Object.values((recording.manifest as { artifact?: { files: Record<string, string> } }).artifact!.files);
  for (const sha of files) assert.ok(blobsNamed(recording.manifest, recording.lines).includes(sha));
});
