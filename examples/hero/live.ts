// The live parts of the hero job: Browserbase on the real dashboards (a sandboxed browser, so this machine's address never reaches a site), the eyes and
// the lead on the machine's broker, and the frame recorder that gives the recording its browser tiles. Nothing here runs unless `--live` (or `--chrome`,
// which serves the job's own pages to a local Chrome and reaches nothing else) is asked for. A local Chrome never visits a real page.
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
import { browserbaseProvider } from '@parcha/pi-browser/providers/browserbase';
import { cdpProvider } from '@parcha/pi-browser/providers/cdp';
import { stagehandDriver } from '@parcha/pi-browser/driver/stagehand';
import { exportFrameTracks, frameRecorder, type FrameRecorder } from '@parcha/pi-browser/recorder';
import type { BrowserProvider } from '@parcha/pi-browser';
import type { Eyes } from '@parcha/pi-vision';
import { piAiEyes } from '@parcha/pi-vision/eyes/pi-ai';
import type { BrowserPlane, Recorder, RunPlace } from '../reference/index.ts';
import type { FixturePage } from '@parcha/pi-browser/testing';

/** The machine's facts for a live run, from the environment. */
export type LiveConfig = {
  /** `--chrome` only: the Chrome binary, `CHROME_PATH`, for the loopback fixtures. */
  chrome?: string;
  /** `--live` only: the browser is Browserbase (`PI_BROWSER_PROVIDER=browserbase`), its key `BROWSERBASE_API_KEY` in this process's environment and only there. */
  browserbase: boolean;
  /** The broker's OpenAI-compatible base URL: `HERO_BROKER_URL`, default http://127.0.0.1:9421/v1. */
  broker: string;
  /** The eyes' pi-ai catalog entry, `<provider>/<model id>`: `HERO_EYES`, default the OpenRouter entry the broker serves. */
  eyes: string;
  /** The lead's model: `HERO_LEAD`, default `openai/gpt-6-luna`, this machine's paid-proof model. A broker model id (OpenRouter's ids, over the OpenAI chat API)
   *  or `openrouter/<id>`; a model pi-ai's catalog describes keeps its price and abilities, any other id is sent as written through a definition the host builds. */
  lead: string;
  /** What an uncatalogued lead costs, dollars per million tokens in and out (`HERO_LEAD_PRICE=<in>,<out>`); null when unset, and its cost then reads 0 in usage, which is not a price. */
  leadPrice: { input: number; output: number } | null;
};

