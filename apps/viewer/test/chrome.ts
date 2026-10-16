// Headless Chrome for the viewer's tests, every wait bounded and every process killed. Chrome runs in a process group of
// its own, and the whole group is killed when a test is done with it or a bound passes: a helper Chrome started (a
// renderer, the GPU process) inherits Chrome's stdout, and one left behind holds that pipe open. `spawnSync` waits for the
// pipe to close, with the event loop blocked, so no test timeout can fire: that is how one test once held a CI job to its
// limit. Nothing here waits on a pipe, a socket or a page without a bound that names what it waited for.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const base = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check'];

/** `promise`, or a failure that names `what` once `ms` have passed. */
export function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: nothing after ${ms / 1000} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome and every process it started, killed: the group is Chrome's own (`detached`). */
function killGroup(browser: ChildProcess) {
  if (browser.pid === undefined) return;
  try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** The page's DOM after `--virtual-time-budget`, as `--dump-dom` prints it, within `ms`. */
export async function dumpDom(url: string, profile: string, { ms = 20_000, budget = 6000, path = chrome, signal }: { ms?: number; budget?: number; path?: string; signal?: AbortSignal } = {}): Promise<string> {
  const browser = spawn(path, [...base, `--user-data-dir=${profile}`, `--virtual-time-budget=${budget}`, '--dump-dom', url], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  // A test that times out aborts its signal: Chrome goes at once, before the test's cleanup removes what it uses.
  const abort = () => killGroup(browser);
  signal?.addEventListener('abort', abort, { once: true });
  let out = '';
  browser.stdout!.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  const exited = new Promise<void>((resolve, reject) => { browser.once('exit', () => resolve()); browser.once('error', reject); });
  const closed = new Promise<void>((resolve) => browser.stdout!.once('close', () => resolve()));
  try {
    await within(ms, `Chrome dumping ${url}`, signal ? Promise.race([exited, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error(`Chrome dumping ${url}: the test ended`)), { once: true }))]) : exited);
  } finally {
    // Its helpers go with it, so its stdout closes.
    killGroup(browser);
    signal?.removeEventListener('abort', abort);
  }
  await within(5000, `Chrome's output for ${url}`, closed);
  return out;
}

/** A page in headless Chrome driven over the DevTools protocol, in real time. Chrome must be listening within `launchMs`,
 *  and every request to it answers within `requestMs`; `close` ends Chrome and every process it started, and never throws,
 *  and so does `signal`'s abort (a test's timeout). */
export async function drivenPage(url: string, profile: string, { launchMs = 20_000, requestMs = 10_000, path = chrome, signal }: { launchMs?: number; requestMs?: number; path?: string; signal?: AbortSignal } = {}) {
  const browser = spawn(path, [...base, `--user-data-dir=${profile}`, '--remote-debugging-port=0', url], { detached: true, stdio: 'ignore' });
  let socket: WebSocket | undefined;
  const exited = new Promise<void>((resolve) => browser.once('exit', () => resolve()));
  const close = async () => {
    try { socket?.close(); } catch { /* closed already */ }
    killGroup(browser);
    await within(5000, 'Chrome exiting', exited).catch(() => undefined);
  };
  // A test that times out aborts its signal: Chrome goes at once, before the test's cleanup removes what it uses.
  signal?.addEventListener('abort', () => killGroup(browser), { once: true });
  try {
    // A deadline of its own, never a loop left running after its wait gave up.
    let port: string | undefined;
    for (const until = Date.now() + launchMs; !port && Date.now() < until && !signal?.aborted;) {
      try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] || undefined; } catch { /* not up yet */ }
      if (!port) await sleep(100);
    }
    if (!port) throw new Error(`Chrome starting (its DevToolsActivePort): nothing after ${launchMs / 1000} s`);
    const targets = await within(requestMs, 'Chrome listing its pages', fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((each) => each.type === 'page' && each.url.startsWith(url)) ?? targets.find((each) => each.type === 'page');
    if (!target) throw new Error(`Chrome has no page for ${url}`);
    const opened = new WebSocket(target.webSocketDebuggerUrl);
    socket = opened;
    await within(requestMs, 'the DevTools socket opening', new Promise((resolve, reject) => { opened.addEventListener('open', resolve); opened.addEventListener('error', reject); }));
    const waiting = new Map<number, (value: unknown) => void>();
    opened.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } };
      if (message.id !== undefined) waiting.get(message.id)?.(message.result?.result?.value);
    });
    let id = 0;
    const evaluate = (expression: string) => {
      id += 1;
      const mine = id;
      return within(requestMs, `the page evaluating ${expression.slice(0, 60)}`, new Promise((resolve) => { waiting.set(mine, resolve); opened.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); }))
        .finally(() => waiting.delete(mine));
    };
    return { evaluate, sleep, close };
  } catch (error) {
    await close();
    throw error;
  }
}
