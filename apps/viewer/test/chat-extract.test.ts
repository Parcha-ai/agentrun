// The chat view's model is made from a recording's generic events alone: the same code gives every run its threads,
// tool cards and timeline, every label comes from an event field, and nothing is borrowed from another run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLines, type Json, type Recording } from '../src/format.ts';
import { chatCiteHref, chatCommandLine, chatSaid, chatToolTitle, extractChat } from '../src/chat-extract.ts';
import { blobsNamed, fromUrl } from '../src/load.ts';
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

const referenceJob = join(here, 'fixtures', 'reference-job');
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
  const script = tools(await model(hearAndFind)).find((card) => card.tool === 'code')!;
  assert.ok(script.detail?.includes('\n') && script.title.length < script.detail.length, 'a call whose one argument spans lines keeps it in full');
  assert.equal(tools(m).find((card) => card.tool === 'submit')?.takeaway, '', "the runner's reply to a delivery is not the run's");
  assert.equal(m.title, recording.manifest.title, 'an input with no question titles nothing; the recording does');
  const first = recording.lines.find((line) => line.kind === 'pi.user')!;
  const added = JSON.stringify({ ...first, t: first.t + 1, data: { ...(first.data as object), id: 9999, model: [{ role: 'user', content: 'Call submit.' }] } });
  const nudged = await model(referenceJob, (events) => `${events.trimEnd()}\n${added}\n`);
  const said = (m: ChatModel) => items(m).filter((item) => item.kind === 'host' || item.kind === 'user').map((item) => [item.kind, 'text' in item && item.text]);
  assert.deepEqual(said(nudged), [['host', 'Call submit.']], "a later user entry in a conversation a workflow node holds is the runner's");
  const streaming = opened(referenceJob, (events) => `${events.trimEnd()}\n${added}\n`);
  const unfinished = { ...streaming.recording, manifest: { ...streaming.recording.manifest, recorded: { started: streaming.recording.manifest.recorded.started } } } as Recording;
  assert.deepEqual(said(await extractChat(unfinished, streaming.readJson)), [['host', 'Call submit.']], 'whether or not the recording has ended');
  // A person's own conversation, which no node holds: every entry the person's, and the workflow it ran no run input.
  const person = (id: number, text: string, at: number) => JSON.stringify({ ...first, conv: 77, path: undefined, t: first.t + at, data: { ...(first.data as object), conversationId: 77, id, model: [{ role: 'user', content: text }] } });
  const chatted = await model(referenceJob, (events) => `${events.trimEnd()}\n${person(9001, 'Quote A-1 for me.', 1)}\n${person(9002, 'Thanks. Do B-2 next.', 2)}\n`);
  assert.equal(chatted.input, undefined, "a workflow a person's conversation ran gives no run input");
  assert.deepEqual(said(chatted), [['user', 'Quote A-1 for me.'], ['user', 'Thanks. Do B-2 next.']], "in a conversation no node holds, every entry is the person's");
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
  // A call that made one look says what the look found; one that then failed keeps why, the look its own answer.
  const { recording } = opened(referenceJob);
  const start = recording.lines.find((line) => line.kind === 'tool_execution_start')!;
  const seen = { tool: 'see', args: { path: 'a.png' }, body: 'A round seal at the foot of the page.', facts: { key: 'k1' } };
  const looked = (events: string) => `${events.trimEnd()}\n${[
    { channel: 'live', source: 'vision', kind: 'LookEvent', t: start.t + 1, conv: start.conv, data: { tool: 'see', parentToolCallId: (start.data as { toolCallId: string }).toolCallId, record: seen } },
    { channel: 'durable', source: 'vision', kind: 'vision.looks', t: start.t + 1, data: { doc: 'vision.looks', key: 'k1', value: { looks: [{ record: seen, images: [] }] }, version: 1 } },
  ].map((line) => JSON.stringify(line)).join('\n')}\n`;
  assert.equal(tools(await model(referenceJob, looked))[0]?.takeaway, 'A round seal at the foot of the page.');
  const after = await model(referenceJob, (events) => looked(failed('Timed out after the look.')(events)));
  assert.deepEqual([tools(after)[0]?.failed, tools(after)[0]?.takeaway, after.sources.k1?.takeaway], [true, 'Timed out after the look.', 'A round seal at the foot of the page.']);
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
  const calls = tools(m).flatMap((item) => item.calls.map((call) => call.id));
  assert.ok(m.spans.every((span) => span.item === undefined || items(m).some((item) => item.id === span.item) || m.threads.some((thread) => thread.id === span.item) || calls.includes(span.item)));
});

