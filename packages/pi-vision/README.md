# @parcha/pi-vision

Eyes for pi agents. A file becomes something a model can read or see: text for documents and spreadsheets, the
image itself for pictures and scans, frames or a window for video, every image fitted to the model's own limits.
What cannot be done is a typed miss the model can act on, and every look a second model answers is filed with its
SHA-256, its question, its answer, the model and the price.

The host keeps what is its own: which model looks and its price, where receipts are filed, its rows, path custody.
`read` keeps its name and its arguments (`path, offset, limit, char_offset, ask, from_s, to_s, page`), so hosts and
their stored instructions do not change. No tool is added. For many pages, a long video or many images the agent
writes code: the `look` skill (`skills/look/SKILL.md`) shows it how to render pages and cut frames with bash and ask
about them with `vision.see`, the one function this package puts in a host's code mode. Only the answer, where it
looked and the price enter the caller's context.

## Status

The package is built, tested and verified with this repository's other packages, at the workspace version, and a
release publishes it with them under the `beta` tag. Until one has, install it from a packed tarball (see the first
read below). Parts not built yet throw `NotBuiltError`, never a half answer.

| Part | Status |
| --- | --- |
| The model contract: `read`'s media arguments and description, `vision.see`, the section, the miss codes | built |
| The host contract's types, the environment port, budgets (`resolveLimits`), fragments, the provider interface | built |
| The test kit (`./testing`): fake eyes, fixtures, the provider conformance suite | built |
| The test kit's builders of synthetic documents, images and spreadsheets | built |
| The test kit's leak check: sentinels, a scanner, the limits every image block must meet | built |
| The planner | built |
| Images: kinds, fit, tiles, Photon and sharp processors | built |
| PDF: facts, text, pages, poppler | built |
| Office documents and spreadsheets, LibreOffice | built |
| Video: probe, frames by seek, windows, ffmpeg | built |
| `read`'s media half with the package's own reader for every kind, the guard, the eyes on pi-ai, receipts and misses | built |
| The pi-durable adapter, the Node environment and eyes on pi's `Models` | built |
| `vision.see` for a host's code mode, and the `look` skill | built |

## A first read, with no key

A spreadsheet the test kit writes, read the way `read` reads it for a model: no eyes, no key, nothing optional
installed. In an empty directory:

```sh
npm install @parcha/pi-vision@beta
```

Before a release has published it, install the tarball instead: in a checkout of this repository run
`npm ci --ignore-scripts && npm run build -w @parcha/pi-vision && npm pack -w @parcha/pi-vision`, then
`npm install` the `.tgz` it wrote in the empty directory.

`read.mjs`:

```js
import { writeFile } from "node:fs/promises";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { imageSize, xlsxBytes } from "@parcha/pi-vision/testing";

await writeFile("ledger.xlsx", xlsxBytes());
const vision = createVisionExtension({
  evidence: { file: async () => null }, // where looks are filed: nowhere, and a read with no eyes makes none
  scope: () => ({ label: "first-read", deriveDir: "derived" }), // where a document's text is kept for the shell
});
const call = { conversationId: "first-read", callId: "1", model: undefined, signal: undefined };
const result = await vision.read(nodeVisionEnv({ cwd: process.cwd() }), { path: "ledger.xlsx" }, call);

// What the model is given, block by block.
for (const block of result.content) {
  if (block.type === "text") console.log(block.text);
  else { const size = imageSize(Buffer.from(block.data, "base64")); console.log(`[${block.mimeType}, ${size?.width}x${size?.height}]`); }
}
```

`node read.mjs` prints:

```text
Cells of ledger.xlsx (1 sheet), read with office-js; the text is saved at derived/ledger.xlsx-5a119bb78efe62bd.txt. Cells only: formatting, charts, images and pivot views are not shown here. A faithful render needs LibreOffice (soffice) in the environment.

Sheet "ledger"
A1=id | B1=amount | C1=doubled | D1=running_total | E1=account_no
A2=1 | B2=1250.5 | C2=2501 {=B2*2} | D2=<no stored value> {=SUM(B$2:B2)} | E2=9007199254740993
A3=2 | B3=99.99 | C3=199.98 {=B3*2} | D3=<no stored value> {=SUM(B$2:B3)}
```

A cell shows its value, its formula and whether a value was stored; the 16-digit number stays digits. A PDF's text and
an office document's read the same way with nothing installed. An image is fitted to the model's limits by Photon
(`@silvia-odwyer/photon-node`) when it is installed, and without it the read is a `needs` miss that says so. `model`
is the lead's model as pi-ai describes it, which sets the limits; with none, the defaults hold.

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
// limits.image: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80, native: true } for current Claude models
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
| Video: probe, frames, windows | a `needs` miss; a file under the inline budget still goes to a route that takes video | ffmpeg and ffprobe (LGPL or GPL, run as programs) |

