// A page in a headless Chrome driven over its debugging protocol: what an expression in the page evaluates to, and a
// close that waits for the browser to end, so its profile can be removed.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

export async function drivenPage(url: string, profile: string) {
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1280,1600', url], { stdio: 'ignore' });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let port: string | undefined;
  for (let tries = 0; tries < 200 && !port; tries += 1) { await sleep(100); try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not up yet */ } }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const socket = new WebSocket(targets.find((target) => target.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  const waiting = new Map<number, (value: unknown) => void>();
  socket.addEventListener('message', (event) => { const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } }; if (message.id !== undefined) waiting.get(message.id)?.(message.result?.result?.value); });
  let id = 0;
  const evaluate = (expression: string) => new Promise((resolve) => { id += 1; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  const exited = new Promise((resolve) => browser.once('exit', resolve));
  // Closed as a browser closes, so no helper of its is still writing to the profile when the test removes it.
  const close = async () => {
    socket.close();
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const whole = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve) => whole.addEventListener('open', resolve));
    whole.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await Promise.race([exited, sleep(10_000).then(() => browser.kill())]);
  };
  return { evaluate, sleep, close };
}
