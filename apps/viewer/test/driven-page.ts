// A page in a headless Chrome driven over its debugging protocol, in real time: what an expression in the page evaluates
// to, and a close that ends the browser and every process it started, its crash handler included, before its profile is
// removed. A browser a test leaves open would keep the test's process alive: `closeLeftBrowsers` ends and names each one.
// Every wait is bounded and names what it waited for: the browser must be listening within `launchMs` (one that is not is
// ended and started once more, as a loaded machine can hang one start and not the next), every request to
// it answers within `requestMs`, and an answer that can no longer come (the socket closed or failed, the browser exited)
// fails at once. Two things once held a CI job to its limit and are not used: `spawnSync`, whose timeout sends SIGTERM and
// then waits for the process to exit with the event loop blocked, and `--dump-dom` with `--virtual-time-budget`, which now
// and then never finishes.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name); } catch { /* already ended */ } };

/** `promise`, or a failure that names `what` once `ms` have passed. */
export function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: nothing after ${ms / 1000} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The crash handler a browser started. It leaves the browser's process group, so it is found by the pid the group's
 *  processes name for it. */
function crashHandlersOf(group: number): number[] {
  if (!existsSync('/proc')) return [];
  const found = new Set<number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) !== group) continue;
      const named = /--crashpad-handler-pid=(\d+)/.exec(readFileSync(`/proc/${name}/cmdline`, 'utf8'));
      if (named) found.add(Number(named[1]));
    } catch { /* ended while read */ }
  }
  return [...found];
}

/** Every browser started and not yet closed, by its pid, with the close that ends it. */
const open = new Map<number, () => Promise<void>>();

export type DrivenPage = Awaited<ReturnType<typeof drivenPage>>;
type Options = { launchMs?: number; requestMs?: number; path?: string; signal?: AbortSignal };

/** A browser that did not write its DevToolsActivePort within `launchMs`. */
class NotListening extends Error {}

/** A page in its own headless Chrome. `signal`'s abort (a test's timeout) kills the browser's group at once, before the
 *  test's cleanup removes what it uses; `path` is the browser to start (a stand-in in the bounds' own test). A browser
 *  that is not listening within `launchMs` is ended, and one more is started: never after the signal's abort. */
export async function drivenPage(url: string, profile: string, options: Options = {}) {
  try {
    return await startedPage(url, profile, options);
  } catch (error) {
    if (!(error instanceof NotListening) || options.signal?.aborted) throw error;
    return startedPage(url, profile, options);
  }
}

async function startedPage(url: string, profile: string, { launchMs = 30_000, requestMs = 10_000, path = chrome, signal: aborted }: Options) {
  // A profile used before may still hold the port file of a browser that is gone.
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  // Its own process group: the browser and every helper it starts are ended together, by the group's pid.
  const browser = spawn(path, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1280,1600', url], { stdio: 'ignore', detached: true });
  const pid = browser.pid!;
  const exited = new Promise<true>((resolve) => { if (browser.exitCode !== null || browser.signalCode !== null) resolve(true); else browser.once('exit', () => resolve(true)); });
  const ended = (ms: number) => Promise.race([exited, sleep(ms).then(() => false)]);
  let handlers: number[] = [];
  let port: string | undefined;
  let socket: WebSocket | undefined;
  let closing: Promise<void> | undefined;
  /** Ends the browser: closed as a browser closes, its group killed when it does not end in time, and awaited, its crash
   *  handler too, so nothing still writes to the profile. Throws when something of it is still running. */
  const close = () => closing ??= (async () => {
    try { socket?.close(); } catch { /* closed already */ }
    if (port !== undefined && !aborted?.aborted) {
      try {
        const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json() as { webSocketDebuggerUrl: string };
        const whole = new WebSocket(webSocketDebuggerUrl);
        await Promise.race([new Promise((resolve) => whole.addEventListener('open', resolve)), sleep(3000)]);
        whole.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch { /* not answering: killed below */ }
    }
    handlers = [...new Set([...handlers, ...crashHandlersOf(pid)])];
    if (!await ended(port === undefined ? 0 : 10_000)) signal(-pid, 'SIGKILL');
    await ended(5000);
    for (let tries = 0; tries < 100 && (running(-pid) || handlers.some(running)); tries += 1) {
      if (tries === 50) { signal(-pid, 'SIGKILL'); for (const handler of handlers) signal(handler, 'SIGKILL'); }
      await sleep(100);
    }
    open.delete(pid);
    const left = [...(running(-pid) ? [`group ${pid}`] : []), ...handlers.filter(running).map((handler) => `crash handler ${handler}`)];
    if (left.length) throw new Error(`the browser ${pid} did not end: ${left.join(', ')} still running`);
  })();
  open.set(pid, close);
  // A test that times out aborts its signal: the browser's group goes at once.
  aborted?.addEventListener('abort', () => { handlers = [...new Set([...handlers, ...crashHandlersOf(pid)])]; signal(-pid, 'SIGKILL'); }, { once: true });
  try {
    // A deadline of its own, never a loop left running after its wait gave up.
    for (const until = Date.now() + launchMs; !port && Date.now() < until && !aborted?.aborted;) {
      try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] || undefined; } catch { /* not up yet */ }
      if (!port) await sleep(100);
    }
    if (!port) throw new NotListening(`Chrome starting (its DevToolsActivePort): nothing after ${launchMs / 1000} s`);
    const targets = await within(requestMs, 'Chrome listing its pages', fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((each) => each.type === 'page' && each.url.startsWith(url)) ?? targets.find((each) => each.type === 'page');
    if (!target) throw new Error(`Chrome has no page for ${url}`);
    const opened = new WebSocket(target.webSocketDebuggerUrl);
    socket = opened;
    await within(requestMs, 'the DevTools socket opening', new Promise((resolve, reject) => { opened.addEventListener('open', resolve); opened.addEventListener('error', reject); }));
    // An answer that can no longer come fails at once: the socket closed or failed, or the browser exited.
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
        opened.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      })).finally(() => waiting.delete(mine));
    };
    /** Until `expression` is true on the page, polled, within `ms`; then the value of `read`. */
    const once = async (expression: string, read: string, ms: number, what: string) => {
      for (const until = Date.now() + ms; Date.now() < until && !aborted?.aborted;) {
        if (await evaluate(expression)) return evaluate(read);
        await sleep(100);
      }
      throw new Error(`${what}: not so after ${ms / 1000} s`);
    };
    // A browser starts on a blank page and then opens the URL: the page is handed over once its own document has loaded.
    await once(`document.readyState === 'complete' && location.href !== 'about:blank'`, 'true', 30_000, `the page at ${url} loading`);
    handlers = crashHandlersOf(pid);
    return { evaluate, once, sleep, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/** A test's cleanup: ends every page, each tried even when one fails, then runs `then` (its servers closed, its
 *  directory removed) whatever happened, and throws the first failure. A browser that did not end fails its test, and
 *  nothing the test held is left open to keep its process alive. */
export async function closeAll(pages: readonly { close(): Promise<void> }[], then: () => void): Promise<void> {
  const failed: unknown[] = [];
  for (const page of pages) await page.close().catch((error: unknown) => { failed.push(error); });
  try { then(); } finally { if (failed.length) throw failed[0]; }
}

/** Ends every browser a test started and did not close, and names them: a file's `after` fails on any. */
export async function closeLeftBrowsers(): Promise<number[]> {
  const left = [...open.keys()];
  for (const close of [...open.values()]) await close().catch(() => undefined);
  return left;
}
