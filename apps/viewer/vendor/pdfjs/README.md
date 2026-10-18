# PDF.js, as released

The document panel draws a PDF page with PDF.js. These are its release files, unchanged, from the npm package
`pdfjs-dist` 6.4.299 (Mozilla Foundation, Apache-2.0: `LICENSE.txt` is the package's `LICENSE`). They are kept here
rather than installed so the viewer still builds with `node build.mjs` and no install step, as the hosted gallery and
both deploy buttons build it. The build copies the two scripts to `dist/pdfjs/` as `pdf.min.js` and
`pdf.worker.min.js` (a `.js` name, which every static host serves as JavaScript), with the license beside them, and
`wasm/` as it is: PDF.js's JavaScript decoders for a scan's images, CCITT and JBIG2 (`jbig2_nowasm_fallback.js`, from
PDFium, BSD-3-Clause) and JPEG 2000 (`openjpeg_nowasm_fallback.js`, from OpenJPEG, BSD-2-Clause), each with its licenses
(the package's `wasm/LICENSE_*`, as `.txt`). The page asks PDF.js for these instead of its WebAssembly builds
(`useWasm: false`), so it needs no `.wasm` file.

| File | From the package | SHA-256 |
| --- | --- | --- |
| `pdf.min.mjs` | `build/pdf.min.mjs` | `57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2` |
| `pdf.worker.min.mjs` | `build/pdf.worker.min.mjs` | `9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18` |
| `LICENSE.txt` | `LICENSE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| `wasm/jbig2_nowasm_fallback.js` | `wasm/jbig2_nowasm_fallback.js` | `68686ced624a48c42f84cdaa482ec44b72b0de4dc84a0df903af1fb7b45b5d9a` |
| `wasm/openjpeg_nowasm_fallback.js` | `wasm/openjpeg_nowasm_fallback.js` | `9047b34b6bc142d85e4b0aa1b08b0b9baad4c6f8b7ac87641b9e8f90eb6fd23e` |
| `wasm/LICENSE_JBIG2.txt` | `wasm/LICENSE_JBIG2` | `9e66b7f1b934a28b37f3bc4dac97915de1674271e79a0a88182a18ed9731b4d1` |
| `wasm/LICENSE_PDFJS_JBIG2.txt` | `wasm/LICENSE_PDFJS_JBIG2` | `aad3cce09842e00e9e11ad5e8fef8cc02fbc3a3768fe2f007443b9cee37aaee5` |
| `wasm/LICENSE_OPENJPEG.txt` | `wasm/LICENSE_OPENJPEG` | `a6af136f3e15038a666b61f376612a07d9a4e48cb7c01adbf3e33b3f14ab49b6` |
| `wasm/LICENSE_PDFJS_OPENJPEG.txt` | `wasm/LICENSE_PDFJS_OPENJPEG` | `717fc62da03292dbb4dd0c8280bd4ce7bb8550dcf31d772bc93455fb50313425` |

The package's registry integrity is `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`.
`test/document.test.ts` checks each file against this table.

To move to another release: `npm pack pdfjs-dist@<version>`, unpack it, copy the files above over these, and put the
version, the integrity (`npm view pdfjs-dist@<version> dist.integrity`) and the new hashes in this file. The decoders
and their licenses come from the package's `wasm/` the same way.
