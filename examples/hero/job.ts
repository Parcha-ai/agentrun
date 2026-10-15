// The hero job: one agent reads nine electricity grid operators' public fuel-mix dashboards, each in a browser session of its
// own and all at once. The numbers exist only in the charts, so vision reads them (a screenshot with an `ask`, answered from the
// pixels). Where the operator also publishes the mix as data, a `call` fetches it as the check, shown beside the reading. The
// last step builds `snapshot.html`: a table of the nine grids, each reading linked to the screenshot it came from.
//
// Everything here is scripted for the no-key host: the lead's turns, the eyes' answers, the pages and the published figures.
// A live host takes the same workflow and its own models, browser and eyes.
import { readFileSync } from 'node:fs';
import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Workflow } from '@parcha/agentrun-dsl';
import { fakeImage, fixturePage, type FakeBackend } from '@parcha/pi-browser/testing';
import { fakeEyes, type FakeEyes } from '@parcha/pi-vision/testing';
import type { Fakes, Job } from '../reference/index.ts';

/** One operator of `sources.json`, as the job takes it. */
export type Grid = { id: string; operator: string; country: string; url: string; chart: string; numbers: string; peakOf: string; peakUnit: string; publishedUrl: string };

/** The nine operators the job reads, from `sources.json` (the file records how each page was checked by hand). */
export function readGrids(): Grid[] {
  const file = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8')) as { sources: Array<Record<string, string>> };
  return file.sources.map((entry) => ({
    id: entry.id!, operator: entry.operator!, country: entry.country!, url: entry.dashboardUrl!, chart: entry.chart!, numbers: entry.numbers!, peakOf: entry.peakOf!, peakUnit: entry.peakUnit!, publishedUrl: entry.publishedDataUrl!,
  }));
}

/** The snapshot step: a pure function of the state, written as the one expression a `code` node takes. */
const SNAPSHOT = `(s) => {
  const rows = s.rows;
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const word = words[rows.length] || String(rows.length);
  const read = rows.filter((r) => r.status === 'read');
  const gaps = read.map((r) => r.gap);
  const mean = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10 : null;
  const close = read.filter((r) => r.gap <= 1).length;
  const line = (r) => r.status === 'read'
    ? '<tr><td>' + esc(r.operator) + ' (' + esc(r.country) + ')</td><td><a href="' + esc(r.screenshot) + '">' + esc(r.share) + '%</a></td><td>' + esc(r.peak) + ' ' + esc(r.peakUnit) + '<br><small>' + esc(r.peakOf) + '</small></td><td>' + esc(r.published) + '%</td><td>' + esc(r.gap) + '</td><td>read from the chart</td></tr>'
    : '<tr><td>' + esc(r.operator) + ' (' + esc(r.country) + ')</td><td colspan="4">not read: ' + esc(r.note) + '</td><td>failed</td></tr>';
  const title = word.charAt(0).toUpperCase() + word.slice(1) + ' grids, read from the chart';
  const howClose = read.length ? 'Vision came within one point of the published figure on ' + close + ' of ' + read.length + ' grids read (mean gap ' + mean + ' points).' : 'No grid was read.';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(title) + '</title></head><body><h1>' + esc(title) + '</h1>'
    + '<p>Taken ' + esc(s.at) + '. Each reading is the number vision read from the operator\\'s own chart; the published figure beside it is the check. A page that was not the dashboard is listed as failed and cites nothing.</p>'
    + '<table border="1" cellpadding="4"><thead><tr><th>Grid</th><th>Renewable share now</th><th>Peak the chart shows</th><th>Published</th><th>Gap (points)</th><th>Source</th></tr></thead><tbody>'
    + rows.map(line).join('') + '</tbody></table><p>' + esc(howClose) + '</p><p><small>Costs in the recording are at list prices: the models\\' catalog rates and the browser provider\\'s own.</small></p></body></html>';
  return { result: { at: s.at, grids: rows.length, read: read.length, failed: rows.length - read.length, closeWithinOnePoint: close, meanGap: mean === null ? 0 : mean, rows: rows, html: html } };
}`;

