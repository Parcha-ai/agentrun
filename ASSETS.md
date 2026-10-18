# Documentation assets

The support workflow illustration and its editable source live in [docs/assets](docs/assets/README.md). The original diagram and animation use the repository's Apache-2.0 license. The bundled font has separate terms in [FONT-LICENSE.txt](docs/assets/readme-animation/assets/FONT-LICENSE.txt).

The website is maintained in a separate private repository. Its artwork is outside this source release and does not acquire a license from this repository.

## Test media

`packages/pi-vision/test/binaries/assets/apollo11-landing.webm` is 20 seconds of the soundtrack of NASA's film "The Flight of Apollo 11: The Eagle Has Landed" (1969, public domain as a work of the United States government), from second 795 of the film's mobile rendition on images.nasa.gov (nasa_id `KSC-19690716-MH-NAS01-0001-The_Flight_of_Apollo_11_The_Eagle_Has_Landed_HS_from_Film_JSC-DVC_1928`, sha256 `c3ccbdfc11398b9e7c714722939aaac04ba008919721faa7a0ad421631df7dc8`), cut with `ffmpeg -ss 795 -t 20 -i <film> -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k -map_metadata -1 -fflags +bitexact` (ffmpeg 6.1.1; sha256 `d6f618a18978a1a2b0ea40e0e318bc54bbcbfa88caab78590acc5b5ca8126002`). NASA's media guidelines ask that NASA not be implied to endorse anything; it does not here.

## SEC EDGAR exhibit in the document check example

[examples/document-check/sample](examples/document-check/sample/sample.json) holds pages 1 to 4 of exhibit 3.1 to the annual report on Form 10-K of AVEO Pharmaceuticals, Inc. (CIK 0001325879) for the period ended 2021-12-31, filed with the SEC on 2022-03-14, accession number 0001628280-22-006093: a Delaware certified copy of the company's restated certificate of incorporation, with the Delaware Secretary of State's certification pages. It is a public filing, retrieved from SEC EDGAR on 2026-10-18 and included for testing and illustration as fair use. It does not acquire this repository's license, and its use here implies no endorsement by the SEC, the State of Delaware or the company. Filing index: https://www.sec.gov/Archives/edgar/data/1325879/000162828022006093/0001628280-22-006093-index.html. Exhibit: https://www.sec.gov/Archives/edgar/data/1325879/000162828022006093/aveo20211231ex31.htm.

| File | Source | SHA-256 | What was changed |
| --- | --- | --- | --- |
| `aveo-ex3-1-pages-1-4.pdf` | the exhibit's page images `aveo20211231ex31001.jpg` to `aveo20211231ex31004.jpg` (each URL and SHA-256 in `sample.json`) | `cd4990d97f267a0f8849a39f6f224af078236134126c76d0a5fb9672e606e808` | nothing: each page image is placed on a Letter page byte for byte |
| `aveo-ex3-1-pages-1-4-TEST-COPY-marks-removed.pdf` | the same four page images | `0f39e3f0011932320ac920f929be5f33cbc1641d5950d584f46d605255308cbe` | altered for testing: on pages 1 and 2 the seal, the signature, the file and SR numbers and the authentication number and date are painted white; on page 3 the FILED stamp is painted white; every page carries the footer "TEST COPY: marks removed by agentrun for testing; not the filed document". It is not the filed document. |

`sample/build.mjs` makes both files from the page images, which it checks by SHA-256. It fetches them from EDGAR with a User-Agent naming the project, or reads them from a folder.

## The vision examples' NASA film

[examples/video-chapters](examples/video-chapters/inputs.json) and [examples/hear-and-find](examples/hear-and-find/inputs.json) read NASA's film "The Flight of Apollo 11: The Eagle Has Landed" (1969) by URL; nothing of it is committed. A live run fetches the mobile rendition from images.nasa.gov and checks it by size and SHA-256 (`c3ccbdfc11398b9e7c714722939aaac04ba008919721faa7a0ad421631df7dc8`). NASA material is generally not subject to copyright in the United States; it does not acquire this repository's license, and its use here implies no endorsement by NASA.

## Vendored code

The run viewer ships PDF.js, `pdfjs-dist` 6.4.299 (Mozilla Foundation, Apache-2.0), with its JavaScript decoders for a
scan's images (PDFium's for CCITT and JBIG2, BSD-3-Clause; OpenJPEG's for JPEG 2000, BSD-2-Clause), as the package's
release files, unchanged, from https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz. They are in
[apps/viewer/vendor/pdfjs](apps/viewer/vendor/pdfjs/README.md) with their license files; `vendored.json` there lists
each file's size and SHA-256 (2,348,024 bytes in all), a test checks every file against it, and `docs/dependencies.md`
lists it under "Vendored code".
