// A PDF's page as the shell draws it for a `pdf-page` node: PDF.js (pdfjs-dist, Apache-2.0, vendor/pdfjs/README.md),
// loaded from beside the page the first time a page is drawn, with its worker a file of the same origin. The PDF is
// handed to PDF.js as bytes, never as an address to fetch: an embedded blob is a data: URL, and a host whose policy
// fetches only from its own origin refuses to fetch one. Each page is drawn once into a picture and kept, so a redraw
// only places it. A page opened from file:// cannot load PDF.js (a module script); it says so, and the view's own text
// stays. A scan's images (CCITT, JBIG2, JPEG 2000) are decoded by PDF.js's JavaScript decoders beside it, never by
// WebAssembly, so the page needs no file type a static host might not serve.
import type { Recording } from './format.ts';

/** A page as the shell has it: drawn (a picture and its size in pixels), being drawn, or not drawable, and why. */
export type PdfDrawn = { kind: 'drawn'; url: string; w: number; h: number } | { kind: 'drawing' } | { kind: 'failed'; reason: string };

type PdfPageProxy = { getViewport(options: { scale: number }): { width: number; height: number }; render(options: { canvas: HTMLCanvasElement; viewport: unknown }): { promise: Promise<void> } };
type PdfDocument = { numPages: number; getPage(page: number): Promise<PdfPageProxy> };
type PdfLibrary = { GlobalWorkerOptions: { workerSrc: string }; getDocument(options: { data: Uint8Array; enableXfa: boolean; useWasm: boolean; wasmUrl: string }): { promise: Promise<PdfDocument> } };

/** How wide a page is drawn, in pixels: sharp across a wide panel on a dense screen. A very tall page is drawn smaller,
 *  so no page takes more than PDF_PIXELS. */
const PDF_WIDTH = 1600;
const PDF_PIXELS = 4_000_000;

let pdfLibrary: Promise<PdfLibrary> | undefined;
const pdfAt = () => new URL('pdfjs/', document.baseURI).href;
const loadPdfLibrary = (): Promise<PdfLibrary> => (pdfLibrary ??= (async () => {
  const library = await import(`${pdfAt()}pdf.min.js`) as PdfLibrary;
  library.GlobalWorkerOptions.workerSrc = `${pdfAt()}pdf.worker.min.js`;
  return library;
})());

/** A blob's bytes, read without fetching a data: or blob: URL. */
export async function blobBytes(recording: Recording, sha: string): Promise<Uint8Array> {
  const held = recording.heldBytes?.(sha);
  if (held) return held;
  const url = recording.blobUrl(sha);
  if (!url) throw new Error('the PDF is not in this recording');
  const data = /^data:[^,]*?(;base64)?,/.exec(url);
  if (data) return data[1] ? Uint8Array.from(atob(url.slice(data[0].length)), (each) => each.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(url.slice(data[0].length)));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the PDF answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Draws pages of the recording's PDFs, each once and one at a time, in the order they are first asked for (the order
 *  they stand on screen), and calls `drawn` when one is ready or has failed. One page's canvas is held at a time: a drawn
 *  page is kept as an encoded picture. */
export function pdfDrawer(recording: Recording, drawn: () => void): (sha: string, page: number) => PdfDrawn {
  const documents = new Map<string, Promise<PdfDocument>>();
  const pages = new Map<string, PdfDrawn>();
  let queue: Promise<unknown> = Promise.resolve();
  const documentOf = (sha: string) => documents.get(sha) ?? documents.set(sha, (async () => {
    const library = await loadPdfLibrary().catch((error: unknown) => {
      throw new Error(location.protocol === 'file:' ? 'PDF.js cannot load in a page opened from a file; open the viewer from a web server' : `PDF.js did not load (${error instanceof Error ? error.message : String(error)})`);
    });
    return library.getDocument({ data: await blobBytes(recording, sha), enableXfa: false, useWasm: false, wasmUrl: `${pdfAt()}wasm/` }).promise;
  })()).get(sha)!;
  return (sha, page) => {
    const key = `${sha}#${page}`;
    const held = pages.get(key);
    if (held) return held;
    pages.set(key, { kind: 'drawing' });
    queue = queue.then(() => (async (): Promise<PdfDrawn> => {
      const pdf = await documentOf(sha);
      if (page > pdf.numPages) return { kind: 'failed', reason: `the PDF has ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}, not ${page}` };
      const proxy = await pdf.getPage(page);
      const whole = proxy.getViewport({ scale: 1 });
      const viewport = proxy.getViewport({ scale: Math.min(PDF_WIDTH / whole.width, Math.sqrt(PDF_PIXELS / (whole.width * whole.height))) });
      const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(viewport.width), height: Math.round(viewport.height) });
      await proxy.render({ canvas, viewport }).promise;
      const picture = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      const [w, h] = [canvas.width, canvas.height];
      canvas.width = 0;
      if (!picture) return { kind: 'failed', reason: 'the page could not be turned into a picture' };
      return { kind: 'drawn', url: URL.createObjectURL(picture), w, h };
    })().catch((error: unknown): PdfDrawn => ({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) }))
      .then((done) => { pages.set(key, done); drawn(); }));
    return pages.get(key)!;
  };
}
