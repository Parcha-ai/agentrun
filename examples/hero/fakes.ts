// The hero's scripted parts for the no-key host: the lead's turns, the eyes' answers, the pages and the published figures. A live host takes the
// same job (`job.ts`) and brings its own models, browser and eyes. This file is the only place that knows the charts are scripted.
import { join } from 'node:path';
import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { fakeImage, fixturePage, type FakeBackend } from '@parcha/pi-browser/testing';
import { fakeEyes, type FakeEyes } from '@parcha/pi-vision/testing';
import type { Fakes } from '@parcha/agentrun-reference';
import sources from './sources.json' with { type: 'json' };

/** One operator of `sources.json`, as the fakes take it. */
export type Grid = { id: string; operator: string; country: string; url: string; chart: string; numbers: string; peakOf: string; peakUnit: string; publishedUrl: string };

/** The operators `sources.json` lists (the file records how each page was checked by hand). */
export function readGrids(): Grid[] {
  return sources.pages.map((entry) => ({
    id: entry.id, operator: entry.operator, country: entry.country, url: entry.dashboardUrl, chart: entry.chart, numbers: entry.numbers, peakOf: entry.peakOf, peakUnit: entry.peakUnit, publishedUrl: entry.publishedDataUrl,
  }));
}

/** What each grid's chart shows, and what its operator publishes: fixed, so the snapshot is the same on every run. */
const TRUTH = [
  { share: 63.4, peak: 14210 }, { share: 27.9, peak: 21870 }, { share: 18.2, peak: 3340 }, { share: 11.6, peak: 1480 }, { share: 94.1, peak: 11900 },
  { share: 72.8, peak: 5230 }, { share: 88.5, peak: 8910 }, { share: 94.0, peak: 5420 }, { share: 52.3, peak: 17640 },
];
/** What vision reads from each chart, as its distance from the published figure. */
const MISREAD = [0.2, -0.4, 0, 0.3, -0.1, 0.5, 0, -0.2, 0.4];

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));

/** The lead: opens its dashboard, takes one screenshot asking for the two numbers, then files what the screenshot's answer said and
 *  the receipt it came with. A step that errs, or an answer that says the page is not the dashboard, is filed failed. */