const CHECK = `(s) => {
  const r = s.reading;
  const ok = r.status === 'read' && typeof r.share === 'number' && typeof r.peak === 'number' && typeof r.screenshot === 'string' && r.screenshot.length > 0;
  return {
    id: s.item.id, operator: s.item.operator, country: s.item.country, status: ok ? 'read' : 'failed',
    share: ok ? r.share : 0, peak: ok ? r.peak : 0, peakOf: s.item.peakOf, peakUnit: s.item.peakUnit, screenshot: ok ? r.screenshot : '',
    page: r.page, note: r.note, published: s.published.share, publishedFrom: s.item.publishedUrl,
    gap: ok ? Math.round(Math.abs(r.share - s.published.share) * 10) / 10 : 0,
  };
}`;

export const workflow = {
  v: 2,
  name: 'hero-grid-snapshot',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['at', 'grids'],
      properties: {
        at: { type: 'string', minLength: 1 },
        grids: { type: 'array', minItems: 1, items: {
          type: 'object', additionalProperties: false, required: ['id', 'operator', 'country', 'url', 'chart', 'numbers', 'peakOf', 'peakUnit', 'publishedUrl'],
          properties: { id: { type: 'string' }, operator: { type: 'string' }, country: { type: 'string' }, url: { type: 'string' }, chart: { type: 'string' }, numbers: { type: 'string' }, peakOf: { type: 'string' }, peakUnit: { type: 'string' }, publishedUrl: { type: 'string' } },
        } },
      },
    },
    Reading: {
      type: 'object', additionalProperties: false, required: ['status', 'page', 'note'],
      properties: {
        status: { type: 'string', enum: ['read', 'failed'], description: 'read: the page was the dashboard and the chart gave both numbers. failed: anything else.' },
        share: { type: 'number', description: 'The renewable share now, in percent, as read from the chart.' },
        peak: { type: 'number', description: "The peak named in numbers, in the unit named there, as read from the chart." },
        screenshot: { type: 'string', description: 'The evidence path the screenshot tool returned. Omit it when the page was not the dashboard.' },
        page: { type: 'string', description: 'The URL the browser was on.' },
        note: { type: 'string' },
      },
    },
    Published: { type: 'object', required: ['share'], properties: { share: { type: 'number' }, kind: { type: 'string' } } },
    Result: {
      type: 'object', additionalProperties: false, required: ['at', 'grids', 'read', 'failed', 'rows', 'html'],
      properties: {
        at: { type: 'string' }, grids: { type: 'integer' }, read: { type: 'integer' }, failed: { type: 'integer' }, closeWithinOnePoint: { type: 'integer' }, meanGap: { type: 'number' },
        rows: { type: 'array', items: { type: 'object' } }, html: { type: 'string' },
      },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    {
      node: 'map', label: 'grids', itemsPath: 'grids', as: 'rows', resultPath: 'row', maxConcurrency: 9,
      body: { node: 'chain', steps: [
        {
          node: 'agent', label: 'chart', as: 'reading', out: 'Reading',
          state: { id: '{item.id}', operator: '{item.operator}', url: '{item.url}', chart: '{item.chart}', numbers: '{item.numbers}' },
          instructions: 'Open the dashboard url in the browser. Take a screenshot of the chart named in chart, with an ask for the two numbers in numbers, and read both from the screenshot: every number comes from the chart, even where the page also prints it as text. If the page is not the dashboard, file the reading as failed and cite nothing. Cite the screenshot by the evidence path the tool returned.',
        },
        { node: 'call', label: 'published', via: 'tool', tool: 'published', args: { id: '{item.id}', url: '{item.publishedUrl}' }, out: 'Published', as: 'published', deadline_s: 30 },
        { node: 'code', label: 'check', as: 'row', code: CHECK },
      ] },
    },
    { node: 'code', label: 'snapshot', code: SNAPSHOT },
  ] },
} as const satisfies Workflow;

// ---- the fakes --------------------------------------------------------------------------------------------------------

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

export function heroJob(grids: readonly Grid[], at: string): Job {
  return { workflow, input: { at, grids: [...grids] } };
}
