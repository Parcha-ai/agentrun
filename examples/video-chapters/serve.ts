// The demo's local server: a page to drop a film on (or take NASA's, or the committed clip), which starts a run of this demo with
// the film as its input; each run's recording served as it grows, for the viewer to follow; and the viewer's own files. It binds
// to this machine's loopback unless --host names another address. Every run has a spend cap.
//
//   GET  /                              the drop page
//   POST /runs?source=nasa|clip         a run of NASA's film or of the clip; POST /runs?name=<file> with the file as the body
//   GET  /runs/<id>/                    the run's page: its state and the viewer following it
//   GET  /runs/<id>/status              { id, film, live, state }, and its cost, title and result once finished
//   GET  /runs/<id>/recording/<file>    events.jsonl (grows by whole lines; Range: bytes=N-), manifest.json (once finished), blobs/
//   GET  /viewer/<file>                 the viewer (index.html?follow=/runs/<id>/recording/ follows a run)
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { DemoOptions } from '../reference/index.ts';
import { clipInput } from './job.ts';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.webm': 'video/webm', '.mp4': 'video/mp4' };
/** The largest film the drop page takes. */
const MAX_UPLOAD = 2_000_000_000;

type Run = { id: string; film: string; live: boolean; dir: string; record: string; events: string; supervisor: ChildProcess; exited: boolean; offsets: Map<string, number> };

export type Served = { url: string; server: Server; runs: Map<string, Run>; close(): Promise<void> };

/** The live `events.jsonl`: each spool's new whole lines appended in the order they are read. Once the manifest exists, the
 *  recorder's own `events.jsonl` is the recording, and it is served instead. */
function eventsOf(run: Run): string {
  if (existsSync(join(run.record, 'manifest.json'))) return join(run.record, 'events.jsonl');
  if (!existsSync(run.events)) writeFileSync(run.events, '');
  const spool = join(run.record, '.spool');
  for (const name of existsSync(spool) ? readdirSync(spool).filter((file) => file.endsWith('.jsonl')).sort() : []) {
    const file = join(spool, name);
    const from = run.offsets.get(name) ?? 0;
    const size = statSync(file).size;
    if (size <= from) continue;
    const bytes = Buffer.alloc(size - from);
    const fd = openSync(file, 'r');
    try { readSync(fd, bytes, 0, bytes.length, from); } finally { closeSync(fd); }
    const end = bytes.lastIndexOf(0x0a) + 1;
    if (end === 0) continue;
    appendFileSync(run.events, bytes.subarray(0, end));
    run.offsets.set(name, from + end);
  }
  return run.events;
}

/** A file, whole or from `Range: bytes=N-`; HEAD answers the headers alone. */
function sendFile(request: IncomingMessage, response: ServerResponse, file: string) {
  if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
  const size = statSync(file).size;
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
  if (range) {
    const from = Number(range[1]);
    if (from >= size) { response.writeHead(416, { 'content-range': `bytes */${size}`, 'cache-control': 'no-store' }).end(); return; }
    response.writeHead(206, { 'content-type': type, 'content-length': size - from, 'content-range': `bytes ${from}-${size - 1}/${size}`, 'cache-control': 'no-store' });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file, { start: from }).pipe(response);
    return;
  }
  response.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(file).pipe(response);
}

const json = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
/** A path under `root`, or undefined when it would leave it. */
const under = (root: string, path: string) => { const base = resolve(root); const at = resolve(base, normalize(path).replace(/^[/\\]+/, '')); return at === base || at.startsWith(`${base}${sep}`) ? at : undefined; };

