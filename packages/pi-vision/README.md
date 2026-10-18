# @parcha/pi-vision

Eyes for pi agents. A file becomes something a model can read or see: text for documents and spreadsheets, the
image itself for pictures and scans, frames or a window for video, every image fitted to the model's own limits.
What cannot be done is a typed miss the model can act on, and every look a second model answers is filed with its
SHA-256, its question, its answer, the model and the price.

The host keeps what is its own: which model looks and its price, where receipts are filed, its rows, path custody.
`read` keeps its name and its arguments (`path, offset, limit, char_offset, ask, from_s, to_s, page`), so hosts and
their stored instructions do not change. No tool is added. For many pages, a long video or many images the agent
writes code: the `look` skill (`skills/look/SKILL.md`) shows it how to render pages and cut frames with bash and ask
about them with `vision.see`, have Jev judge them with typed answers (`vision.judge`), or have a speech-to-text model
write what a recording says, word by word with its second (`vision.transcribe`): the functions this package puts in a
host's code mode. Only the answers, where they looked or listened and the price enter the caller's context. For a long
recording, the `transcribe` skill (`skills/transcribe/SKILL.md`) shows it how to cut the audio into pieces, transcribe
each with `vision.transcribe`, write one timestamped transcript and search it with `rg` to the second. The
`find` skill (`skills/find/SKILL.md`) finds every time a phrase is said in a long video, from its transcript, and the
second a thing is first seen and its box, coarse to fine: the words narrow the search, Jev scores frames, the eyes
name the second, Jev draws the box. The `verify` skill (`skills/verify/SKILL.md`) says whether a PDF has each mark a
checklist file names, yes or no, with its box on its page. The `report` skill (`skills/report/SKILL.md`) ends a run with
the agent's own report: one script-free HTML page, `report/index.html`, that leads with the answer and shows the evidence
for every finding (the document page with the mark boxed and a close crop of it, the film moment's frame and a short clip
of its window, the photo), and cites every claim to the file's own page, second or region (`file.pdf#page=3`,
`film.mp4#t=18,26`, `#xywh=percent:x,y,w,h`) with the look it rests on.

