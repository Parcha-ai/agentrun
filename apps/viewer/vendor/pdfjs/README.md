# PDF.js, as released

The document panel draws a PDF page with PDF.js. These are release files of the npm package `pdfjs-dist` 6.4.299
(Mozilla Foundation), unchanged, from https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz (registry integrity
`sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`). They are kept here
rather than installed so the viewer still builds with `node build.mjs` and no install step, as the hosted gallery and
both deploy buttons build it.

- `pdf.min.mjs` and `pdf.worker.min.mjs`: PDF.js and its worker, Apache-2.0 (`LICENSE.txt` is the package's `LICENSE`).
- `wasm/jbig2_nowasm_fallback.js`: the decoder for a scan's CCITT and JBIG2 images, from PDFium (BSD-3-Clause,
  `wasm/LICENSE_JBIG2.txt`) with PDF.js's glue (Apache-2.0, `wasm/LICENSE_PDFJS_JBIG2.txt`).
- `wasm/openjpeg_nowasm_fallback.js`: the decoder for JPEG 2000 images, from OpenJPEG (BSD-2-Clause,
  `wasm/LICENSE_OPENJPEG.txt`, `wasm/LICENSE_PDFJS_OPENJPEG.txt`).

The license files are the package's `LICENSE` and `wasm/LICENSE_*` with a `.txt` name. `vendored.json` lists every
file with the path it has in the package, its license, its size and its SHA-256; `test/document.test.ts` checks each
file against it and that nothing else is here, and the viewer README's "Dependencies" and `docs/dependencies.md` list
it. The build copies the two scripts to `dist/pdfjs/` as `pdf.min.js` and `pdf.worker.min.js` (a `.js` name, which
every static host serves as JavaScript) and `wasm/` as it is. The page asks PDF.js for these JavaScript decoders rather
than its WebAssembly builds (`useWasm: false`), so it needs no `.wasm` file.

To move to another release: `npm pack pdfjs-dist@<version>`, unpack it, copy the same files over these (each license
with a `.txt` name), and write the version, the tarball's address and integrity (`npm view pdfjs-dist@<version>
dist.tarball dist.integrity`) and each file's size and SHA-256 into `vendored.json` and the viewer README.
