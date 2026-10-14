// The browser tile: what the Chrome in the box shows, as `frame` lines of a recording. It watches the box's DevTools endpoint
// for pages and asks each for a screencast (JPEG, at most 800 px wide, at most 10 a second), keeps every frame whole as a
// blob, and writes one live line per frame: `{ session, provider, w, h, mime }` (RECORDING.md, section 5).
//
// This is the demo's own capture until the browser package commits a frame stream of its own; it reads, and drives nothing.
// A page that shows a credential would end its frames with `frame.gap` (`credential_on_page`): the pages this demo opens are
// NASA's public ones, and it opens no form.
import type { Recorder } from '../reference/index.ts';

const MAX_FPS = 10;
const SCAN_MS = 500;

export type Tile = { frames(): number; stop(): Promise<void> };

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };

/** Start capturing every page of the browser at `endpoint` into `recorder`. */
export function startTile(endpoint: string, recorder: Recorder, provider = 'docker-chrome'): Tile {
  const open = new Map<string, WebSocket>();
  let frames = 0;
  let stopped = false;

  const attach = (target: Target): void => {
    if (open.has(target.id) || target.webSocketDebuggerUrl === undefined) return;
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    open.set(target.id, socket);
    let next = 0;
    let lastAt = 0;
    const send = (method: string, params: Record<string, unknown> = {}): void => { socket.send(JSON.stringify({ id: ++next, method, params })); };
    socket.addEventListener('open', () => {
      send('Page.enable');
      send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 800, everyNthFrame: 1 });
    });
    socket.addEventListener('message', (message) => {
      const body = JSON.parse(String(message.data)) as { method?: string; params?: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } } };
      if (body.method !== 'Page.screencastFrame' || body.params === undefined) return;
      send('Page.screencastFrameAck', { sessionId: body.params.sessionId });
      const now = Date.now();
      if (now - lastAt < 1000 / MAX_FPS) return;
      lastAt = now;
      const sha = recorder.blob(Buffer.from(body.params.data, 'base64'), 'jpg');
      frames += 1;
      const { deviceWidth, deviceHeight } = body.params.metadata;
      recorder.live('browser', 'frame', { session: target.id, provider, w: Math.min(800, Math.round(deviceWidth)), h: Math.round((deviceHeight * Math.min(800, deviceWidth)) / deviceWidth), mime: 'image/jpeg' }, { blobs: [sha] });
    });
    socket.addEventListener('close', () => { open.delete(target.id); });
    socket.addEventListener('error', () => { open.delete(target.id); });
  };

  const scan = async (): Promise<void> => {
    try {
      const listed = (await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(2_000) })).json()) as Target[];
      for (const target of listed) if (target.type === 'page') attach(target);
    } catch { /* the browser is gone or not up: the next scan asks again */ }
  };
  const timer = setInterval(() => { if (!stopped) void scan(); }, SCAN_MS);
  void scan();

  return {
    frames: () => frames,
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const socket of open.values()) socket.close();
      open.clear();
    },
  };
}
