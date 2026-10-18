# Documentation assets

The support workflow illustration and its editable source live in [docs/assets](docs/assets/README.md). The original diagram and animation use the repository's Apache-2.0 license. The bundled font has separate terms in [FONT-LICENSE.txt](docs/assets/readme-animation/assets/FONT-LICENSE.txt).

The website is maintained in a separate private repository. Its artwork is outside this source release and does not acquire a license from this repository.

## Vendored code

The run viewer ships PDF.js, `pdfjs-dist` 6.4.299 (Mozilla Foundation, Apache-2.0), with its JavaScript decoders for a
scan's images (PDFium's for CCITT and JBIG2, BSD-3-Clause; OpenJPEG's for JPEG 2000, BSD-2-Clause), as the package's
release files, unchanged, from https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz. They are in
[apps/viewer/vendor/pdfjs](apps/viewer/vendor/pdfjs/README.md) with their license files; `vendored.json` there lists
each file's size and SHA-256 (2,348,024 bytes in all), a test checks every file against it, and `docs/dependencies.md`
lists it under "Vendored code".