To see them work together, start at [`examples/vision-agent`](https://github.com/Parcha-ai/agentrun/tree/main/examples/vision-agent):
one agent, given any question about a set of files, that follows every skill here and ends with that report. Its examples
are questions and files: [`video-chapters`](https://github.com/Parcha-ai/agentrun/tree/main/examples/video-chapters) (a
film cut into chapters), [`hear-and-find`](https://github.com/Parcha-ai/agentrun/tree/main/examples/hear-and-find) (when
a line is said and when a thing is first seen) and [`document-check`](https://github.com/Parcha-ai/agentrun/tree/main/examples/document-check)
(which marks a certified copy carries, and where). `document-check` runs on fakes with no key
(`npm run demo:vision -- examples/document-check`); the others are asked of real models with `--live`.

## What it needs

- **Node 22.19 or later, and ESM.** The package is ESM only: `import` it. `require("@parcha/pi-vision")` is not
  supported.
- **A pi-durable host.** pi-vision is a pi-durable extension. `createVisionExtension` wraps `read`, guards every tool's
  images and gives the host's code mode `vision.see`, inside a process that opens a pi-durable Harness and installs the
  extension. [`examples/reference`](https://github.com/Parcha-ai/agentrun/tree/main/examples/reference) is such a host,
  and [what a host supplies](https://github.com/Parcha-ai/agentrun/blob/main/docs/reference-host.md) says what each
  package asks of one. There is no pi coding-agent extension and no command line: a plain
  `pi install npm:@parcha/pi-vision` loads only the skills, and the `vision.see` they call is not defined there. A host
  whose `read` is its own calls `handle.read` and `handle.fit` with `nodeVisionEnv`, as the first read below does; it
  needs no Harness for that.
- **Nothing more for documents.** A PDF's text, an office document and a spreadsheet read with nothing installed. Images
  want Photon (`@silvia-odwyer/photon-node`), video wants ffmpeg, and a look at an image or a scan the lead cannot see
  wants a model that sees and its key.

## Status

Published on npm under the `beta` tag, at the workspace version with this repository's other packages: install it with
`@beta`. Parts not built yet throw `NotBuiltError`, never a half answer.

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
| `vision.judge` (Jev's choice, noul, score and box answers) and Jev's image limits in the fit | built |
| The `verify` skill (`skills/verify/SKILL.md`): whether a PDF has each mark a checklist file names (a seal, a signature, a stamp, two numbers that agree), yes or no, with its box on its page (`file.pdf#page=N&xywh=percent:...`); another kind of document is another checklist | built |
| The `report` skill (`skills/report/SKILL.md`): ends a run with the agent's own script-free HTML report, `report/index.html`: the answer first, the evidence for every finding and a thumbnail for every row (the document page with its mark boxed and a close crop, the film moment's frame and a short clip, the photo), every claim cited to the file's own page, second or region (`file.pdf#page=3`, `film.mp4#t=18,26`, `#xywh=percent:...`) with the look it rests on | built |
| The report's check, which the agent runs before it stops, and its $0 test (`test/binaries/report-skill.test.mjs`): no script and no network, every file present, within budget and without metadata, every cite well formed and resolving to a look, every cited document page embedded with its marks and a close crop of each, no markdown pasted into the text | built |

## A first read, with no key

A spreadsheet the test kit writes, read the way `read` reads it for a model: no eyes, no key, nothing optional
installed. In an empty directory:

```sh
npm install @parcha/pi-vision@beta
```

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
- `@parcha/pi-vision/transcribers`: speech-to-text models for `vision.transcribe`: fal, ElevenLabs and OpenAI.
- `@parcha/pi-vision/providers/<name>`: `unpdf`, `pdfium`, `office-js`, `photon`, `sharp`, `poppler`, `ffmpeg`,
  `soffice`.
- `@parcha/pi-vision/testing`: fake eyes, fixture helpers and the provider conformance suite, public so a host's
  composition test uses the same fakes.

Importing an entry loads none of the dependencies: each is loaded the first time it is needed.

## Example

The budgets for a route come from the model's own `inputLimits` (pi-ai's registry), with the host's cap on a request
body over them. With `@earendil-works/pi-ai` installed (`npm install @earendil-works/pi-ai`), in `limits.mjs`:

```js
import { getModel } from "@earendil-works/pi-ai/compat";
import { citation, resolveLimits } from "@parcha/pi-vision";

const model = getModel("anthropic", "claude-sonnet-5-5"); // pi-ai's catalog entry for the lead's model
const limits = resolveLimits(model, { requestBytes: 20 * 1024 * 1024 });
console.log(JSON.stringify(limits.image));
console.log(limits.requestBytes);
console.log(citation("filing.pdf", { page: { from: 3, to: 3 } }));
console.log(citation("call.mp4", { t: { from: 60, to: 90 } }));
```

`node limits.mjs` prints the image limits of a current Claude model, the request cap (the smaller of the model's cap and
20 MiB, less 1 MiB of headroom) and two citations:

```text
{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80,"native":true}
19922944
filing.pdf#page=3
call.mp4#t=60,90
```

## Providers

A provider says what it can do and detects, once per environment, whether it can run there. Zero-install providers
are always there; programs run in the environment the agent's shell runs in, never bundled.

| Job | With nothing installed | When the environment or the host has it |
| --- | --- | --- |
| Fit, convert and tile images | Photon, `@silvia-odwyer/photon-node` (Apache-2.0), an optional peer | sharp (Apache-2.0; its libvips binaries are LGPL-3.0-or-later), passed in by the host |
| HEIC, AVIF | a `needs` miss | sharp built with HEIF, or ffmpeg in the environment |
| PDF text | `unpdf` (MIT; it runs Mozilla's pdf.js, Apache-2.0) | poppler's `pdftotext` (GPL, run as a program) |
| PDF pages as images | PDFium compiled to WASM, `@hyzyla/pdfium` (MIT; the PDFium it carries is BSD-3-Clause and Apache-2.0) | poppler's `pdftoppm` |
| docx and odt text; pptx and odp slides in order, with notes; xlsx and ods cells with value, formula and stored value | the package's own reader (`office-js`) on `fflate` (MIT) and `@xmldom/xmldom` (MIT) | |
| RTF | its source text | |
| An office document as it looks | a `needs` miss; its text still comes back | LibreOffice's `soffice` (MPL-2.0, run as a program) |
| Video: probe, frames, windows | a `needs` miss; a file under the inline budget still goes to a route that takes video | ffmpeg and ffprobe (LGPL or GPL, run as programs) |

`@earendil-works/pi-durable` and `@earendil-works/chord` (1.0.4 to 1.3.x) and `@earendil-works/pi-ai` (any version: the
host's copy) are optional peers, for the adapter and the pi-ai eyes, and Photon is one for the default image processor.
sharp is never resolved by this package: a host that wants it passes its own module (`sharpImages(sharp)`), so its LGPL
code stays with the host's install. This package's own tarball carries none of the third-party code above: `unpdf`, `@hyzyla/pdfium`,
`fflate` and `@xmldom/xmldom` are its dependencies, each installed as a package of its own under its own license.

## For a host: `vision.see` in code mode

`handle.see(env, call)` is `vision.see` bound to one call, in the shape pi-codemode's `globals` take. Build it per call,
so it reads paths through that call's environment and keeps its answers in that call's memos. This is a host's whole
code-mode tool, a pi-durable extension next to `vision.extension`. `tools` is the host's own: the `look` skill's recipes
render pages and cut frames with `tools.bash`, so a sandbox with no shell cannot run them:

```ts
import { execFile } from "node:child_process";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import type { Extension } from "@earendil-works/pi-durable";
import { callContext, createVisionExtension, piResult } from "@parcha/pi-vision/durable";
import { inheritedEnv } from "@parcha/pi-vision/node";

const vision = createVisionExtension({
  evidence: { file: async () => null }, // where looks are filed
  scope: () => ({ label: "run", deriveDir: "derived" }), // where derived files are kept for the shell
  eyesModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, // looked through the host's pi-ai Models
});

// The shell the skill's recipes call as `tools.bash({ command })`: the command's output, or a rejection that carries it.
// Like every program a read starts, it gets `inheritedEnv()` and not the host's whole environment.
const bash: CodemodeTool = {
  name: "bash",
  description: "Run a shell command in the run's directory",
  execute: (args) => new Promise((resolve, reject) => {
    const command = String((args as { command?: unknown }).command);
    execFile("bash", ["-c", command], { cwd: process.cwd(), env: inheritedEnv() }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)));
  }),
};

// The model's script runs in a sandbox that has the shell and `vision.see` for this call.
export const codeMode: Extension = {
  name: "code-mode",
  tools: [{
    name: "code",
    description: "Run a script that may call vision.see",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    replay: "safe",
    execute: async ({ code }, api, context) => {
      const call = await callContext(api, context);
      const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(api.env, call)] });
      try {
        const run = await sandbox.execute(code, { signal: context.abortSignal });
        return piResult({ content: [{ type: "text", text: JSON.stringify(run.ok ? run.value : run.error.message) }] });
      } finally { await sandbox.close(); }
    },
  }],
};
// The host installs both before it opens the Harness: registry.install(vision.extension); registry.install(codeMode);
```

A global is not a tool: the model's tool list does not change, and the sandbox's declarations carry its doc comment and
signature (`VISION_SEE`). Each eyes request is a look, filed and told through `onLook` as `read`'s are; its answer is a
memo before it is told, so a code-mode tool declared replay-safe and cut by a crash pays for each look and tells the host
of it once when it runs again. The looks' price reaches the host through `onLook`, not the code-mode tool's result. A
look that cannot be made throws a `SeeMiss` whose `code` is the miss code and whose message starts with it. There is no
cap on pages, frames or price: a host that wants one wraps `execute`. The planner's own caps (`plan(..., caps)`,
`priceLook(..., capUsd)`) are also the host's to pass, with none by default. pi loads the skill from the package
(`pi.skills`); a host that is not pi gives its agent `skills/look/SKILL.md` the way it gives any skill.

## For a host: `vision.judge`, Jev in code mode

`handle.judge(env, call)` is `vision.judge`, built per call beside `vision.see`. It reaches Jev, TypeSafe's System One
model, through `VisionOptions.jev`: the judge `createJevRunner` from `@parcha/agentrun-jev` returns, which owns the
transport, the images header and the price, and the model to ask (`jev-1.14.0` unless `jev.model` names another; it is
the first Jev that answers box questions). pi-vision imports neither that package nor the TypeSafe SDK; it hands the
judge each image as PNG or JPEG bytes under a reference written in the request. Install the Jev package with its `beta`
tag (`npm install @parcha/agentrun-jev@beta`); the judge needs `TYPESAFE_API_KEY`:

```ts
import { createJevRunner } from "@parcha/agentrun-jev";
import { createVisionExtension } from "@parcha/pi-vision/durable";

const vision = createVisionExtension({
  evidence: { file: async () => null },
  scope: () => ({ label: "run", deriveDir: "derived" }),
  eyesModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
  jev: { judge: createJevRunner({ apiKey: process.env.TYPESAFE_API_KEY }) },
});
// In the code-mode tool above: globals: [vision.see(api.env, call), vision.judge(api.env, call)]
```

One call is one Jev request. Every image is fitted to Jev's limits first (PNG or baseline JPEG, turned upright, each
side 280 to 1,568 px: grown, or padded when it cannot grow, and shrunk), since Jev rejects an image out of range rather
than resizing it. A box answer also has `fragment`, its region as `file#xywh=percent:x,y,w,h` of the image it was found
in, mapped back through the fit and through the region a crop names. Each judgment is filed and told like a look
(`via: jev`) at the price the judge gives (none known is filed as unknown, never $0), kept as a memo before it is told,
and a miss throws a `SeeMiss` with its code; a box asked of a model that has none is an `unsupported` miss before any
request. Without `jev`, every judgment is a `no_vision_route` miss.

## For a host: `vision.transcribe`, speech to text in code mode

`handle.transcribe(env, call)` is `vision.transcribe`, built per call beside `vision.see`: one audio or video file in,
the words with their start and end in seconds out, in one shape whatever the provider gave. The host picks the
provider in `VisionOptions.transcriber` and holds the key, the way the eyes hold theirs: each transcriber takes an
`apiKey` function read at each request, and nothing the agent's code, the answers, the receipts or the misses see
carries it.

| Provider | Key a stranger sets | Transcriber | Model (default) | One request takes |
| --- | --- | --- | --- | --- |
| fal | `FAL_KEY` (`Authorization: Key`) | `falTranscriber({ apiKey: () => process.env.FAL_KEY })` | `fal-ai/elevenlabs/speech-to-text/scribe-v2`, $0.008 a minute | 2.5 MB inline, measured (fal states no limit): 10 minutes 25 seconds at 32 kbps |
| ElevenLabs | `ELEVENLABS_API_KEY` (`xi-api-key`) | `elevenLabsTranscriber({ apiKey: () => process.env.ELEVENLABS_API_KEY })` | `scribe_v2` | 3 GB |
| OpenAI | `OPENAI_API_KEY` (bearer) | `openAiTranscriber({ apiKey: () => process.env.OPENAI_API_KEY })` | `whisper-1`, the one OpenAI model with word times | 25 MB |

Each transcriber has its own default model, since the providers name them differently; `model` names another. Never
words without times: a model that answers with text alone is an `unsupported` miss that says so. OpenAI's
`gpt-4o-transcribe` and `gpt-4o-mini-transcribe` give no word times, so at OpenAI's own address any model but
`whisper-1` is that miss before any request; any other model that answers without word times is that miss at its price.

A gateway that passes fal's queue through with its own bearer key is `falTranscriber({ apiKey, queueUrl, auth:
"bearer" })`; fal's own addresses in its answers are rewritten to `queueUrl`.

```ts
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { falTranscriber } from "@parcha/pi-vision/transcribers";

const vision = createVisionExtension({
  evidence: { file: async () => null },
  scope: () => ({ label: "run", deriveDir: "derived" }),
  eyesModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
  transcriber: falTranscriber({ apiKey: () => process.env.FAL_KEY }),
});
// In the code-mode tool above: globals: [vision.see(api.env, call), vision.transcribe(api.env, call)]
```

A file over the provider's limit is an `over_budget` miss that names it, before any request; the agent cuts the file
into pieces and transcribes each (the `transcribe` skill shows how). Each transcript is filed and told in the shape of a
look, as tool `transcribe` (`args` the path, model and `via` the provider; kind `audio` or `video`; the words as rows of
start, end and words in the receipt's body), at its list price per audio minute, the length from the provider or from
`ffprobe` in the environment (none known is filed as unknown, never $0), and kept as a memo before it is told, so a
file asked again, or after a cut call, costs nothing. `usdPerMinute` on a transcriber sets the price where the package
names none. Without `transcriber`, every transcription is a `no_vision_route` miss.

## For a host: what a program is started with

A read may start a program (poppler, ffmpeg, LibreOffice) on a file the host did not write. Such a program is never
given the host process's whole environment: a host keeps credentials there, and a child's environment can be read by
other processes of its user. By default a program gets only what `inheritedEnv()` of `./node` copies from
`process.env`: `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_*`, `TZ`, the loader's library paths
(`LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH`, `DYLD_FALLBACK_LIBRARY_PATH`) and, on Windows, `SystemRoot`, `windir`,
`PATHEXT`, `ComSpec` and `USERPROFILE`.

In `programs.mjs`, which asks two environments whether a program started in them finds a name:

```js
import { visionContext } from "@parcha/pi-vision";
import { inheritedEnv, nodeVisionEnv } from "@parcha/pi-vision/node";

const cwd = process.cwd();
const standard = nodeVisionEnv({ cwd }); // a program gets inheritedEnv() and nothing else
const withFonts = nodeVisionEnv({ cwd, env: { ...inheritedEnv(), FONTCONFIG_PATH: "/etc/fonts" } }); // one variable more

// Whether a program started in `env` finds `name` in its environment.
const sees = async (env, name) => (await env.exec(["sh", "-c", `test -n "$${name}"`], undefined, visionContext())).value.exitCode === 0;
for (const [label, env] of [["standard", standard], ["with fonts", withFonts]]) {
  console.log(`${label}: MY_SECRET ${await sees(env, "MY_SECRET")}, FONTCONFIG_PATH ${await sees(env, "FONTCONFIG_PATH")}`);
}
```

`MY_SECRET=hunter2 node programs.mjs` prints:

```text
standard: MY_SECRET false, FONTCONFIG_PATH false
with fonts: MY_SECRET false, FONTCONFIG_PATH true
```

The adapter takes the same option. It holds for every program a read starts through it: `handle.pdfText`, the wrapped
`read` on the conversation's pi environment, and `handle.read` on the environment a host hands it:

```ts
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { inheritedEnv } from "@parcha/pi-vision/node";

export const vision = createVisionExtension({
  evidence: { file: async () => null },
  scope: () => ({ label: "run", deriveDir: "derived" }),
  env: { ...inheritedEnv(), FONTCONFIG_PATH: "/etc/fonts" },
});
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
