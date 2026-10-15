// The live parts of the hero job: local Chrome on the real dashboards, the eyes and the lead on the machine's broker, and the frame
// recorder that gives the recording its browser tiles. Nothing here runs unless `--live` (or `--chrome`, which serves the job's own pages to
// a local Chrome and reaches nothing else) is asked for.
//
// Eyes: a pi-ai catalog entry whose base URL is replaced by the broker's (the broker speaks the OpenAI API, so the OpenRouter entry), keyed by
// a placeholder: the broker swaps in its own credential. The lead takes its model the same way, through the host's models function. Neither
// ever sees a provider key.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { getModel } from '@earendil-works/pi-ai/compat';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createModels, createProvider, type Models } from '@earendil-works/pi-ai/models';
import type { ModelRef } from '@earendil-works/pi-durable';
import { cdpProvider } from '@parcha/pi-browser/providers/cdp';
import { stagehandDriver } from '@parcha/pi-browser/driver/stagehand';
import { exportFrameTracks, frameRecorder, type FrameRecorder } from '@parcha/pi-browser/recorder';
import type { Eyes } from '@parcha/pi-vision';
import { piAiEyes } from '@parcha/pi-vision/eyes/pi-ai';
import type { BrowserPlane, Recorder, RunPlace } from '../reference/index.ts';
import type { FixturePage } from '@parcha/pi-browser/testing';

/** The machine's facts for a live run, from the environment. */
export type LiveConfig = {
  /** The Chrome binary: `CHROME_PATH`. */
  chrome: string;
  /** The broker's OpenAI-compatible base URL: `HERO_BROKER_URL`, default http://127.0.0.1:9421/v1. */
  broker: string;
  /** The eyes' and the lead's pi-ai catalog entries, `<provider>/<model id>`: `HERO_EYES` and `HERO_LEAD`, default the OpenRouter entry the broker serves. */
  eyes: string;
  lead: string;
};

export function liveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const chrome = env.CHROME_PATH?.trim();
  if (!chrome || !existsSync(chrome)) throw new Error('--live needs a Chrome: set CHROME_PATH to its binary.');
  const eyes = env.HERO_EYES?.trim() || 'openrouter/google/gemini-3.7-flash';
  return { chrome, broker: env.HERO_BROKER_URL?.trim() || 'http://127.0.0.1:9421/v1', eyes, lead: env.HERO_LEAD?.trim() || eyes };
}

const split = (spec: string) => {
  const slash = spec.indexOf('/');
  if (slash < 1 || slash === spec.length - 1) throw new Error(`"${spec}" is not <provider>/<model id>, the id pi-ai's catalog uses`);
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
};

/** The eyes: the catalog entry, its base URL the broker's, keyed by a placeholder the broker replaces. */
export function liveEyes(config: LiveConfig): Eyes {
  const { provider, modelId } = split(config.eyes);
  const entry = (getModel as (provider: string, modelId: string) => ReturnType<typeof getModel> | undefined)(provider, modelId);
  if (!entry) throw new Error(`pi-ai's catalog has no model ${config.eyes}`);
  if (!entry.input.includes('image')) throw new Error(`${config.eyes} takes no images`);
  return piAiEyes({ ...entry, baseUrl: config.broker }, { apiKey: () => 'placeholder' });
}

/** The lead's models: one provider whose only model is the catalog entry, reached at the broker's base URL with a placeholder key. */
export function liveModels(config: LiveConfig): { catalog: Models; lead: ModelRef } {
  const { provider, modelId } = split(config.lead);
  const entry = (getModel as (provider: string, modelId: string) => ReturnType<typeof getModel> | undefined)(provider, modelId);
  if (!entry) throw new Error(`pi-ai's catalog has no model ${config.lead}`);
  const catalog = createModels();
  catalog.setProvider(createProvider({
    id: 'broker', name: 'The machine\'s broker', baseUrl: config.broker,
    auth: { apiKey: { name: 'The broker (placeholder credential)', resolve: async () => ({ auth: { apiKey: 'placeholder', baseUrl: config.broker }, source: 'placeholder' }) } },
    models: [{ ...entry, provider: 'broker', baseUrl: config.broker }],
    api: { 'openai-completions': openAICompletionsApi() },
  } as never));
  return { catalog, lead: { provider: 'broker', modelId } };
}

