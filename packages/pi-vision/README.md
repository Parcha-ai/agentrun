# @parcha/pi-vision

Eyes for pi agents. A file becomes something a model can read or see: text for documents and spreadsheets, the
image itself for pictures and scans, frames or a window for video, every image fitted to the model's own limits.
What cannot be done is a typed miss the model can act on, and every look a second model answers is filed with its
SHA-256, its question, its answer, the model and the price.

The host keeps what is its own: which model looks and its price, where receipts are filed, its rows, path custody.
`read` keeps its name and its arguments (`path, offset, limit, char_offset, ask, from_s, to_s, page`), so hosts and
their stored instructions do not change. One tool is new, `look(source, ask, pages?, from_s?, to_s?, region?)`: a
vision model answers a question about many pages or a long video, and only its words, where it looked and the price
enter the caller's context.

## Status: held

The package is built, tested and verified with this repository's other packages and kept at the workspace version,
and it is not published (`"private": true`). Parts not built yet throw `NotBuiltError`, never a half answer.

| Part | Status |
| --- | --- |
| The model contract: `read`'s media arguments and description, `look`, the section, the miss codes | built |
| The host contract's types, the environment port, budgets (`resolveLimits`), fragments, the provider interface | built |
| The test kit (`./testing`): fake eyes, fixtures, the provider conformance suite | built |
| The test kit's builders of synthetic documents, images and video; the leak check | not built |
| The planner | built |
| Images: kinds, fit, tiles, Photon and sharp processors | not built |
| PDF: facts, text, pages, poppler | built |
| Office documents and spreadsheets, LibreOffice | not built |
| Video: probe, frames by seek, windows, ffmpeg | built |
| `read`'s media half, the guard, the eyes on pi-ai, receipts and misses | not built |
| The pi-durable adapter and the Node environment | not built |
| `look` | not built |

## Entries

- `@parcha/pi-vision`: the host-neutral core. It imports no pi package.
- `@parcha/pi-vision/durable`: `createVisionExtension(options)`, the pi-durable adapter.
- `@parcha/pi-vision/node`: the environment port over Node, for a host whose `read` is its own.
- `@parcha/pi-vision/eyes/pi-ai`: eyes on a pi-ai model the host builds.
- `@parcha/pi-vision/providers/<name>`: `unpdf`, `pdfium`, `office-js`, `photon`, `sharp`, `poppler`, `ffmpeg`,
  `soffice`.
- `@parcha/pi-vision/testing`: fake eyes, fixture helpers and the provider conformance suite, public so a host's
  composition test uses the same fakes.

Importing an entry loads none of the dependencies: each is loaded the first time it is needed.

## Example

The budgets for a route come from the model's own `inputLimits` (pi-ai's registry), with the host's cap on a request
body over them:

```ts
import { citation, resolveLimits } from "@parcha/pi-vision";

const limits = resolveLimits(model, { requestBytes: 20 * 1024 * 1024 });
// limits.image: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } for current Claude models
// limits.requestBytes: the smaller of the model's cap and 20 MiB, less 1 MiB of headroom

citation("filing.pdf", { page: { from: 3, to: 3 } }); // "filing.pdf#page=3"
citation("call.mp4", { t: { from: 60, to: 90 } }); // "call.mp4#t=60,90"
```

## Providers

A provider says what it can do and detects, once per environment, whether it can run there. Zero-install providers
are always there; programs run in the environment the agent's shell runs in, never bundled.

| Job | With nothing installed | When the environment or the host has it |
| --- | --- | --- |
| Fit, convert and tile images | Photon, `@silvia-odwyer/photon-node` (Apache-2.0), an optional peer | sharp (Apache-2.0; its libvips binaries are LGPL-3.0-or-later), passed in by the host |
| HEIC, AVIF | a `needs` miss | sharp built with HEIF, or ffmpeg in the environment |
| PDF text | `unpdf` (MIT) | poppler's `pdftotext` (GPL, run as a program) |
| PDF pages as images | PDFium compiled to WASM, `@hyzyla/pdfium` (MIT; PDFium is BSD-3-Clause and Apache-2.0) | poppler's `pdftoppm` |
| docx and odt text; pptx and odp slides in order, with notes; xlsx and ods cells with value, formula and stored value | the package's own reader (`office-js`) on `fflate` (MIT) and `@xmldom/xmldom` (MIT) | |
| RTF | its source text | |
| An office document as it looks | a `needs` miss; its text still comes back | LibreOffice's `soffice` (MPL-2.0, run as a program) |
| Video: probe, frames, windows | a `needs` miss; a file under the inline budget still goes to a route that takes video | ffmpeg and ffprobe (LGPL or GPL, run as programs); a host's `mediabunny` (MPL-2.0) is accepted by `ffmpegProvider` and not used yet |

`@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` (1.0.4 to 1.1.x) are optional peers,
for the adapter and the pi-ai eyes, and Photon is one for the default image processor. sharp and mediabunny are never
resolved by this package: a host that wants them passes its own module (`sharpImages(sharp)`,
`ffmpegProvider({ mediabunny })`), so their LGPL and MPL code stays with the host's install.

## Develop

```sh
npm run build -w @parcha/pi-vision
npm test -w @parcha/pi-vision                 # everything but the suites that need programs
npm run test:binaries -w @parcha/pi-vision    # test/binaries: needs ffmpeg and poppler; a missing one fails
npm run typecheck -w @parcha/pi-vision        # includes the type tests in test/types
npm run verify:tarball -w @parcha/pi-vision   # packs, installs and imports every entry (needs the registry)
npm run bench -w @parcha/pi-vision            # the free bench on synthetic files
```

Tests import the built package, so build before running one file with `node --test`. Every fixture is built by the
test that uses it; no real document is ever committed.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