test('every label comes from an event field: two different runs, the same kinds of labels, no constant titles', async () => {
  for (const dir of [referenceJob, hearAndFind]) {
    const m = await model(dir);
    const { recording } = opened(dir);
    const text = JSON.stringify(recording.lines);
    for (const span of m.spans) {
      if (span.actor === 'llm') assert.ok(text.includes(JSON.stringify(span.lane.slice('LLM '.length))), `${span.lane} is a model the recording names`);
      if (span.actor === 'tool') assert.ok(text.includes(`"toolName":${JSON.stringify(span.lane.slice('tool '.length))}`), `${span.lane} is a tool the recording calls`);
      if (span.actor === 'inner') {
        for (const word of span.lane.toLowerCase().split(' ')) assert.ok(text.includes(`"${word}`) || text.includes(`.${word}"`), `${span.lane} is an inner call the recording files`);
        assert.ok(span.label.startsWith(span.lane), `${span.label} is named by its lane`);
      }
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

test('a command that opens a quote or a here-document on its first line is titled with the lines of its body', () => {
  const script = 'python3 -c "\nimport fitz\n# open it\n\ndoc = fitz.open(\'a.pdf\')\nprint(doc.page_count)\n"';
  assert.equal(chatCommandLine(script), 'python3 -c " import fitz; doc = fitz.open(\'a.pdf\'); print(doc.page_count)');
  const long = `python3 -c "\nimport subprocess\nfor p in range(310, 325):\n    subprocess.run(['pdftoppm', '-f', str(p), '-l', str(p), 'transcript.pdf', 'out'])\n"`;
  assert.equal(chatToolTitle('bash', { command: long }), `bash ${chatCommandLine(long).slice(0, 89)}…`, 'truncated');
  assert.equal(chatCommandLine("cat <<'EOF' > notes.md\n# Notes\nfirst line\nEOF"), "cat <<'EOF' > notes.md first line");
  assert.equal(chatCommandLine('du -sh report/\ndu -h report/*'), 'du -sh report/', 'a closed first line is the title alone');
  assert.equal(chatCommandLine('echo "done"\nls'), 'echo "done"');
});

test("a call whose title clips its one argument keeps it whole where its card opens; one its title shows whole needs no more", async () => {
  const command = `grep -n "incorporated" ${Array.from({ length: 12 }, (_, n) => `filings/part-${n}.txt`).join(' ')}`;
  const clipped = tools(await model(referenceJob, editFirst('pi.assistant', (data) => { ((data.model[0]!.content as Json[])[0] as Record<string, Json>).arguments = { command }; })))[0]!;
  assert.ok(!command.includes('\n') && clipped.title.endsWith('…'), clipped.title);
  assert.equal(clipped.detail, command, 'a command of one line its title clips');
  const whole = tools(await model(referenceJob))[0]!;
  assert.ok(whole.title.length < 90 && whole.detail === undefined, whole.title);
});

test('a look keeps what it asked in words, never a typed request', async () => {
  const code = tools(await model(hearAndFind)).find((item) => item.calls.length > 0)!;
  assert.equal(code.calls[0]!.ask, undefined, 'a transcription asks nothing');
  assert.equal(code.calls.find((call) => call.judge)!.ask, undefined, "a judge's typed request is no words");
  const asked = code.calls.find((call) => call.ask);
  assert.ok(asked && !asked.ask!.startsWith('{'), 'a look asked in words keeps its ask');
});

test("a redacted thought keeps its mark and none of the provider's placeholder", async () => {
  const m = await model(hearAndFind, editFirst('pi.assistant', (data) => { (data.model[0]!.content as Json[]).unshift({ type: 'thinking', thinking: '[Reasoning redacted]', redacted: true }); }));
  const thought = items(m).find((item) => item.kind === 'thinking');
  assert.deepEqual(thought && { text: thought.text, redacted: 'redacted' in thought && thought.redacted }, { text: '', redacted: true });
});

test("a look's answer says its first sentence with words: no lead-in, heading, marker or typed answer", () => {
  assert.equal(chatSaid('Based on page 1 of the document:\n\n* **The seal** sits at the bottom. It is round.'), '**The seal** sits at the bottom.');
  assert.equal(chatSaid('### Description of Pages 3 and 4\n**Page 3:**\nThe certificate itself begins here. More.'), 'The certificate itself begins here.');
  assert.equal(chatSaid('**Is there a FILED stamp?**\nYes, at the top right of page 3.'), 'Yes, at the top right of page 3.', 'a wholly bold line is a heading');
  assert.equal(chatSaid('*Cut 3 (05:52)*\n> CUT 1 shows the orbit.'), 'CUT 1 shows the orbit.');
  assert.equal(chatSaid('Signed by Jeffrey W. Bullock, Secretary of State. Dated 2022.'), 'Signed by Jeffrey W. Bullock, Secretary of State.', 'never cut at an initial');
  assert.equal(chatSaid('1.00\t3.15\tWe copy you down.'), 'We copy you down.');
  assert.equal(chatSaid('* **Is there a stamp?** **No**, there is none. The page is plain.'), '**Is there a stamp?** **No**, there is none.', 'a question it repeats stays with its answer');
  assert.equal(chatSaid('{"here":{"type":"noul","noul":0.9}}'), undefined, 'a typed answer says nothing in words');
  assert.equal(chatSaid(''), undefined);
});

test("a step that only ran a command or a script, with no look and no picture, is plumbing; the run's input splits its question and files", async () => {
  const m = await model(hearAndFind);
  for (const item of tools(m)) assert.equal(item.plumbing, item.calls.some((call) => call.look) || item.media.length > 0 || item.tool === 'submit' ? undefined : true, item.title);
  const asked = await model(referenceJob, eachLine((line) => (line.kind === 'agentrun.workflow'
    ? { ...line, data: { ...(line.data as Record<string, Json>), input: { input: { question: 'Which marks?', files: ['a.pdf', 'b.pdf'], example: 'x' } } } } : line)));
  assert.deepEqual(asked.input, { question: 'Which marks?', files: ['a.pdf', 'b.pdf'], fields: [{ name: 'example', value: 'x' }] });
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
  const span = m.spans.find((each) => each.actor === 'inner' && each.lane === 'See');
  assert.ok(span, 'the inner call is drawn');
  assert.equal(span.t0, start.t + 1);
  assert.equal(span.t1, start.t + 2);
  assert.equal(span.parentLane, `tool ${(start.data as { toolName: string }).toolName}`);
  const call = tools(m).flatMap((item) => item.calls).find((each) => each.id === span.item);
  assert.ok(call, 'the span scrolls to its call');
  assert.deepEqual([call.name, call.label, call.model], ['See', 'See', 'eyes-1']);
});

test("each model call inside a tool is its own entry under the tool's card: its name, its scores, the boxes it drew, its raw output", async () => {
  const m = await model(hearAndFind);
  const code = tools(m).find((item) => item.calls.length > 0)!;
  assert.deepEqual(code.calls.map((call) => call.label).slice(0, 2), ['Scripted transcribe · We copy you down, Eagle. Houston, uh,', 'Jev judge · 0.05']);
  for (const call of code.calls) {
    assert.ok(call.look && m.sources[call.look], `${call.label} names its look`);
    assert.equal(m.spans.find((span) => span.item === call.id)?.label, call.label, 'its span reads the same');
  }
  assert.match(code.calls.find((call) => call.label.includes('box drawn'))!.raw, /^\{\n {2}"/, 'a JSON output is indented');
  for (const call of code.calls) {
    const judge = call.name.endsWith(' judge');
    assert.equal(call.judge, judge ? true : undefined, `${call.label}: a judge's call, and only one, carries the judge's accent`);
    assert.equal(m.spans.find((span) => span.item === call.id)?.judge, call.judge, 'its span too');
  }
  // Jev's answer shapes, each one look under the first tool call.
  const { recording } = opened(referenceJob);
  const start = recording.lines.find((line) => line.kind === 'tool_execution_start')!;
  const look = (key: string, body: Record<string, Json>) => JSON.stringify({ channel: 'live', source: 'vision', kind: 'LookEvent', t: start.t + 1, conv: start.conv,
    data: { tool: 'vision.judge', model: 'jev-1', parentToolCallId: (start.data as { toolCallId: string }).toolCallId, record: { args: { path: 'a.png', via: 'jev' }, body: JSON.stringify(body), facts: { key } } } });
  const box = (confidence: number) => ({ type: 'box', confidence, fragment: 'a.png#xywh=percent:1,2,3,4' });
  const lines = [look('j1', { seal: { type: 'noul', noul: 0.87 }, seal_at: box(0.4) }), look('j2', { contact: box(0.46), fuel: box(0.4) }), look('j3', { seal: { type: 'noul', noul: 0.2 }, seal_at: box(0.4) })];
  const judged = await model(referenceJob, (events) => `${events.trimEnd()}\n${lines.join('\n')}\n`);
  assert.deepEqual(tools(judged).flatMap((item) => item.calls).filter((call) => /^j\d$/.test(call.look ?? '')).map((call) => call.label), ['Jev judge · 0.87 · box drawn', 'Jev judge · contact 0.46 · fuel 0.40 · 2 boxes drawn', 'Jev judge · 0.20']);
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
  assert.equal(m.sources.k3?.pictures, undefined, 'no pictures, no pairing');
  const { recording } = opened(referenceJob);
  const shown = recording.lines.flatMap((line) => line.blobs ?? []).find((sha) => (recording.blobType(sha) ?? '').startsWith('image/'))!;
  const pictured = JSON.stringify({ channel: 'durable', source: 'vision', kind: 'vision.looks', t: 1, data: { doc: 'vision.looks', key: 'k4', value: { looks: [{ record: { tool: 'see', args: { path: 'a.pdf#page=1, a.pdf#page=2' }, body: 'two pages', facts: { key: 'k4' } }, images: [{ blob: shown }, { blob: shown }] }] }, version: 1 } });
  const both = await model(referenceJob, (events) => `${events.trimEnd()}\n${pictured}\n`);
  assert.deepEqual(both.sources.k4?.pictures, [{ href: 'a.pdf#page=1', sha: shown }, { href: 'a.pdf#page=2', sha: shown }]);
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

test("in a conversation no workflow node holds, the first user entry is the person's message as recorded", async () => {
  const m = await model(referenceJob, eachLine((line) => (line.kind === 'agentrun.nodes' ? undefined : line)));
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
  const enveloped = { ok: true, value: { pages: ['p-1.png', 'p-2.png'], seen: { text: 'two seals\nand a stamp' }, deep: { a: { b: 1 } } } };
  const m = await model(hearAndFind, editFirst('pi.tool-result', (data) => { data.model[0]!.content = [{ type: 'text', text: JSON.stringify(enveloped) }]; }));
  assert.equal(tools(m)[0]!.takeaway, 'pages: p-1.png, p-2.png · seen: text: two seals · deep: a: {"b":1}', "a tool's { ok, value } record reads as its value");
  const { recording } = opened(artifact);
  const files = Object.values((recording.manifest as { artifact?: { files: Record<string, string> } }).artifact!.files);
  for (const sha of files) assert.ok(blobsNamed(recording.manifest, recording.lines).includes(sha));
});

test('an .mp4 blob is a video, opens in place like a .webm, and is found in a recording opened by its URL (?src=)', async (t) => {
  const { typeOfName, opensInPage } = await import('../src/blobs.ts');
  assert.equal(typeOfName('film-descent.mp4'), 'video/mp4');
  assert.ok(opensInPage(typeOfName('film-descent.mp4')));
  // The reference job served over http, its agent's page holding a film.
  const dir = mkdtempSync(join(tmpdir(), 'viewer-src-mp4-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(referenceJob, dir, { recursive: true });
  const film = Buffer.from('a made-up film');
  const sha = createHash('sha256').update(film).digest('hex');
  writeFileSync(join(dir, 'blobs', `${sha}.mp4`), film);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, artifact: { title: 'A film', entry: 'index.html', files: { 'film.mp4': sha } } }));
  const server = createServer((request, response) => {
    const file = join(dir, decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(dir) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200).end(request.method === 'HEAD' ? undefined : readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const recording = await fromUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  assert.match(recording.blobUrl(sha) ?? '', new RegExp(`/blobs/${sha}\\.mp4$`));
  assert.equal(recording.blobType(sha), 'video/mp4');
});
