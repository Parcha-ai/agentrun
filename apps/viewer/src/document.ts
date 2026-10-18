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
/** One row's cite on a page: the row, the cite, and its box when the fragment names one. */
type DocMark = { row: VisionCitedRow; cite: VisionCitedRow['cites'][number]; box?: Box };
type DocPage = { blob: string; page: number; marks: DocMark[] };

const isResult = (line: Line) => line.channel === 'live' && line.source === 'host' && line.kind === 'result';

/** The pages a cited result names, in the order first cited, each with the rows that cite it. A cite whose file the
 *  shell knows to be a picture is not a page. */
export function docPagesOf(cited: VisionCitedResult, blobType: (sha: string) => string | undefined = () => undefined): DocPage[] {
  const pages = new Map<string, DocPage>();
  for (const row of cited.rows) {
    for (const cite of row.cites) {
      const page = cite.blob !== undefined ? visionPage(cite.fragment) : undefined;
      if (cite.blob === undefined || page === undefined || blobType(cite.blob)?.startsWith('image/')) continue;
      const key = `${cite.blob}#${page}`;
      const held = pages.get(key) ?? pages.set(key, { blob: cite.blob, page, marks: [] }).get(key)!;
      const box = visionRegion(cite.fragment);
      held.marks.push({ row, cite, ...(box ? { box } : {}) });
    }
  }
  return [...pages.values()];
}

const docPercent = (box: Box) => `${[box.x, box.y, box.w, box.h].map((value) => Math.round(value * 100) / 100).join(', ')} %`;

function docPageView(page: DocPage, cite: string | undefined): Node {
  const hot = (mark: DocMark) => cite !== undefined && mark.cite.look === cite;
  const boxes = page.marks.flatMap((mark): Node[] => (mark.box ? [h('div', { class: `doc-box${hot(mark) ? ' hot' : ''}`, box: mark.box, title: `${mark.row.label}: ${mark.row.value}`, ...(mark.cite.look ? { cite: mark.cite.look } : {}) },
    h('span', { class: 'doc-box-label' }, mark.row.label))] : []));
  return h('figure', { class: 'doc-page' },
    { tag: 'pdf-page', blob: page.blob, page: page.page, alt: `page ${page.page}`, class: 'doc-sheet', children: boxes },
    h('figcaption', {}, `Page ${page.page}`, ' · ', { tag: 'a', blob: page.blob, text: 'the file', class: 'doc-file', fragment: `page=${page.page}` }),
    h('ul', { class: 'doc-marks' }, ...page.marks.map((mark) => h('li', { class: `doc-mark${hot(mark) ? ' hot' : ''}`, ...(mark.cite.look ? { cite: mark.cite.look } : {}) },
      h('span', { class: 'doc-mark-name' }, mark.row.label), ' ', h('b', {}, mark.row.value),
      h('span', { class: 'doc-note' }, mark.box ? ` · box at ${docPercent(mark.box)}` : ' · no box'),
      mark.row.note !== undefined && h('span', { class: 'doc-note' }, ` · ${mark.row.note}`)))));
}

export const documentPanel: Panel<DocState> = {
  id: 'document',
  title: 'Cited pages',
  init: () => ({}),
  accepts: isResult,
  // A result line is every run's; only a result that cites a page draws this panel.
  shows: () => false,
  showsResult: (result: Json) => { const cited = visionCitedOf(result); return cited !== undefined && docPagesOf(cited).length > 0; },
  reduce(state, line) {
    const data = line.data as { blob?: unknown; title?: unknown } | null;
    return typeof data?.blob === 'string' ? { result: { blob: data.blob, title: typeof data.title === 'string' ? data.title : 'The result' } } : state;
  },
  view(state, { json, blobType, cite }): Node {
    const note = (text: string) => h('div', { class: 'doc-panel' }, h('p', { class: 'empty' }, text));
    if (!state.result) return note('The run has not delivered its result yet: the pages it cites show when it does.');
    const value = json?.(state.result.blob);
    if (value === undefined) return note('Reading the result.');
    const cited = visionCitedOf(value);
    const pages = cited ? docPagesOf(cited, blobType) : [];
    if (!cited || pages.length === 0) return note('The result cites no page of a file in this recording.');
    return h('div', { class: 'doc-panel' }, cited.title !== undefined && h('p', { class: 'doc-title' }, cited.title), ...pages.map((page) => docPageView(page, cite)));
  },
};

register(documentPanel);
