# PDF.js, as released

The document panel draws a PDF page with PDF.js. These are its release files, unchanged, from the npm package
`pdfjs-dist` 6.4.299 (Mozilla Foundation, Apache-2.0: `LICENSE.txt` is the package's `LICENSE`). They are kept here
rather than installed so the viewer still builds with `node build.mjs` and no install step, as the hosted gallery and
both deploy buttons build it. The build copies the two scripts to `dist/pdfjs/` as `pdf.min.js` and
`pdf.worker.min.js` (a `.js` name, which every static host serves as JavaScript), with the license beside them.

| File | From the package | SHA-256 |
| --- | --- | --- |
| `pdf.min.mjs` | `build/pdf.min.mjs` | `57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2` |
| `pdf.worker.min.mjs` | `build/pdf.worker.min.mjs` | `9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18` |
| `LICENSE.txt` | `LICENSE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |

The package's registry integrity is `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`.
`test/document.test.ts` checks each file against this table.

To move to another release: `npm pack pdfjs-dist@<version>`, unpack it, copy the three files over these, and put the
version, the integrity (`npm view pdfjs-dist@<version> dist.integrity`) and the new hashes in this file.
