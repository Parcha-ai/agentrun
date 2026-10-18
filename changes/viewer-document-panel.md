---
packages: repo
kind: feature
---
**`apps/viewer`: the document panel draws the PDF pages a result cites, each box over its page**
- A cited result (`agentrun.cited/1`) whose cites name a blob and a page (`page=N`) has those pages drawn whole with
  PDF.js, each once, and every box a row cites (`page=N&xywh=percent:x,y,w,h`, percent of the page's crop box) placed
  over its page with its row's number (and the row's words where the page is wide enough; rows citing one region share
  a box); the rows that cite a page are listed under it, numbered, "no box" for one without a region.
  A box and a row that cite a look select it, as a citation chip does. A recording whose result cites no page draws no
  document panel.
- The panel contract gains a `pdf-page` node (the shell draws that page of a PDF blob, its children placed over it in
  percent), `showsResult(result, { blobType })`, which draws a panel for a recording by its result as `shows` does by its
  lines, and `ViewContext.manifestResult`, the manifest's result for a recording in which no line delivers one, which the
  document panel shows at every stop labelled as the run's final result, since no line gives its time.
- PDF.js (`pdfjs-dist` 6.4.299, Apache-2.0) ships as its release files in `apps/viewer/vendor/pdfjs/`, copied to
  `dist/pdfjs/`, so the viewer still builds with no install; a scan's CCITT, JBIG2 and JPEG 2000 images are decoded by
  its JavaScript decoders (PDFium's, BSD-3-Clause, and OpenJPEG's, BSD-2-Clause), shipped beside it with their
  licenses. The page loads it only to draw a page, with its worker a file of the same origin, and hands it the PDF's
  bytes, so it draws under a policy that loads scripts, workers and data from the page's own origin only; a page opened
  from `file://` says it cannot and links the PDF at its page.
- A followed run keeps each PDF it read whole, and a dropped folder reads its files directly, so neither fetches a
  `blob:` address for one.