`@earendil-works/pi-durable` and `@earendil-works/chord` (1.0.4 to 1.3.x) and `@earendil-works/pi-ai` (any version: the
host's copy) are optional peers, for the adapter and the pi-ai eyes, and Photon is one for the default image processor.
sharp is never resolved by this package: a host that wants it passes its own module (`sharpImages(sharp)`), so its LGPL
code stays with the host's install.

## For a host: `vision.see` in code mode

`handle.see(env, call)` is `vision.see` bound to one call, in the shape pi-codemode's `globals` take. Build it per call,
so it reads paths through that call's environment and keeps its answers in that call's memos:

```ts
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { callContext, createVisionExtension } from "@parcha/pi-vision/durable";

const vision = createVisionExtension({ evidence, scope, eyesModel });
// Inside the host's code-mode tool, `execute(args, api, context)`:
const sandbox = new CodemodeSandbox({ tools, globals: [vision.see(api.env, await callContext(api, context))] });
```

A global is not a tool: the model's tool list does not change, and the sandbox's declarations carry its doc comment and
signature (`VISION_SEE`). Each eyes request is a look, filed and told through `onLook` as `read`'s are; its answer is a
memo before it is told, so a code-mode tool declared replay-safe and cut by a crash pays for each look and tells the host
of it once when it runs again. The looks' price reaches the host through `onLook`, not the code-mode tool's result. A
look that cannot be made throws a `SeeMiss` whose `code` is the miss code and whose message starts with it. There is no
cap on pages, frames or price: a host that wants one wraps `execute`. The planner's own caps (`plan(..., caps)`,
`priceLook(..., capUsd)`) are also the host's to pass, with none by default. pi loads the skill from the package
(`pi.skills`); a host that is not pi gives its agent `skills/look/SKILL.md` the way it gives any skill.

## For a host: what a program is started with

A read may start a program (poppler, ffmpeg, LibreOffice) on a file the host did not write. Such a program is never
given the host process's whole environment: a host keeps credentials there, and a child's environment can be read by
other processes of its user. By default a program gets only what `inheritedEnv()` of `./node` copies from
`process.env`: `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_*`, `TZ`, the loader's library paths
(`LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH`, `DYLD_FALLBACK_LIBRARY_PATH`) and, on Windows, `SystemRoot`, `windir`,
`PATHEXT`, `ComSpec` and `USERPROFILE`.

```ts
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { inheritedEnv, nodeVisionEnv } from "@parcha/pi-vision/node";

// The default, and a host that wants its programs to have one variable more.
const env = nodeVisionEnv({ cwd });
const withFonts = nodeVisionEnv({ cwd, env: { ...inheritedEnv(), FONTCONFIG_PATH: "/etc/fonts" } });

// The adapter takes the same option. It holds for every program a read starts through it: `handle.pdfText`, the
// wrapped `read` on the conversation's pi environment, and `handle.read` on the environment a host hands it.
const vision = createVisionExtension({ evidence, scope, env: { ...inheritedEnv(), FONTCONFIG_PATH: "/etc/fonts" } });
```

`env` is the whole environment of those programs, not an addition to the default: a host that passes
`{ PATH: "/usr/bin" }` gives them that and nothing else. A call's own variables (a provider's) are added over it. pi's
environments give a program all of `process.env` unless a call says not to, so the adapter says so on each call
(`inheritEnv: false`) and passes this environment; `nodeVisionEnv` honours the same switch. So through the adapter, the
adapter's `env` decides, whatever the environment a call runs in was built with: set it there. An environment's own
`env` holds when a host uses it without the adapter. A host whose pi environment runs programs on another machine
passes `env` for that machine, since the default is copied from this process.

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
test that uses it; no real document is ever committed. On a busy machine, `TEST_CONCURRENCY=N` (or
`-- --concurrency N` after either test script) caps how many test files run at once; unset, Node's default holds.

The live eyes check, two paid looks through pi-ai (about a cent) and never part of `npm test` or CI, runs from the
repository root after a build: `PI_VISION_LIVE_EYES=<provider>/<model id> node packages/pi-vision/test/live/eyes.mjs`,
with the provider's key in the variable pi-ai reads and `PI_VISION_LIVE_BASE_URL` set when a gateway serves the model.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
