// The hero job, as data: one agent reads electricity grid operators' public fuel-mix dashboards, each in a browser session of its own and
// all at once. The numbers exist only in the charts, so vision reads them (a screenshot with an `ask`, answered from the pixels). Where the
// operator also publishes the mix as data, a `call` fetches it as the check, shown beside the reading. The last step builds `snapshot.html`:
// a table of the grids, each reading linked to the screenshot it came from.
//
// This file is the unit for `agent.run()` and the playground: a workflow, its default input and nothing else. The scripted lead, the eyes,
// the pages and the published figures are in `fakes.ts`; a live host brings its own models, browser and eyes. `sources.json` (the nine
// operators and how each page was checked by hand) is data this job carries inside its workflow.
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '../reference/index.ts';
import sources from './sources.json' with { type: 'json' };

/** One operator of `sources.json`, as the job takes it. */
type Grid = { id: string; operator: string; country: string; url: string; chart: string; numbers: string; peakOf: string; peakUnit: string; publishedUrl: string };

const GRIDS: Grid[] = sources.pages.map((entry) => ({
  id: entry.id, operator: entry.operator, country: entry.country, url: entry.dashboardUrl, chart: entry.chart, numbers: entry.numbers, peakOf: entry.peakOf, peakUnit: entry.peakUnit, publishedUrl: entry.publishedDataUrl,
}));

/** The operators the input names, in the order the input names them, with what the job needs to read each. */
const SELECT = `(s) => { const table = ${JSON.stringify(GRIDS)}; return s.operators.map((id) => table.find((grid) => grid.id === id)); }`;

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
    + rows.map(line).join('') + '</tbody></table><p>' + esc(howClose) + '</p></body></html>';
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
      type: 'object', additionalProperties: false, required: ['at', 'operators'],
      properties: {
        at: { type: 'string', minLength: 1, description: 'The moment the snapshot is taken at, written on the page (an ISO 8601 time).' },
        operators: { type: 'array', minItems: 1, items: { type: 'string', enum: GRIDS.map((grid) => grid.id) }, description: 'The grid operators to read, by id: each is read from its own dashboard in a browser session of its own.' },
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
    { node: 'code', label: 'select', as: 'grids', code: SELECT },
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


// The default input, and the one the recording ran: all nine operators, at a fixed moment so the no-key output is a constant.
const input = { at: '2026-10-15T12:00:00Z', operators: GRIDS.map((grid) => grid.id) };

export const job = { workflow, input, files: {} } satisfies Job;
export default job;
