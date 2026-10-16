// The disk panel grows to its content. It used to sit in the 520 px scroll box every panel gets, so on a desktop the paid-call
// list, and the line saying a charge was made once in one generation and settled by the next, was below the fold.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const noChrome = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` };
const fixtures = new URL('fixtures/', import.meta.url).pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the disk panel is not a scroll box: it is as tall as its content', noChrome, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-disk-layout-'));
  const url = `${pathToFileURL(join(out, 'dist', 'index.html')).href}?r=disk-takeover`;
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`, '--window-size=1400,900', '--remote-debugging-port=0', url], { stdio: 'ignore' });
  const exited = new Promise((resolve) => browser.once('exit', resolve));
  t.after(async () => { browser.kill(); await Promise.race([exited, sleep(10_000)]); rmSync(out, { recursive: true, force: true }); });
  build(join(out, 'dist'), fixtures);
  let port: string | undefined;
  for (let tries = 0; tries < 300 && !port; tries += 1) { await sleep(100); try { port = readFileSync(join(out, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not up yet */ } }
  assert.ok(port, 'Chrome is up');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const socket = new WebSocket(targets.find((target) => target.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  const waiting = new Map<number, (value: unknown) => void>();
  socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } }; if (message.id !== undefined) waiting.get(message.id)?.(message.result?.result?.value); });
  let id = 0;
  const evaluate = (expression: string) => new Promise<unknown>((resolve) => { id += 1; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
  const probe = `(() => { const disk = document.querySelector('.panel .disk'); const panel = disk && disk.closest('.panel'); if (!panel) return null;
    const style = getComputedStyle(panel); return { maxHeight: style.maxHeight, overflowY: style.overflowY, scroll: panel.scrollHeight, client: panel.clientHeight, calls: panel.querySelectorAll('.dk-call').length }; })()`;
  let got: { maxHeight: string; overflowY: string; scroll: number; client: number; calls: number } | null = null;
  for (let tries = 0; tries < 100 && !got; tries += 1) { await sleep(100); got = await evaluate(probe) as typeof got; }
  socket.close();
  assert.ok(got, 'the disk panel is drawn for a recording with a claim on a disk');
  assert.ok(got.calls > 0, 'it lists paid calls');
  assert.equal(got.maxHeight, 'none', 'no height cap');
  assert.equal(got.overflowY, 'visible', 'no scroll box');
  assert.ok(got.scroll <= got.client, `nothing is below the fold: content ${got.scroll}px in a box ${got.client}px`);
});
