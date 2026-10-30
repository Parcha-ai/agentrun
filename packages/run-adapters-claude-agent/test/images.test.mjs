// A host tool that answers with an image (a screenshot), on the Claude Agent adapter. The image is checked when the tool
// answers (a type the API takes, at most the adapter's size), recorded with the call's outcome, sent to the model inline,
// and, on the pinned CLI, still in the history a session resumed in a NEW directory sends: from the store, never from the
// file the CLI kept in the directory it no longer has.
//
// Without the pinned CLI the CLI tests skip; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) they run.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { CLAUDE_AGENT_MAX_IMAGE_BYTES, claudeAgentAdapter, toolImageProblems, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-images-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODEL = 'claude-sonnet-5-5';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test("a tool's images are checked: one of the API's four types, at most the size, else refused by the tool's name and the image", () => {
  assert.equal(CLAUDE_AGENT_MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  assert.equal(toolImageProblems('shot', [{ mimeType: 'image/png', data: PNG }]), undefined);
  assert.match(toolImageProblems('shot', [{ mimeType: 'image/png', data: PNG }, { mimeType: 'image/svg+xml', data: PNG }]), /shot's image 2 is image\/svg\+xml/);
  assert.match(toolImageProblems('shot', [{ mimeType: 'image/png', data: 'A'.repeat(101) }], 100), /shot's image 1 is 101 bytes of base64, more than 100/);
  assert.match(toolImageProblems('shot', [{ mimeType: 'image/png', data: 'not base64!' }]), /shot's image 1 is not base64/);
  assert.throws(() => claudeAgentAdapter({ model: 'm', provider: { origin: 'https://x.invalid', credential: () => 'k' }, maxImageBytes: 11 * 1024 * 1024 }), /maxImageBytes/);
});

test("an image over the adapter's size is the call's error, by the tool's name and the image, and the session goes on", async (t) => {
  process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
  t.after(() => { delete process.env.AGENTRUN_CLAUDE_AGENT_STANDIN; });
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ builtins: false, model: 'claude-test', provider: { origin: provider.url, credential: () => 'k' }, sessionsDir: join(mkdtempSync(join(ROOT, 'cap-')), 's'), standIn: { command: process.execPath }, maxImageBytes: 100, sdk: fakeSdk({ remoteModel: true, mirrorLagMs: 5, script: ['call shot {}', 'call submit {"value":{"answer":"ok"}}'] }) });
  const shot = { name: 'shot', description: 'A screenshot.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'the page', images: [{ mimeType: 'image/png', data: 'A'.repeat(200) }] }) };
  const events = [];
  const store = memorySessionStore();
  const runNode = createHarnessRunner(adapter, { store, tools: [shot], onEvent: (e) => events.push(e) });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'cap', system: [], user: 'Go.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['shot'] }), { answer: 'ok' });
  assert.ok(events.some((e) => e.type === 'tool_end' && e.name === 'shot' && e.isError === true), 'the call failed');
  const records = JSON.stringify(await Promise.all(store.keys().map((k) => store.read(k))));
  assert.match(records, /the tool shot's image 1 is 200 bytes of base64, more than 100/, 'by the tool and the image, in the call\'s recorded outcome');
});

/** The tool_result blocks of a request, by the call each answers. */
const results = (body) => (body?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b?.type === 'tool_result');

test("on the pinned CLI, a tool's image reaches the model inline in its result, with no note of a local file, and is still there when the session is resumed in a NEW directory", { skip, timeout: 240_000 }, async (t) => {
  let main = 0;
  // Turn 1 takes the screenshot, turn 2 asks for a never tool (which the kill cuts off), turn 3 answers.
  const provider = await fakeAnthropic({ reply: (r) => {
    if (r.model !== MODEL) return { text: 'ok' };
    main += 1;
    if (main === 1) return { tool: { name: 'mcp__hands__shot', input: {} } };
    if (main === 2) return { tool: { name: 'mcp__hands__charge', input: { amount: 5 } } };
    return { text: 'done' };
  } });
  t.after(() => provider.close());
  let shots = 0;
  const shot = { name: 'shot', description: 'A screenshot of the page.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => { shots += 1; return { text: 'the page', images: [{ mimeType: 'image/png', data: PNG }] }; } };
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const charge = { name: 'charge', description: 'Charge.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }, replay: 'never', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  const spec = { key: 'step:images', label: 'shot', system: ['Look at the page.'], tools: [shot, charge], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const adapterIn = (dir) => claudeAgentAdapter({ builtins: false, model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: dir });

  const died = new AbortController();
  const a = await adapterIn(mkdtempSync(join(ROOT, 'a-'))).open(spec, { store, writer: await store.open(spec.key), models, signal: died.signal, onEvent: () => {} });
  await a.send('Look at the page, then charge.');
  await reached;
  died.abort(new Error('the process died'));
  await a.turnEnd();
  await a.close();
  const second = provider.messages().filter((r) => r.model === MODEL)[1]?.body;
  const first = results(second).find((r) => Array.isArray(r.content) && r.content.some((c) => c.type === 'image'));
  assert.ok(first, `the image reached the model in its tool's result: ${JSON.stringify(results(second)).slice(0, 300)}`);
  const image = first.content.find((c) => c.type === 'image');
  assert.deepEqual(image.source, { type: 'base64', media_type: 'image/png', data: PNG });
  assert.ok(!JSON.stringify(first).includes('[Image: source:'), 'no note of a local file');

  // The next process, in a NEW directory: the CLI's own file is gone; the history comes from the store.
  const b = await adapterIn(mkdtempSync(join(ROOT, 'b-'))).open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  await b.recover();
  assert.equal((await b.turnEnd()).status, 'completed');
  await b.close();
  const third = provider.messages().filter((r) => r.model === MODEL)[2]?.body;
  const kept = results(third).find((r) => Array.isArray(r.content) && r.content.some((c) => c.type === 'image'));
  assert.ok(kept, `the resumed request still holds the image: ${JSON.stringify(results(third)).slice(0, 300)}`);
  assert.deepEqual(kept.content.find((c) => c.type === 'image').source, { type: 'base64', media_type: 'image/png', data: PNG });
  assert.ok(!JSON.stringify(third).includes('[Image: source:'), 'no note of a local file after the resume either');
  assert.equal(shots, 1, 'the screenshot was taken once');
});