export function lead(messages: readonly Message[]) {
  const first = messages.find((message) => message.role === 'user');
  const url = (first ? textOf(first).match(/https?:\/\/[^"\s\\]+/)?.[0] : undefined) ?? '';
  const results = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
  if (results.length === 0) return call('run', { code: `await page.goto(${JSON.stringify(url)})` });
  if (results.length === 1 && !results[0]!.isError) return call('screenshot', { type: 'jpeg', ask: 'Read the renewable share now (percent) and the peak the chart shows, as the page asks for them. If this is not the dashboard, say so.' });
  const shot = results[1] ? textOf(results[1]) : '';
  const read = shot.match(/renewable share now: ([\d.]+)%.*peak: ([\d.]+)/is);
  const filed = shot.match(/evidence\/[\w./-]+\/screenshot-[\w]+\.json/)?.[0];
  if (results.some((result) => result.isError) || !read || !filed) return call('submit', { status: 'failed', page: url, note: results.some((result) => result.isError) ? 'a step failed' : 'the page was not the dashboard' });
  return call('submit', { status: 'read', share: Number(read[1]), peak: Number(read[2]), screenshot: filed, page: url, note: 'read from the chart' });
}

/** The width of the blank screenshot the fake browser takes for the grid at position 0; the grid at position `i` is `SHOT_WIDTH + i` wide. */
export const SHOT_WIDTH = 1200;

/** Gives each session's screenshot the width of its page's grid, so the scripted eyes know whose chart they are looking at. Call it on the
 *  backend the browser runs on. */
export function watchScreenshots(backend: FakeBackend, grids: readonly Grid[]): void {
  const face = backend.driverFace;
  const original = face.screenshot.bind(face);
  face.screenshot = async (id, options) => {
    const shot = await original(id, options);
    const at = Math.max(0, grids.findIndex((grid) => grid.url === backend.sessions.get(id)?.url));
    const width = SHOT_WIDTH + at;
    return { ...shot, width, data: fakeImage(options?.type ?? 'jpeg', width, shot.height).toString('base64') };
  };
}

/** The scripted job for `grids`: pages, the eyes' answers by operator, and the published figures. `broken` names a grid whose page is not
 *  its dashboard (the eyes say so, and the lead files it failed). */
export function heroFakes(grids: readonly Grid[], options: { broken?: string; eyesLedger?: string; eyesPrice?: number } = {}): { fakes: Fakes; eyes: FakeEyes } {
  const at = (grid: Grid) => grids.indexOf(grid) % TRUTH.length;
  const pages = Object.fromEntries(grids.map((grid) => [grid.url, grid.id === options.broken
    ? fixturePage(grid.url, 'Page not found.', 'Not found')
    : fixturePage(grid.url, `${grid.operator} fuel mix. Renewables ${TRUTH[at(grid)]!.share}%.`, `${grid.operator} dashboard`)]));
  const eyes = fakeEyes({
    model: 'scripted-eyes',
    // Scripted: it calls no model, so it costs 0.
    price: { input: options.eyesPrice ?? 0, output: options.eyesPrice ?? 0 },
    ...(options.eyesLedger ? { ledgerPath: options.eyesLedger } : {}),
    answers: [(request) => {
      // The fake browser's screenshots are blank, so the backend gives each grid's a width of its own (`watchScreenshots`), which says whose chart this is.
      const width = request.parts.find((part) => part.type === 'image')?.width ?? 0;
      const grid = grids[width - SHOT_WIDTH];
      if (!grid || grid.id === options.broken) return 'A page with no chart: it says the page was not found. This is not a fuel-mix dashboard.';
      const truth = TRUTH[at(grid)]!;
      return `A fuel-mix chart from ${grid.operator}. Renewable share now: ${(truth.share + MISREAD[at(grid)]!).toFixed(1)}%. Peak: ${truth.peak} ${grid.peakUnit}.`;
    }],
  });
  const fakes: Fakes = {
    model: lead,
    lead: { input: ['text'] },
    tools: {
      // The operator's published figure for the check. Staggered, so concurrent branches rarely overlap in the tool.
      published: async (args) => {
        const grid = grids.find((candidate) => candidate.id === args.id);
        if (!grid) throw new Error(`no grid ${String(args.id)}`);
        await new Promise((resolve) => setTimeout(resolve, 10 + 7 * grids.indexOf(grid)));
        return { share: TRUTH[at(grid)]!.share, kind: grid.publishedUrl === grid.url ? 'the page\'s own table' : 'published data' };
      },
    },
    // Scripted: it calls no model, so it costs 0 and used nothing.
    judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.92 }])), usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 }),
    pages,
    start: grids[0]!.url,
    responses: 400,
  };
  return { fakes, eyes };
}


/** The fakes as the entry runs them. The entry files every look the guard reports (the screenshot it was of, as an image blob in the recording, and its cite) and calls the demo's own lane; this one brings only its eyes. The run's
 *  directory (`DIR`, where the eyes' ledger goes) comes from the entry's environment, and `DEMO_HERO_BROKEN` (a grid id whose page is not its dashboard) and `DEMO_HERO_EYES_PRICE` (the scripted eyes' price per million
 *  tokens) are the test's knobs. */
const grids = readGrids();
const dir = process.env.DIR;
const { fakes: scripted, eyes } = heroFakes(grids, { ...(dir ? { eyesLedger: join(dir, 'eyes.jsonl') } : {}), ...(process.env.DEMO_HERO_BROKEN ? { broken: process.env.DEMO_HERO_BROKEN } : {}), ...(process.env.DEMO_HERO_EYES_PRICE ? { eyesPrice: Number(process.env.DEMO_HERO_EYES_PRICE) } : {}) });
export const fakes: Fakes = {
  ...scripted,
  vision: () => ({ eyes }),
  // Each grid's screenshot has the width of its page's grid, so the scripted eyes know whose chart they look at.
  backend: (backend) => watchScreenshots(backend, grids),
};
