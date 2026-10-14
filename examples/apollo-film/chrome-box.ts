// A Chrome inside a throwaway Docker box, driven by pi-browser over the Chrome DevTools Protocol. The box is a container of
// `@parcha/pi-transport`'s Docker provider; Chrome is the only program in it besides its `sleep`. pi-browser reaches it as "an
// existing browser" (the CDP provider's `endpoint`), so the same code that drives a local Chrome drives this one.
//
// How the DevTools port is reached: Chrome listens on the container's loopback only (recent Chrome ignores a request to listen
// elsewhere), and the Docker provider publishes no ports. So this process listens on a loopback port of its own and, for each
// connection, runs `docker exec -i <box> node <relay>` and pipes the two together. It needs nothing of the host but
// Docker, so it works on Docker Desktop as it does on Linux.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:net';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { finish, type Box } from '@parcha/pi-transport';
import { dockerBoxes } from '@parcha/pi-transport/box/docker';

/** An image with a current Chrome for Testing (155) and Node, which the relay uses. The browser package needs a recent Chrome: an older Chromium (124) attaches but has no active page. */
export const CHROME_IMAGE = 'ghcr.io/puppeteer/puppeteer:latest';
const READY_MS = 30_000;
/** Where the browser's runtime extension is put in the box. The extension's id is a function of this path. */
const EXTENSION_DIRECTORY = '/tmp/ext';

export type ChromeBox = {
  /** The box's id: what a record names, what `docker ps` shows. */
  boxId: string;
  box: Box;
  /** `http://127.0.0.1:<port>`, a relay into the box: give it to pi-browser's CDP provider as `endpoint`. */
  endpoint: string;
  /** The id of the runtime extension the Chrome loaded: give it to the CDP provider as `extensionId`. */
  extensionId: string;
  /** The tail of Chrome's own log, for a run that went wrong. */
  log(): Promise<string>;
  /** Close the relay and remove the container. */
  destroy(): Promise<void>;
};

export type ChromeBoxOptions = {
  image?: string;
  /** The box ends itself after this long whatever happens to the machine that made it. Default 20 minutes. */
  maxLifetimeMs?: number;
  /** Labels on the container, so a stray one is findable. */
  labels?: Record<string, string>;
  docker?: string;
};