export function liveConfig(env: NodeJS.ProcessEnv = process.env, mode: 'chrome' | 'live' = 'chrome'): LiveConfig {
  const chrome = env.CHROME_PATH?.trim();
  if (mode === 'chrome' && (!chrome || !existsSync(chrome))) throw new Error('--chrome needs a Chrome: set CHROME_PATH to its binary.');
  if (mode === 'live') {
    if (env.HERO_LIVE_SPEND_OK !== '1') throw new Error('--live spends money and visits real sites: set HERO_LIVE_SPEND_OK=1 only once the run has been approved.');
    if (env.PI_BROWSER_PROVIDER?.trim() !== 'browserbase') throw new Error('--live drives Browserbase: set PI_BROWSER_PROVIDER=browserbase. A local Chrome never visits a real page.');
    if (!env.BROWSERBASE_API_KEY?.trim() && !env.BB_API_KEY?.trim()) throw new Error('--live needs BROWSERBASE_API_KEY in the environment (from the route in local.md, one subshell, never printed or written).');
  }
  const eyes = env.HERO_EYES?.trim() || 'openrouter/google/gemini-3.7-flash';
  const price = /^\s*([\d.]+)\s*,\s*([\d.]+)\s*$/.exec(env.HERO_LEAD_PRICE ?? '');
  return {
    ...(chrome ? { chrome } : {}), browserbase: mode === 'live', broker: env.HERO_BROKER_URL?.trim() || 'http://127.0.0.1:9421/v1', eyes, lead: env.HERO_LEAD?.trim() || 'openai/gpt-6-luna',
    leadPrice: price ? { input: Number(price[1]), output: Number(price[2]) } : null,
  };
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

const getCatalog = getModel as (provider: string, modelId: string) => ReturnType<typeof getModel> | undefined;
/** The lead's catalog entry, if there is one. `openrouter/<id>` names the OpenRouter entry; a bare id (`openai/gpt-6-luna`) is the broker's own, which speaks
 *  OpenRouter's ids over the OpenAI chat API, so its entry is the OpenRouter one of that id. Anything else has no entry. */
const catalogEntry = (spec: string) => (spec.startsWith('openrouter/') ? getCatalog('openrouter', spec.slice('openrouter/'.length)) : getCatalog('openrouter', spec));

/** The lead's models: one provider, "broker", whose only model is the lead, reached at the broker's base URL with a placeholder key. A model pi-ai's catalog
 *  describes is used as the catalog describes it (its price and abilities). A broker id it does not know is built here: an OpenAI-compatible chat model, the id
 *  sent as written, priced by `HERO_LEAD_PRICE` or not at all. */
export function liveModels(config: LiveConfig): { catalog: Models; lead: ModelRef } {
  const entry = catalogEntry(config.lead);
  const model = entry
    ? { ...entry, provider: 'broker', baseUrl: config.broker }
    : {
      id: config.lead, name: config.lead, api: 'openai-completions' as const, provider: 'broker', baseUrl: config.broker, reasoning: false, input: ['text', 'image'] as ('text' | 'image')[],
      cost: { input: config.leadPrice?.input ?? 0, output: config.leadPrice?.output ?? 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384,
    };
  const catalog = createModels();
  catalog.setProvider(createProvider({
    id: 'broker', name: 'The machine\'s broker', baseUrl: config.broker,
    auth: { apiKey: { name: 'The broker (placeholder credential)', resolve: async () => ({ auth: { apiKey: 'placeholder', baseUrl: config.broker }, source: 'placeholder' }) } },
    models: [model],
    api: { 'openai-completions': openAICompletionsApi() },
  } as never));
  return { catalog, lead: { provider: 'broker', modelId: model.id } };
}

/** The browser plane. `pages` given (`--chrome`): a local Chrome per session whose only way out is this process, which serves those pages as Chrome's proxy and
 *  fails every other host. Absent (`--live`): Browserbase, with its list prices (the host's zero prices are for fakes). `frames` given: each session is screencast
 *  into the recording. `env` is where Browserbase finds its key. */
export async function liveBrowser(place: RunPlace, config: LiveConfig, options: { pages?: Record<string, FixturePage>; frames?: FrameRecorder; env?: NodeJS.ProcessEnv } = {}): Promise<{ browser: BrowserPlane; close(): void }> {
  const frames = options.frames;
  const watch = (provider: BrowserProvider) => (target: { conversationId: unknown }) => (frames ? frames.watch(provider, Number(target.conversationId)) : provider);
  if (config.browserbase) {
    if (options.pages) throw new Error('a live run does not serve fixture pages');
    const provider = browserbaseProvider({ env: options.env ?? process.env });
    return { browser: { provider: watch(provider), driver: stagehandDriver(), prices: undefined } as unknown as BrowserPlane, close: () => {} };
  }
  if (!config.chrome || !options.pages) throw new Error('--chrome needs CHROME_PATH and the job\'s pages');
  const pages = options.pages;
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const page = pages[url] ?? Object.values(pages).find((candidate) => candidate.url === url);
    response.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
    response.end(page ? `<html><head><title>${page.title}</title></head><body>${page.html}</body></html>` : 'Not a page of this job.');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const args = [`--proxy-server=http://127.0.0.1:${(server.address() as AddressInfo).port}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
  const provider = cdpProvider({ chrome: { executablePath: config.chrome, profileRoot: join(place.root, 'chrome'), args } });
  return { browser: { provider: watch(provider), driver: stagehandDriver() } as unknown as BrowserPlane, close: () => { server.close(); } };
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
