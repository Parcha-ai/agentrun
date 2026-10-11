// PDF: the free facts (pages, their sizes, which carry a text layer, producer, creator, saved revisions, signatures),
// text by page, and a page rendered at the highest dpi the image limit allows. Zero install: `unpdf` for text, PDFium
// (WASM) in a worker with a time and memory cap for pages; poppler when the environment has it. The text of a PDF held
// in memory is what a browser's fetch takes for a fetched document.

export {};
