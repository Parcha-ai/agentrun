# Documentation assets

The support workflow illustration and its editable source live in [docs/assets](docs/assets/README.md). The original diagram and animation use the repository's Apache-2.0 license. The bundled font has separate terms in [FONT-LICENSE.txt](docs/assets/readme-animation/assets/FONT-LICENSE.txt).

The website is maintained in a separate private repository. Its artwork is outside this source release and does not acquire a license from this repository.

## Test media

`packages/pi-vision/test/binaries/assets/apollo11-landing.webm` is 20 seconds of the soundtrack of NASA's film "The Flight of Apollo 11: The Eagle Has Landed" (1969, public domain as a work of the United States government), from second 795 of the film's mobile rendition on images.nasa.gov (nasa_id `KSC-19690716-MH-NAS01-0001-The_Flight_of_Apollo_11_The_Eagle_Has_Landed_HS_from_Film_JSC-DVC_1928`, sha256 `c3ccbdfc11398b9e7c714722939aaac04ba008919721faa7a0ad421631df7dc8`), cut with `ffmpeg -ss 795 -t 20 -i <film> -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k -map_metadata -1 -fflags +bitexact` (ffmpeg 6.1.1; sha256 `d6f618a18978a1a2b0ea40e0e318bc54bbcbfa88caab78590acc5b5ca8126002`). NASA's media guidelines ask that NASA not be implied to endorse anything; it does not here.

## Vendored code

The run viewer ships PDF.js, `pdfjs-dist` 6.4.299 (Mozilla Foundation, Apache-2.0), with its JavaScript decoders for a
scan's images (PDFium's for CCITT and JBIG2, BSD-3-Clause; OpenJPEG's for JPEG 2000, BSD-2-Clause), as the package's
release files, unchanged, from https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz. They are in
[apps/viewer/vendor/pdfjs](apps/viewer/vendor/pdfjs/README.md) with their license files; `vendored.json` there lists
each file's size and SHA-256 (2,348,024 bytes in all), a test checks every file against it, and `docs/dependencies.md`
lists it under "Vendored code".
