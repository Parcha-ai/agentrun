// The document panel: the pages of a PDF a run's result cites, each drawn whole (the shell draws it with PDF.js, pdf.ts),
// with every box a row cites drawn over its page. It reads the generic cited result (`agentrun.cited/1`, RECORDING.md):
// a cite that names a blob and a page (`page=N`) is that page of that file, and one whose fragment also names a region
// (`page=N&xywh=percent:x,y,w,h`) is a box on it, in percent of the page's crop box, which is the page PDF.js draws: a
// box needs no arithmetic and keeps its place at any width. A row that cites a page without a region is listed under it
// with no box. A panel (PANELS.md): `accepts`, `reduce` and `view` are pure. A recording whose result cites no page draws
// no document panel (`showsResult`).
import type { Json, Line } from './format.ts';
import { h, register, type Box, type Node, type Panel } from './panels.ts';
import { visionCitedOf, visionPage, visionRegion, type VisionCitedResult, type VisionCitedRow } from './vision.ts';

type DocState = { result?: { blob: string; title: string } };
/** A row as a page shows it: the row, the looks it cites there, and every region it names there with the look that cite
 *  names. */
type DocRow = { row: VisionCitedRow; looks: string[]; boxes: { box: Box; look?: string }[] };
type DocPage = { blob: string; page: number; rows: DocRow[] };

const isResult = (line: Line) => line.channel === 'live' && line.source === 'host' && line.kind === 'result';

/** The pages a cited result names, in the order first cited, each with the rows that cite it, in their order, once each
 *  however many regions they name there. A cite whose file the shell knows to be a picture is not a page. */
export function docPagesOf(cited: VisionCitedResult, blobType: (sha: string) => string | undefined = () => undefined): DocPage[] {
  const pages = new Map<string, DocPage>();
  for (const row of cited.rows) {
    for (const cite of row.cites) {
      const page = cite.blob !== undefined ? visionPage(cite.fragment) : undefined;
      if (cite.blob === undefined || page === undefined || blobType(cite.blob)?.startsWith('image/')) continue;
      const key = `${cite.blob}#${page}`;
      const held = pages.get(key) ?? pages.set(key, { blob: cite.blob, page, rows: [] }).get(key)!;
      const shown = held.rows.find((each) => each.row === row) ?? held.rows[held.rows.push({ row, looks: [], boxes: [] }) - 1]!;
      const box = visionRegion(cite.fragment);
      if (box) shown.boxes.push({ box, ...(cite.look !== undefined ? { look: cite.look } : {}) });
      if (cite.look !== undefined && !shown.looks.includes(cite.look)) shown.looks.push(cite.look);
    }
  }
  return [...pages.values()];
}

const docPercent = (box: Box) => `${[box.x, box.y, box.w, box.h].map((value) => Math.round(value * 100) / 100).join(', ')} %`;

/** A page with its boxes and its rows. Each row is numbered on its page, and each of its boxes carries that number,
 *  with the row's words beside it where there is room: rows that cite the same region share one box. A box selects the
 *  look its own cite names, and is lit when that look is the one selected. */
function docPageView(page: DocPage, cite: string | undefined): Node {
  const hot = (shown: DocRow) => cite !== undefined && shown.looks.includes(cite);
  const regions = new Map<string, { box: Box; rows: { shown: DocRow; n: number }[]; looks: string[] }>();
  page.rows.forEach((shown, at) => {
    for (const { box, look } of shown.boxes) {
      const key = [box.x, box.y, box.w, box.h].join(',');
      const region = regions.get(key) ?? regions.set(key, { box, rows: [], looks: [] }).get(key)!;
      if (!region.rows.some((each) => each.shown === shown)) region.rows.push({ shown, n: at + 1 });
      if (look !== undefined && !region.looks.includes(look)) region.looks.push(look);
    }
  });
  const boxes = [...regions.values()].map(({ box, rows, looks }): Node => {
    const look = looks[0];
    return h('div', { class: `doc-box${cite !== undefined && looks.includes(cite) ? ' hot' : ''}`, box, title: rows.map(({ shown }) => `${shown.row.label}: ${shown.row.value}`).join('\n'), ...(look ? { cite: look } : {}) },
      h('span', { class: 'doc-box-label' }, h('b', {}, rows.map(({ n }) => n).join(', ')), h('span', { class: 'doc-box-words' }, ` ${rows.map(({ shown }) => shown.row.label).join(' · ')}`)));
  });
  return h('figure', { class: 'doc-page' },
    { tag: 'pdf-page', blob: page.blob, page: page.page, alt: `page ${page.page}`, class: 'doc-sheet', children: boxes },
    h('figcaption', {}, `Page ${page.page}`, ' · ', { tag: 'a', blob: page.blob, text: 'the file', class: 'doc-file', fragment: `page=${page.page}` }),
    h('ol', { class: 'doc-marks' }, ...page.rows.map((shown) => h('li', { class: `doc-mark${hot(shown) ? ' hot' : ''}`, ...(shown.looks[0] !== undefined ? { cite: shown.looks[0] } : {}) },
      h('span', { class: 'doc-mark-name' }, shown.row.label), ' ', h('b', {}, shown.row.value),
      h('span', { class: 'doc-note' }, shown.boxes.length ? ` · ${shown.boxes.length === 1 ? 'box' : 'boxes'} at ${shown.boxes.map(({ box }) => docPercent(box)).join('; ')}` : ' · no box'),
      shown.row.note !== undefined && h('span', { class: 'doc-note' }, ` · ${shown.row.note}`)))));
}

export const documentPanel: Panel<DocState> = {
  id: 'document',
  title: 'Cited pages',
  init: () => ({}),
  accepts: isResult,
  // A result line is every run's; only a result that cites a page draws this panel.
  shows: () => false,
  showsResult: (result: Json, { blobType }) => { const cited = visionCitedOf(result); return cited !== undefined && docPagesOf(cited, blobType).length > 0; },
  reduce(state, line) {
    const data = line.data as { blob?: unknown; title?: unknown } | null;
    return typeof data?.blob === 'string' ? { result: { blob: data.blob, title: typeof data.title === 'string' ? data.title : 'The result' } } : state;
  },
  view(state, { json, blobType, cite, manifestResult }): Node {
    const note = (text: string) => h('div', { class: 'doc-panel' }, h('p', { class: 'empty' }, text));
    // A recording whose result only its manifest names has it from the start; one with a result line, once delivered.
    const result = state.result ?? manifestResult;
    if (!result) return note('The run has not delivered its result yet: the pages it cites show when it does.');
    const value = json?.(result.blob);
    if (value === undefined) return note('Reading the result.');
    const cited = visionCitedOf(value);
    const pages = cited ? docPagesOf(cited, blobType) : [];
    if (!cited || pages.length === 0) return note('The result cites no page of a file in this recording.');
    // No line gives a manifest's result a time: shown at every stop, it says it is the run's final result.
    return h('div', { class: 'doc-panel' }, !state.result && h('p', { class: 'doc-final' }, 'The run\'s final result, from its manifest: no line of the recording says when it was delivered.'),
      cited.title !== undefined && h('p', { class: 'doc-title' }, cited.title), ...pages.map((page) => docPageView(page, cite)));
  },
};

register(documentPanel);