/** Starts the server; `npm run demo:video-chapters -- --serve` keeps it up until the process ends. */
export async function serve(options: DemoOptions, argv: string[]): Promise<Served> {
  const { values } = parseArgs({ args: argv, options: { serve: { type: 'boolean' }, host: { type: 'string' }, port: { type: 'string' }, live: { type: 'boolean' }, 'max-usd': { type: 'string' }, runs: { type: 'string' }, viewer: { type: 'string' } }, strict: true });
  const live = values.live === true;
  const maxUsd = values['max-usd'] ?? String(2 * Number(options.spec.expectedCost ?? 0.5));
  const root = resolve(values.runs ?? join(tmpdir(), 'video-chapters-runs'));
  mkdirSync(join(root, 'runs'), { recursive: true });
  // The viewer's files: a build `--viewer` names, else one built from this checkout with no recording bundled. Each run's
  // recording is served beside it, on the same origin.
  const viewer = values.viewer ? resolve(values.viewer) : join(root, 'viewer');
  if (!values.viewer) {
    const { build } = await import(new URL('../../apps/viewer/build.mjs', import.meta.url).href) as { build(target: string, recordingsDir: string): unknown };
    build(viewer, join(root, 'no-recordings'));
  }
  const page = readFileSync(join(import.meta.dirname, 'serve-page.html'), 'utf8');
  const fill = (run?: Run) => page.replaceAll('{{MODE}}', (run?.live ?? live) ? 'live' : 'fakes, $0').replaceAll('{{CAP}}', maxUsd).replaceAll('{{RUN}}', run?.id ?? '');
  const runs = new Map<string, Run>();

  const start = (id: string, film: string, input: Record<string, unknown>, fetchSources: boolean): Run => {
    const dir = join(root, 'runs', id, 'run');
    const record = join(root, 'runs', id, 'recording');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const args = ['--no-warnings=ExperimentalWarning', fileURLToPath(options.self), '--dir', dir, '--record', record, '--input', JSON.stringify(input), '--max-usd', maxUsd, '--cache', join(root, 'cache'), ...(live ? ['--live'] : fetchSources ? ['--fetch-sources'] : [])];
    const supervisor = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(join(root, 'runs', id, 'run.log'));
    supervisor.stdout?.pipe(log); supervisor.stderr?.pipe(log);
    const run: Run = { id, film, live, dir, record, events: join(root, 'runs', id, 'live-events.jsonl'), supervisor, exited: false, offsets: new Map() };
    supervisor.on('exit', () => { run.exited = true; });
    runs.set(id, run);
    return run;
  };
  const created = (response: ServerResponse, run: Run) => json(response, 201, { id: run.id, page: `/runs/${run.id}/`, follow: `/viewer/index.html?follow=/runs/${run.id}/recording/` });

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'content-type': TYPES['.html']! }).end(fill()); return; }
    if (parts[0] === 'viewer') { const at = under(viewer, parts.slice(1).join('/') || 'index.html'); if (at) sendFile(request, response, at); else response.writeHead(404).end(); return; }
    if (parts[0] !== 'runs') { response.writeHead(404).end(); return; }
    if (request.method === 'POST' && parts.length === 1) {
      const source = url.searchParams.get('source');
      const id = randomUUID().slice(0, 8);
      if (source === 'nasa') { created(response, start(id, String(options.job.input.film), options.job.input, true)); return; }
      if (source === 'clip') { created(response, start(id, clipInput.film, clipInput, false)); return; }
      const name = basename(url.searchParams.get('name') ?? '').replace(/[^\w.-]/g, '_');
      if (!/^[\w.-]+\.(mp4|webm|mov|mkv|m4v)$/i.test(name)) { json(response, 400, { error: 'name a video file: .mp4, .webm, .mov, .mkv or .m4v' }); return; }
      if (Number(request.headers['content-length'] ?? 0) > MAX_UPLOAD) { json(response, 413, { error: `a film of at most ${MAX_UPLOAD} bytes` }); return; }
      // The dropped film goes in the run's workspace before its first process starts.
      const work = join(root, 'runs', id, 'run', 'work');
      mkdirSync(work, { recursive: true });
      await pipeline(request, createWriteStream(join(work, name)));
      created(response, start(id, name, { film: name, from_s: 0, to_s: 0, window_s: live ? 60 : 8 }, false));
      return;
    }
    const run = runs.get(parts[1] ?? '');
    if (!run) { response.writeHead(404).end(); return; }
    if (request.method === 'GET' && parts.length === 2) { response.writeHead(200, { 'content-type': TYPES['.html']! }).end(fill(run)); return; }
    if (request.method === 'GET' && parts[2] === 'status') {
      const finished = existsSync(join(run.record, 'manifest.json'));
      const manifest = finished ? JSON.parse(readFileSync(join(run.record, 'manifest.json'), 'utf8')) : undefined;
      json(response, 200, {
        id: run.id, film: run.film, live: run.live, state: finished ? 'finished' : run.exited ? 'stopped' : 'running',
        ...(manifest ? { cost: manifest.cost, title: manifest.title, result: manifest.result ?? null } : {}),
      });
      return;
    }
    if (parts[2] === 'recording' && (request.method === 'GET' || request.method === 'HEAD')) {
      const rest = parts.slice(3).join('/');
      if (rest === 'events.jsonl') { sendFile(request, response, eventsOf(run)); return; }
      const at = rest.startsWith('.spool') ? undefined : under(run.record, rest);
      if (at) sendFile(request, response, at); else response.writeHead(404).end();
      return;
    }
    response.writeHead(404).end();
  };

  const server = createServer((request, response) => { handle(request, response).catch((error) => { if (!response.headersSent) json(response, 500, { error: String((error as Error).message ?? error) }); else response.end(); }); });
  const host = values.host ?? '127.0.0.1';
  await new Promise<void>((done) => server.listen(Number(values.port ?? 8787), host, done));
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${(server.address() as { port: number }).port}`;
  return { url, server, runs, close: () => new Promise((done) => server.close(() => done())) };
}