/** A local Chrome per session. `pages` given: its only way out is this process, which serves those pages as Chrome's proxy and fails every other host
 *  (the `--chrome` smoke, on no network). Absent: Chrome reaches the real sites (`--live`). `frames` given: each session is screencast into the recording. */
export async function liveBrowser(place: RunPlace, config: LiveConfig, options: { pages?: Record<string, FixturePage>; frames?: FrameRecorder } = {}): Promise<{ browser: BrowserPlane; close(): void }> {
  let close = () => {};
  let args: string[] = [];
  if (options.pages) {
    const pages = options.pages;
    const server = createServer((request, response) => {
      const url = request.url ?? '';
      const page = pages[url] ?? Object.values(pages).find((candidate) => candidate.url === url);
      response.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
      response.end(page ? `<html><head><title>${page.title}</title></head><body>${page.html}</body></html>` : 'Not a page of this job.');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    args = [`--proxy-server=http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
    close = () => { server.close(); };
  }
  const provider = cdpProvider({ chrome: { executablePath: config.chrome, profileRoot: join(place.root, 'chrome'), args } });
  const frames = options.frames;
  return { browser: { provider: (target) => (frames ? frames.watch(provider, Number(target.conversationId)) : provider), driver: stagehandDriver() }, close };
}

/** The frame recorder for this process, its sink the recorder's own live write (which assigns `seq`) and blob store. */
export function liveFrames(recorder: Recorder, started: number, dir: string): FrameRecorder {
  const spool = join(dir, '.spool');
  return frameRecorder({
    clock: () => Math.max(0, Date.now() - started),
    // Where an earlier process's frames of a session stopped, read from the spool they were written to: a session this process takes up after a kill
    // gets a `process_killed` gap from there.
    lastFrameAt: (session) => {
      let last: number | null = null;
      for (const name of existsSync(spool) ? readdirSync(spool) : []) {
        if (!name.startsWith('live-')) continue;
        for (const text of readFileSync(join(spool, name), 'utf8').split('\n')) {
          if (!text.includes('"kind":"frame"')) continue;
          try { const line = JSON.parse(text) as { kind?: string; t?: number; data?: { session?: string } }; if (line.kind === 'frame' && line.data?.session === session && typeof line.t === 'number') last = Math.max(last ?? 0, line.t); } catch { /* a torn last line */ }
        }
      }
      return last;
    },
    sink: (line, blobs = {}) => {
      for (const bytes of Object.values(blobs)) recorder.blob(Buffer.from(bytes), 'jpg');
      recorder.live('browser', line.kind, line.data, { conv: line.conv, ...('blobs' in line ? { blobs: [...line.blobs] } : {}) });
    },
  });
}

/** At the end of a recording: one WebM per browser session and its index, as `frame.track` lines, made from the frames already recorded. The
 *  lines are appended to `events.jsonl` (they are written at export, after the last frame) and their blobs kept beside the frames. */
export async function addFrameTracks(dir: string): Promise<number> {
  const file = join(dir, 'events.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (!lines.some((line) => line.source === 'browser' && line.kind === 'frame')) return 0;
  const tracks = await exportFrameTracks({ lines: lines as never, readBlob: (sha) => { try { return readFileSync(join(dir, 'blobs', `${sha}.jpg`)); } catch { return undefined; } } });
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  // The last process's generation, and its next `seq`: the lines are appended after the last one, which is the end of the recording.
  const gen = lines.reduce((top, line) => (line.channel === 'live' && typeof line.gen === 'number' ? Math.max(top, line.gen) : top), 1);
  let seq = lines.reduce((top, line) => (line.channel === 'live' && line.gen === gen && typeof line.seq === 'number' ? Math.max(top, line.seq) : top), -1);
  for (const track of tracks) {
    const [webm, index] = track.line.blobs;
    writeFileSync(join(dir, 'blobs', `${webm}.webm`), track.blobs[webm]!);
    writeFileSync(join(dir, 'blobs', `${index}.json`), track.blobs[index]!);
    appendFileSync(file, `${JSON.stringify({ ...track.line, gen, seq: (seq += 1) })}\n`);
  }
  return tracks.length;
}