/** Start a Chrome box and wait until its DevTools endpoint answers. Throws when it does not within 30 s; the box is removed then. */
export async function startChromeBox(options: ChromeBoxOptions = {}): Promise<ChromeBox> {
  const docker = options.docker ?? 'docker';
  const created = await dockerBoxes(options.docker === undefined ? {} : { docker }).create(
    { image: options.image ?? CHROME_IMAGE, workspace: '/tmp', maxLifetimeMs: options.maxLifetimeMs ?? 20 * 60_000, labels: { 'apollo-film': 'chrome', ...options.labels } },
    BACKGROUND_CONTEXT,
  );
  if (!created.ok) throw new Error(`the Chrome box could not be created: ${created.error.message}`, { cause: created.error });
  const box = created.value;
  let relayServer: { port: number; close(): void } | undefined;
  const destroy = async (): Promise<void> => { relayServer?.close(); await box.destroy(BACKGROUND_CONTEXT); };
  try {
    // The same port number on both sides: the extension inside Chrome dials the debugger URL pi-browser hands it, so that URL
    // (`127.0.0.1:<port>`) must reach Chrome from inside the box as it reaches the relay from outside.
    const port = await freePort();
    // The browser package drives a page through a runtime extension; an existing Chrome has to load it at start.
    const uploaded = await box.upload(extensionFiles().map(({ path, bytes }) => ({ path: `${EXTENSION_DIRECTORY}/${path}`, bytes })), BACKGROUND_CONTEXT);
    if (!uploaded.ok) throw new Error(`the extension could not be put in the box: ${uploaded.error.message}`, { cause: uploaded.error });
    // Detached, with no pipe back: Chrome goes on when the exec that started it returns.
    const chrome = `$(ls -d /home/pptruser/.cache/puppeteer/chrome/*/chrome-linux64/chrome | head -1) --headless=new --load-extension=${EXTENSION_DIRECTORY} --remote-allow-origins=* --user-data-dir=/tmp/profile --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=${port} --window-size=1280,720 about:blank </dev/null >/tmp/chrome.log 2>&1 & echo started`;
    const started = await box.exec(['sh', '-c', chrome], { timeoutMs: 20_000 }, BACKGROUND_CONTEXT);
    if (!started.ok) throw new Error(`Chrome did not start in the box: ${started.error.message}`, { cause: started.error });
    const done = await finish(started.value);
    if (!done.ok || !new TextDecoder().decode(done.value.stdout).includes('started')) throw new Error('Chrome did not start in the box');
    relayServer = await relay(docker, box.id, port);
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + READY_MS;
    for (;;) {
      try {
        const answer = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2_000) });
        if (answer.ok) break;
      } catch { /* not up yet */ }
      if (Date.now() >= deadline) throw new Error(`the box's Chrome did not answer at ${endpoint} within ${READY_MS} ms`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    const log = async (): Promise<string> => {
      const tail = await box.exec(['sh', '-c', 'tail -n 40 /tmp/chrome.log'], { timeoutMs: 10_000 }, BACKGROUND_CONTEXT);
      if (!tail.ok) return `(no log: ${tail.error.message})`;
      const read = await finish(tail.value);
      return read.ok ? new TextDecoder().decode(read.value.stdout) : '(no log)';
    };
    return { boxId: box.id, box, endpoint, extensionId: extensionIdOf(EXTENSION_DIRECTORY), log, destroy };
  } catch (cause) {
    await destroy();
    throw cause;
  }
}

/** The program that runs in the box for each connection: standard input and output to the loopback port in `argv[1]`. */
const RELAY = "const s = require('net').connect(Number(process.argv[1]), '127.0.0.1'); process.stdin.pipe(s); s.pipe(process.stdout); s.on('close', () => process.exit()); s.on('error', () => process.exit(1));";

/** A loopback TCP port whose every connection is a `docker exec -i <box> node -e <relay> <port>`. */
async function relay(docker: string, boxId: string, port: number): Promise<{ port: number; close(): void }> {
  const children = new Set<ReturnType<typeof spawn>>();
  const server: Server = createServer((socket) => {
    const child = spawn(docker, ['exec', '-i', boxId, 'node', '-e', RELAY, String(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    const end = (): void => { socket.destroy(); child.stdin.destroy(); child.kill('SIGKILL'); children.delete(child); };
    socket.on('close', end);
    socket.on('error', end);
    child.stdin.on('error', () => {});
    child.on('exit', end);
  });
  await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  return { port, close: () => { server.close(); for (const child of children) child.kill('SIGKILL'); } };
}

/** The files of the extension the browser package ships (its directory can be moved with STAGEHAND_EXTENSION_DIRECTORY_PATH). */
function extensionFiles(): { path: string; bytes: Uint8Array }[] {
  const root = process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH
    ?? fileURLToPath(new URL('../../node_modules/@browserbasehq/stagehand/dist/extension/', import.meta.url));
  const files: { path: string; bytes: Uint8Array }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ path: relative(root, full), bytes: readFileSync(full) });
    }
  };
  walk(root);
  return files;
}

/** Chrome's id for an unpacked extension: the first 16 bytes of the SHA-256 of its absolute path, each nibble as a letter a to p. */
export function extensionIdOf(path: string): string {
  return [...createHash('sha256').update(path).digest('hex').slice(0, 32)].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

/** A loopback port nobody holds right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  const address = probe.address();
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  if (address === null || typeof address === 'string') throw new Error('no free port');
  return address.port;
}
