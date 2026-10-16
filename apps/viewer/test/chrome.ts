// Headless Chrome for the viewer's tests, driven over the DevTools protocol in real time, every wait bounded and every
// process killed. Chrome runs in a process group of its own, killed whole with SIGKILL when a test is done with it, a bound
// passes or the test's signal aborts, so no helper it started (a renderer, the GPU process) is left behind. Two things
// once held a CI job to its limit and are not used here: `spawnSync`, whose timeout sends SIGTERM and then waits for the
// process to exit with the event loop blocked, and `--dump-dom` with `--virtual-time-budget`, which now and then never
// finishes. Nothing here waits on a socket or a page without a bound that names what it waited for.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
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

/** A page in headless Chrome driven over the DevTools protocol, in real time. Chrome must be listening within `launchMs`,
 *  and every request to it answers within `requestMs`; `close` ends Chrome and every process it started, and never throws,
 *  and so does `signal`'s abort (a test's timeout). */
export async function drivenPage(url: string, profile: string, { launchMs = 20_000, requestMs = 10_000, path = chrome, signal }: { launchMs?: number; requestMs?: number; path?: string; signal?: AbortSignal } = {}) {
  // A profile used before may still hold the port file of a Chrome that is gone.
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
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
    // An answer that can no longer come fails at once: the socket closed or failed, or Chrome exited.
    const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let gone: string | undefined;
    const failAll = (why: string) => { gone ??= why; for (const each of waiting.values()) each.reject(new Error(why)); waiting.clear(); };
    opened.addEventListener('close', () => failAll('the DevTools socket closed'));
    opened.addEventListener('error', () => failAll('the DevTools socket failed'));
    void exited.then(() => failAll('Chrome exited'));
    opened.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } };
      if (message.id !== undefined) waiting.get(message.id)?.resolve(message.result?.result?.value);
    });
    let id = 0;
    const evaluate = (expression: string) => {
      id += 1;
      const mine = id;
      return within(requestMs, `the page evaluating ${expression.slice(0, 60)}`, new Promise((resolve, reject) => {
        if (gone) { reject(new Error(gone)); return; }
        waiting.set(mine, { resolve, reject });
        opened.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      })).finally(() => waiting.delete(mine));
    };
    /** Until `expression` is true on the page, polled, within `ms`; then the value of `read`. */
    const once = async (expression: string, read: string, ms: number, what: string) => {
      for (const until = Date.now() + ms; Date.now() < until && !signal?.aborted;) {
        if (await evaluate(expression)) return evaluate(read);
        await sleep(100);
      }
      throw new Error(`${what}: not so after ${ms / 1000} s`);
    };
    return { evaluate, once, sleep, close };
  } catch (error) {
    await close();
    throw error;
  }
}
