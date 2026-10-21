// A run's title is one rule wherever it is shown (chatTitle): the artifact's title, else the first line of the input's
// question, else the recording's title. The chat view, the gallery's list and the inspection view's header all use it.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { after, test } from 'node:test';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { chatGivenInput, chatTitle } from '../src/chat-extract.ts';
import type { Line, Manifest } from '../src/format.ts';
import { chrome, closeAll, closeLeftBrowsers, drivenPage } from './driven-page.ts';

const fixtures = new URL('fixtures/', import.meta.url).pathname;
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const manifest = (title: string, artifact?: string) => ({ title, ...(artifact ? { artifact: { title: artifact, entry: 'index.html', files: {} } } : {}) }) as unknown as Manifest;
/** A run whose one conversation a workflow node holds, given `input`. */
const driven = (input: unknown): Line[] => [
  { channel: 'durable', source: 'workflow', kind: 'agentrun.workflow', t: 1, data: { input: { input } } },
  { channel: 'durable', source: 'workflow', kind: 'agentrun.nodes', path: '/root', t: 2, data: { value: { conversation: 7 } } },
  { channel: 'durable', source: 'pi', kind: 'pi.user', conv: 7, t: 3, data: { conversationId: 7 } },
] as unknown as Line[];

test('a run\'s title: its artifact\'s, else its question\'s first line, else the recording\'s', () => {
  assert.equal(chatTitle(manifest('A Vision Agent', 'Vehicle sightings by kind')), 'Vehicle sightings by kind');
  assert.equal(chatTitle(manifest('A Vision Agent', 'Vehicle sightings by kind'), chatGivenInput(driven({ question: 'Which cars pass?' }))), 'Vehicle sightings by kind');
  assert.equal(chatTitle(manifest('A Vision Agent'), chatGivenInput(driven({ question: '\nWhere is the robot first seen?\nCite the moment.' }))), 'Where is the robot first seen?');
  assert.equal(chatTitle(manifest('A Vision Agent'), chatGivenInput(driven('Count the seals.'))), 'Count the seals.');
  assert.equal(chatTitle(manifest('A Vision Agent')), 'A Vision Agent');
  // A conversation no node holds is a person's: its run's workflow input is not the run's question.
  const personal = [...driven({ question: 'Not the title' }), { channel: 'durable', source: 'pi', kind: 'pi.user', conv: 9, t: 4, data: { conversationId: 9 } }] as unknown as Line[];
  assert.equal(chatTitle(manifest('A Vision Agent'), chatGivenInput(personal)), 'A Vision Agent');
});

const TITLES = ['Vehicle sightings by kind', 'Where the golden robot first appears', 'Marks on the original and on the test copy'];

test('in Chrome: the gallery\'s list and the inspection view\'s header show each run\'s own title, not the recording\'s', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-titles-'));
  const held: { page?: Awaited<ReturnType<typeof drivenPage>>; server?: ReturnType<typeof createServer> } = {};
  t.after(() => closeAll(held.page ? [held.page] : [], () => {
    held.server?.closeAllConnections();
    held.server?.close();
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }), { timeout: 20_000 });
  // Three runs of one recording, each with its own artifact title and the same recording title.
  for (const [i, title] of TITLES.entries()) {
    const dir = join(out, 'recordings', `run-${i + 1}`);
    cpSync(join(fixtures, 'chat-artifact'), dir, { recursive: true });
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    // The inspection view's header also reads when, with what code and on which model the run was recorded.
    const recorded = { recorded: { started: '2026-10-20T00:00:00.000Z', ended: '2026-10-20T00:01:00.000Z' }, code: { repo: 'agentrun', commit: '0123456789abcdef', packages: {} }, model: 'a model', cost: { usd: 0, parts: {} } };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...recorded, ...m, title: 'A Vision Agent', artifact: { ...m.artifact, title } }, null, 2));
  }
  build(join(out, 'dist'), join(out, 'recordings'), { files: true });
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jsonl': 'text/plain', '.png': 'image/png', '.css': 'text/css' };
  const server = createServer((request, response) => {
    const file = join(out, 'dist', decodeURIComponent(new URL(request.url!, 'http://localhost').pathname));
    if (!file.startsWith(join(out, 'dist')) || !existsSync(file) || !extname(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  held.server = server;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${base}/index.html`, join(out, 'profile'), { signal: t.signal });
  held.page = page;
  try {
    await page.once(`document.querySelectorAll('ul.gallery li a').length === 3`, 'true', 20_000, 'the gallery\'s list drawn');
    const listed = JSON.parse(String(await page.evaluate(`JSON.stringify([...document.querySelectorAll('ul.gallery li a')].map((a) => a.textContent).sort())`)));
    assert.deepEqual(listed, [...TITLES].sort(), 'each run listed by its own title');
    await page.evaluate(`location.href = '${base}/index.html?r=run-2'`);
    await page.once(`document.querySelector('header h1')?.textContent === ${JSON.stringify(TITLES[1])}`, 'true', 20_000, 'the inspection view\'s header shows the run\'s title')
      .catch(async (error: Error) => { throw new Error(`${error.message}: ${String(await page.evaluate(`JSON.stringify({ href: location.href, h1: [...document.querySelectorAll('h1')].map((h) => h.textContent), body: document.body.innerText.slice(0, 200) })`))}`); });
  } finally {
    await page.close();
  }
});
