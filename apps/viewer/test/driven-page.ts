// A page in a headless Chrome driven over its debugging protocol: what an expression in the page evaluates to, and a
// close that ends the browser and every process it started, its crash handler included, before its profile is removed.
// A browser a test leaves open would keep the test's process alive: `closeLeftBrowsers` ends and names each one.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name); } catch { /* already ended */ } };

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

export async function drivenPage(url: string, profile: string) {
  // Its own process group: the browser and every helper it starts are ended together, by the group's pid.
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1280,1600', url], { stdio: 'ignore', detached: true });
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
    socket?.close();
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json() as { webSocketDebuggerUrl: string };
      const whole = new WebSocket(webSocketDebuggerUrl);
      await Promise.race([new Promise((resolve) => whole.addEventListener('open', resolve)), sleep(3000)]);
      whole.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    } catch { /* not answering: killed below */ }
    handlers = [...new Set([...handlers, ...crashHandlersOf(pid)])];
    if (!await ended(10_000)) signal(-pid, 'SIGKILL');
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
  for (let tries = 0; tries < 200 && !port; tries += 1) { await sleep(100); try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not up yet */ } }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
  socket = new WebSocket((targets.find((target) => target.type === 'page' && target.url.startsWith(url)) ?? targets.find((target) => target.type === 'page'))!.webSocketDebuggerUrl);
  await new Promise((resolve) => socket!.addEventListener('open', resolve));
  const waiting = new Map<number, (value: unknown) => void>();
  socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } }; if (message.id !== undefined) waiting.get(message.id)?.(message.result?.result?.value); });
  let id = 0;
  const evaluate = (expression: string) => new Promise((resolve) => { id += 1; waiting.set(id, resolve); socket!.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  // A browser starts on a blank page and then opens the URL: the page is handed over once its own document has loaded.
  for (let tries = 0; tries < 300 && await evaluate(`document.readyState === 'complete' && location.href !== 'about:blank'`) !== true; tries += 1) await sleep(100);
  handlers = crashHandlersOf(pid);
  return { evaluate, sleep, close };
}

/** Ends every browser a test started and did not close, and names them: a file's `after` fails on any. */
export async function closeLeftBrowsers(): Promise<number[]> {
  const left = [...open.keys()];
  for (const close of [...open.values()]) await close().catch(() => undefined);
  return left;
}
