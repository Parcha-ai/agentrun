// pi-browser's live view for a run's own Chrome, and the handoff port that goes with it: the agent's
// `browser_request_handoff` hands the browser to a person in the live view, and the call waits until they say they are done.
// The viewer is served on a loopback port of this process (never 0.0.0.0); its URL carries the viewer's token, which is full
// control of the browser, so it is written to one owner-only file and goes nowhere else: not to the model, a log, a status row
// or the recording.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { BrowserProvider, HandoffOutcome, HandoffPort } from '@parcha/pi-browser';
import { createLiveView, liveViewProvider, type LiveViewHost } from '@parcha/pi-browser/live-view';
import type { BrowserPlane } from './host.ts';

/** How long a handoff waits for the person before it ends `expired`. */
export const HANDOFF_EXPIRES_MS = 15 * 60_000;

export type MountedLiveView = {
  /** The plane with every provider it hands out wrapped by the live view, and the handoff port. */
  plane(browser: BrowserPlane): BrowserPlane;
  /** The port `browser_request_handoff` asks; its files are under `<dir>/handoff/`. */
  handoff: HandoffPort;
  close(): Promise<void>;
};

/** A handoff's request, as written to `<dir>/handoff/<id>.json`. The viewer's URL is not in it. */
type Request = { id: string; sessionTag: string; instruction: string; completionCondition: string; askedAt: string; expiresAt: string };

const write = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
};

/** Mounts the live view and keeps the handoff's files in `dir` (made owner-only). For each request the agent makes:
 *  - `handoff/<id>.json`: the request (its instruction, the completion condition, when it was asked and when it expires);
 *  - `handoff/<id>.viewer`: the viewer's URL, mode 0600, the one place it goes;
 *  - `handoff/<id>.outcome`: written by the person's side, `done` or `cancelled`. Until it exists the call waits, and past
 *    `expiresAt` it ends `expired`.
 *  `<id>` is the agent's request id, a UUID. A request asked again (a rerun, a restarted process) keeps its file and its
 *  deadline, and its viewer file is written again with the URL the live view has now. */
export async function mountLiveView(options: { dir: string; expiresMs?: number }): Promise<MountedLiveView> {
  const dir = join(options.dir, 'handoff');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const expiresMs = options.expiresMs ?? HANDOFF_EXPIRES_MS;

  let live: LiveViewHost | undefined;
  const server: Server = createServer((req, res) => { if (!live?.handle(req, res)) { res.writeHead(404, { 'Content-Length': 0 }); res.end(); } });
  server.on('upgrade', (req, socket, head) => { if (!live?.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // No `gates`: the live view and the browser extension share pi-browser's process-wide driving gates, so the model's
  // browser calls wait while the person drives. No `hostOrigin`: no page frames the viewer.
  live = createLiveView({ hostOrigin: null, baseUrl: `${origin}/live` });
  const host = live;

  const fileOf = (id: string, ext: string) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error(`not a handoff id: ${id.slice(0, 40)}`);
    return join(dir, `${id}.${ext}`);
  };
  const handoff: HandoffPort = {
    async request(ask) {
      const url = ask.liveView?.fullscreen;
      if (!url) return { refused: 'this browser session has no live view' };
      const file = fileOf(ask.requestId, 'json');
      if (!existsSync(file)) {
        const at = Date.now();
        const request: Request = { id: ask.requestId, sessionTag: ask.sessionTag, instruction: ask.instruction, completionCondition: ask.completionCondition, askedAt: new Date(at).toISOString(), expiresAt: new Date(at + expiresMs).toISOString() };
        write(file, `${JSON.stringify(request, null, 2)}\n`);
      }
      write(fileOf(ask.requestId, 'viewer'), `${url}\n`);
      return { interactionId: ask.requestId };
    },
    async outcome(interactionId) {
      const said = existsSync(fileOf(interactionId, 'outcome')) ? readFileSync(fileOf(interactionId, 'outcome'), 'utf8').trim() : '';
      if (said === 'done' || said === 'cancelled') return said satisfies HandoffOutcome;
      const request = JSON.parse(readFileSync(fileOf(interactionId, 'json'), 'utf8')) as Request;
      return Date.now() >= Date.parse(request.expiresAt) ? 'expired' : 'pending';
    },
  };

  const wrapped = new WeakMap<BrowserProvider, BrowserProvider>();
  const wrap = (provider: BrowserProvider) => {
    let shown = wrapped.get(provider);
    if (!shown) { shown = liveViewProvider(provider, host); wrapped.set(provider, shown); }
    return shown;
  };
  return {
    plane: (browser) => ({ ...browser, provider: async (target) => wrap(await browser.provider(target)), handoff }),
    handoff,
    async close() {
      await host.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    },
  };
}
