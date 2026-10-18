# @parcha/pi-browser

A browser for [pi](https://github.com/earendil-works/pi) agents that survives crashes. The package records a session
before it calls the provider and releases it with a durable task. After a crash it reruns reads and never reruns actions.
It files every page the agent reads as evidence with its SHA-256, gives each failure a typed code, and keeps credentials out
of anything the model, a document or a log can see.

Part of [AgentRun](https://github.com/Parcha-ai/agentrun). Node `>=22.19.0`, pi 1.1 and 1.2 (the
coding-agent entry also runs on pi 1.0.4). ESM only: the
package has `import` entries and no `require` entry.

## Install

```sh
pi install npm:@parcha/pi-browser    # the pi coding agent's extension
npm install @parcha/pi-browser       # the library: providers, driver, durable adapter
```

Until it is published, build it from a checkout and `pi install ./packages/pi-browser`.

Stagehand, undici, zod and the two HTML packages are dependencies. Four optional peers cover the rest. Install only the ones you use:

| Peer | Needed for |
|---|---|
| `@earendil-works/pi-coding-agent` | `/coding-agent`. `pi install` supplies it. |
| `@earendil-works/pi-durable` and `@earendil-works/chord` | `/durable`, the adapter for a pi-durable Harness. |
| `@browserbasehq/sdk` | the Browserbase provider. Kernel needs no SDK. |

The pi peers are `@earendil-works/pi-durable` and `chord` `>=1.1.0 <1.4.0`, and `@earendil-works/pi-coding-agent` at any version, as pi's package guidance asks of the packages it supplies. The suite passes on pi 1.1, 1.2 and 1.3, and the coding-agent entry's tests also pass on a pi 1.0.4 family.

pi 1.0.4 or 1.1.x users: pin `@earendil-works/pi-codemode` to the same version as `@earendil-works/pi-coding-agent` (`@1.0.4`, or `@1.1.0`), because pi-codemode 1.2.0 removed an export those versions import, or use pi 1.2.

## Quick start

A local Chrome, one page, one snapshot. It needs Chrome or Chromium; `CHROME_PATH` names it.

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpProvider } from "@parcha/pi-browser/providers/cdp";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";

const profileRoot = await mkdtemp(join(tmpdir(), "pi-browser-"));
const provider = cdpProvider({ chrome: { executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", profileRoot } });
const signal = AbortSignal.timeout(60_000);
const session = await provider.create({ tag: "quick-start", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, signal);
try {
  const driver = await stagehandDriver()(await provider.attach(session), signal);
  await driver.run({ code: `await page.goto(${JSON.stringify(process.argv[2] ?? "https://example.com")})` });
  console.log(await driver.snapshot());
  await driver.close();
} finally {
  await provider.release(session);
  await rm(profileRoot, { recursive: true, force: true });
}
```

## Try it without a key or a Chrome

The Quick start's provider, driver and snapshot, on the package's fake backend: no browser, no key and no network. Paste it into a shell in a directory where the package is installed.

```sh
node --input-type=module <<'EOF'
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

const start = "https://example.test/";
const backend = new FakeBackend({ start, pages: { [start]: fixturePage(start, "The answer is forty-two.", "Example") } });
const signal = AbortSignal.timeout(30_000);
const session = await backend.provider.create({ tag: "no-key", maxLifetimeS: 60, idleTimeoutS: 30, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, signal);
const driver = await fakeDriver(backend)(await backend.provider.attach(session), signal);
console.log(await driver.snapshot());
await driver.close();
await backend.provider.release(session);
EOF
```

It prints the page's accessibility tree, the same text `snapshot` gives a model:

```
[0] main
  [1] text: The answer is forty-two.
```

## Demos

Four runnable demos live in `examples/` in the repository. They are not in the npm package. Build once with `npm ci && npm run build`, then run one from the repository root. Each needs Chrome or Chromium (`CHROME_PATH` names it) except where it says otherwise.

| Demo | Run | What it shows |
|---|---|---|
| [`examples/one-script-three-providers.mjs`](examples/one-script-three-providers.mjs) | `node packages/pi-browser/examples/one-script-three-providers.mjs https://example.com` | The same script on a local Chrome, Browserbase or Kernel. `PI_BROWSER_PROVIDER=browserbase` needs `BROWSERBASE_API_KEY` and the Browserbase SDK; `kernel` needs `KERNEL_API_KEY`. The tests run the local Chrome path only. |
| [`examples/hold-an-irreversible-action.mjs`](examples/hold-an-irreversible-action.mjs) | `node packages/pi-browser/examples/hold-an-irreversible-action.mjs` | Under the `ask` policy a form post is held until a person approves it. The demo refuses, and the local server it posts to counts zero requests. |
| [`examples/crash-and-resume.mjs`](examples/crash-and-resume.mjs) | `node packages/pi-browser/examples/crash-and-resume.mjs`, twice | The first run sets a page title and kills itself with SIGKILL between two tool calls. The second recovers the same Chrome from the run's own store and reads the title back. A scripted model stands in for a real one. It uses the pi-durable packages the repository already installs. Delete `$TMPDIR/pi-browser-crash-demo` to start over. |
| [`examples/read-a-pdf.mjs`](examples/read-a-pdf.mjs) | `node packages/pi-browser/examples/read-a-pdf.mjs` | `web_fetch` on a PDF the fetch service cannot convert. It fetches the file raw and hands the bytes to your extractor, here poppler's `pdftotext` (needs poppler installed). The fetch service is a stand-in that answers HTTP 400 for a PDF, as Browserbase does. It does not need Chrome. |

## Entries

- `@parcha/pi-browser`: the host-neutral core. The model contract (tool names, descriptions, JSON schemas, effect and
  replay classes, the `browser` and `web` prompt sections), the typed failure envelope, the redactor, the screenshot
  budget, the repeat guard, evidence and decision-hook types, usage and prices, `find` (chunking and ranking a long page),
  `browser_downloads`, the opt-in request observer, and the provider interface. It imports nothing outside Node's builtins.
- `/durable`: the pi-durable adapter. `createBrowserExtension` is session custody in the run's own store (a create is
  committed before the provider is called, release is a durable task, reconcile runs at run open). `createWebExtension` is
  `web_fetch` and `web_search`.
- `/coding-agent`: the pi coding agent's extension, described under [For pi users](#for-pi-users). `pi install` loads it.
- `/driver/stagehand`: `stagehandDriver()`, Stagehand v4 over upstream's facade, vendored unedited in
  `src/vendor/stagehand-facade/`. `UPSTREAM.json` names the commit and each file's blob id and SHA-256;
  `node scripts/vendor-facade.mjs --check` verifies them and `--commit SHA --release NAME` re-vendors. Stagehand is created
  sealed: no inference, no cache, its trace exporter pointed at a closed loopback port.
- `/providers/browserbase`, `/providers/kernel`, `/providers/cdp`: where browsers come from. Browserbase through its SDK,
  with the credential-proxy dial and the connect-URL rewrite. Kernel through its REST API on the package's own HTTP agent.
  Any CDP endpoint, or a local Chrome the provider starts and kills by exact pid.
- `/live-view`: a person sees and drives the local Chrome (the cdp provider) from your page, with nothing leaving the machine but the model. See
  [A live view of your own Chrome](#a-live-view-of-your-own-chrome).
- `/testing`: the shared test fake. A provider backend with a ledger of every call, a credential broker, an HTTP face so the
  ledger outlives a killed child process, a driver over in-memory pages, and sentinel credentials. A host's composition
  test and this package's crash matrix use the same one.

## The tools

| Tool | Does | Replay after a crash |
|---|---|---|
| `snapshot` | The page's accessibility tree with bracketed ids: a working view for the next `run`. Never filed, so it is not citable evidence. | Reruns. |
| `screenshot`, `browser_read` | Read the page. Each read is filed as evidence with its URL, SHA-256 and the offset into the session's recording. A screenshot is held to 2,000 px on its long edge. A `screenshot` can take a `clip` (CSS pixels from the viewport's top-left corner), an `id` from the latest snapshot or a CSS `selector` (scrolled into view first) to capture one region (a blank `id` or `selector`, or a clip of zero width and height, counts as not given); an empty or off-screen region, or an element that matches nothing or more than one, is refused with the typed envelope before any capture. Its `details.media` gives the image's path, type, size and the region. | Reruns. A read whose session was lost answers `session_replaced`. |
| `browser_downloads` | Copy what the session downloaded into the host's workspace, with a manifest of SHA-256 sums. Listed only when the host gives a `workspace` and the provider can list downloads. | Reruns; files already there are skipped. |
| `run` | Act: code, or a batch of ref actions. | Never reruns. The model is told the call may have taken effect and where the page was, and the identical code is refused once (`effect_unknown`). |
| `browser_release`, `browser_relaunch` | End the session; end it and open another. | Idempotent. A create carries a tag, so a rerun finds its session. |
| `web_fetch`, `web_search` | Fetch a page or search, through the provider's services. | Reruns. |

`web_fetch` and `web_search` results carry their price as pi usage (the Browserbase provider's list prices). Session
minutes are charged by the session meter (`core/usage.ts`, wired into custody): every session tool's result carries the
time since the last charge, and each released session's record carries its total.

Every failure is one envelope: `ok: false`, a `code`, `retryable`, `effect` (`none` or `possibly_effected`) and a message
that names the way out.

## For pi users

The pi coding agent gets `snapshot`, `run`, `screenshot`, `browser_read`, `browser_relaunch`, `browser_release` and
`web_fetch` (plus `web_search` when the provider offers one). It opens a Chrome of its own on first use, reads and drives
pages through Stagehand, files every page and screenshot with the page's URL and a SHA-256, and closes the Chrome when you
release it, after three idle minutes, or when the session ends. Nothing starts until the model's first browser call.

The local browser needs Chrome or Chromium: the one named by `--browser-chrome` or `PI_BROWSER_CHROME`, else `CHROME_PATH`,
else the first of `google-chrome`, `chromium` and the usual install locations (`/opt/google/chrome/chrome`, Chrome in
`/Applications`, Chrome in `Program Files`). It is tested on Linux; macOS and Windows are not verified.

| Setting | Meaning |
|---|---|
| `--browser-chrome PATH`, `PI_BROWSER_CHROME` | The Chrome to start. A path that does not exist is refused by name, never replaced. |
| `--browser-headed`, `PI_BROWSER_HEADED=1` | Show the window instead of running headless. |
| `--browser-no-sandbox`, `PI_BROWSER_NO_SANDBOX=1` | Start Chrome without its sandbox. Needed as root, in a container, or where user namespaces are restricted. Use it only for pages you trust. |
| `--browser-endpoint URL`, `PI_BROWSER_ENDPOINT` | Attach to a Chrome you already run (`http://host:port` or `ws://`) instead of starting one. Releasing leaves it running. |
| `--browser-provider browserbase`, `PI_BROWSER_PROVIDER` | Use Browserbase. Needs `BROWSERBASE_API_KEY` (`BB_API_KEY` also works); a missing key is refused by name. `PI_BROWSER_PROXIES=1` turns on its proxies. |
| `--browser-provider kernel`, `PI_BROWSER_PROVIDER` | Use Kernel. Needs `KERNEL_API_KEY`; a missing key is refused by name. `KERNEL_BASE_URL` points at another Kernel API. `PI_BROWSER_STEALTH=1` turns on Kernel's stealth mode. |

What it does with your machine and your data:

- The Chrome it starts has its own profile directory under a temporary root and a free debugging port, never your browser's
  profile and never port 9222. The profile is deleted when the browser is released.
- Pages and screenshots are filed under `<project>/.pi/browser/evidence/`, each as a receipt (`tool`, `args`, `status`, the
  page's final URL and title, `sha256`, then the body). A credential-shaped query parameter in a URL, a Bearer value and a
  key of the shapes Stagehand knows are replaced by `[redacted]` before anything is filed, shown to the model or stored.
- Each browser session is appended to the pi session file (`browser.session` entries; the model never sees them). The coding
  agent has no mid-turn resume, so a resumed session gets a fresh browser: cookies and page state do not carry over. A Chrome
  that a crashed pi left running is closed when that session is next started, never adopted.
- Stagehand's trace export is pointed at a closed loopback port, so nothing you browse goes to a third party.
- `browser_relaunch` with `verified` or `geolocation` changes nothing on a local Chrome or on Kernel; they are Browserbase features.

Providers and `web_fetch`:

- Without a fetch service, `web_fetch` reads public hosts only. It refuses loopback, private and link-local addresses at every
  redirect hop, anything over 5 MiB, and non-text, and it sends no cookies or credentials.
- A PDF the fetch service will not convert to markdown (Browserbase answers HTTP 400) is fetched once more as the raw file.
  The coding agent has no PDF text extractor, so `web_fetch` says the URL is a PDF and that `format: "raw"` returns its
  bytes, base64-encoded. A host with an extractor passes `pdf: { text(bytes, url, signal) }` to `createWebExtension`; the text
  it returns is answered and filed as the page (`extractor: pdf-text`, judged by `classifyPage` like any page). A PDF over
  32 MiB is not handed to it, and it gets 120 s (`maxBytes`, `timeoutMs`); a PDF with no text says so.
- On Kernel, each session is tagged with its run and lease tag, so a crashed pi's session is found again by tag. It is
  created with an idle timeout equal to the idle release (three minutes), so Kernel ends a browser nobody is connected to if
  pi dies, and a release deletes it and waits until Kernel shows it gone. Stagehand's extension must be stored in your Kernel
  project: a stored extension with the same bytes (Kernel's checksum) is used whatever its name and never changed, and
  otherwise the first session uploads it once as `agentrun-stagehand-<sha256 prefix>`. A plan with no room for it fails the
  launch naming `insufficient_plan`. Kernel's live view is not offered, because its API has no read-only form of it. Kernel
  calls go direct, never through `HTTP(S)_PROXY`, as Browserbase's do; a host behind a proxy passes its own `fetch` to `kernelProvider`.

Limits: a crash loses the in-flight turn and the browser with it. `pi install` pulls Stagehand, about 40 MB and 52 packages
with its dependencies.

## For hosts

Any pi-durable `Harness` can install the extensions. A local Chrome is the default provider and costs nothing.

```js
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";
import { cdpProvider } from "@parcha/pi-browser/providers/cdp";

const provider = cdpProvider({ chrome: { executablePath: "/usr/bin/google-chrome", profileRoot: "/var/lib/my-app/browser-profiles" } });
const browser = createBrowserExtension({
  provider: () => provider,
  driver: stagehandDriver(),
  evidence: { file: async (label, record) => /* write record.body somewhere; return { path } or null */ null },
});
const registry = createRegistry();
registry.install(browser.extension);          // before the Harness resumes anything
const harness = await Harness.open(storage, { models, registry }, context);
// `isActive` says whether a conversation will continue in this process; a session of one that will not is released.
await browser.reconcile(harness, () => true, context);   // settles what a dead process left
// A conversation selects the extension and writes its BrowserConfig in its creating commit (`browser.docs.Config`);
// when it ends: `await browser.release(conversation, "close", context)`.
// Before `harness.close()`: `await browser.drain(harness, context)`, so the releases reach the provider.
```

`createBrowserExtension` takes no key and sends nothing anywhere but the provider you give it. The options:

- `driver`: `stagehandDriver()`, or your own `DriverFactory`.
- `provider`: for example Browserbase from the run's env (`BROWSERBASE_API_KEY` or `BB_API_KEY`, the proxy URLs and the
  project id), with your own metadata stamped on every session.
- `evidence`: a sink that files each read where your receipts already are.
- `onSession`: the host channel. It receives each session's row and, only there, the live-view URLs. Nothing in the run log, a
  result or a log line carries them.
- `decisions`: `classifyPage` and `rankChunks`, answered with your judge. Absent, no page is classified and no find is ranked.
- `redact.values`: exact strings to scrub besides the built-in shapes.
- `section.addendum`: your text after the package's prompt section.
- `workspace`: where `browser_downloads` writes. Absent, that tool is not listed.
- `prices`: your session price (for example from `BROWSERBASE_USD_PER_MINUTE`). It prices the session meter, so each session
  tool's result and each released session's record carry dollars. Without it the minutes are recorded unpriced.

Per conversation, the host writes a `BrowserConfig` (`label`, `run`, and the policy: proxies, verified, captcha, geolocation,
region, a raw context id, the session timeout, the idle release and the batch timeout; `DEFAULT_BROWSER_POLICY` holds the
package's defaults to spread and override) in the conversation's creating commit,
selects the extensions for it, and calls `handle.release(conversation, "close", ctx)` when the conversation ends. Releases run
as background tasks, which `waitForIdle` skips and closing the harness aborts: before it closes, a host calls
`handle.drain(harness, ctx, signal?)`, which resolves once none is live. At run open, after the extensions are installed and
before anything resumes, it calls `handle.reconcile(harness, isActive, ctx)`, and every session a dead process left is bound,
kept or released. The host wraps the tools (`handle.tools`) with its own policy: pause, call records, a result cap, media for
the route.

A host with its own provider implements `BrowserProvider`: `name`, `caps`, `create` (at most once, the tag stamped on the
provider's side), `findByTag`, `status`, `attach`, `release`, and optionally `liveView`, `recordings`, `downloads`, `fetch`
and `search`.

Two things to know before you give a model a browser:

- **What a model may reach is your decision.** `web_fetch` takes only absolute `http(s)` URLs with no credentials, and the
  coding agent's built-in fetch refuses private addresses, but a provider's fetch service and a driven browser go wherever
  their network goes. A host that must not let a model reach internal addresses restricts that network or the URLs it passes.
- **The Browserbase provider changes the process.** Its first call that needs the Browserbase client adds Browserbase's hosts to `NO_PROXY` and `no_proxy`, and
  the first attach replaces `globalThis.WebSocket` with a wrapper that dials a bound credential proxy instead of the raw
  connect URL. Both are process-wide. The wrapper passes every other URL through unchanged. Importing the package does
  neither.

### Recording what the browsers show

`@parcha/pi-browser/recorder` screencasts each session over DevTools (a local Chrome, Browserbase and Kernel all speak it) and hands
`agentrun.recording/1`'s `frame` and `frame.gap` lines, with their JPEGs, to a sink you pass. It is read-only beside the session's own
connections, and it writes nothing itself.

```js
import { frameRecorder } from "@parcha/pi-browser/recorder";

const frames = frameRecorder({
  clock: () => Date.now() - started,                 // ms since the recording started: every line's `t`
  gen: () => generation,                             // optional: this process's generation, on every line
  lastFrameAt: (session) => lastFrameT(session),     // optional: where an earlier process's frames for a session stopped
  sink: (line, blobs = {}) => {                      // blobs: sha256 hex -> JPEG bytes; the sink keeps blobs/<sha256>.jpg and adds `seq`
    for (const [sha, bytes] of Object.entries(blobs)) fs.writeFileSync(`blobs/${sha}.jpg`, bytes);
    events.write(JSON.stringify({ ...line, seq: seq++ }) + "\n");
  },
});
const browser = createBrowserExtension({ provider: ({ conversationId }) => frames.watch(provider, conversationId), driver, evidence });
```

A session is captured from the moment it is created or reattached (so after a kill the same session resumes by itself). The lines:

```json
{"channel":"live","source":"browser","kind":"frame","gen":1,"t":20123,"conv":3,"data":{"session":"bb_4e1a","provider":"browserbase","w":800,"h":500,"mime":"image/jpeg"},"blobs":["9c0e..."]}
{"channel":"live","source":"browser","kind":"frame.gap","gen":2,"t":26004,"conv":3,"data":{"session":"bb_4e1a","from":21004,"reason":"process_killed"}}
```

- Capture is JPEG at quality 60, at most 800 px wide and 10 frames a second per session (the newest frame wins), of the page the agent is using.
  Every line carries the `conv` of the conversation that owns the session (given to `watch`, or read from the lease tag); a session whose
  conversation cannot be told is not recorded.
- A gap is written, never filled: `process_killed` when a session this process did not create is taken up and `lastFrameAt` knows its last
  frame, `session_released` when the session is released, `credential_on_page` while a credential is on the page.
- **No frame is kept while a credential or a code is on the page**, and anything the recorder cannot read counts as one being there. A frame is
  judged against the page the moment it arrives (one check, standing for the page at its capture) and again when its turn to be kept comes (both
  checks go through one pace per session: each is sent at least 50 ms after the last, so a session sends at most 20 `Runtime.evaluate` in any
  second, however fast frames arrive); a credential seen in either drops it, and a frame held across a navigation or a move to another page is not kept. The check looks at password
  fields, `one-time-code` fields and fields named like a code (name, id, `<label>`, `aria-labelledby`, `aria-label` or placeholder says otp, totp,
  2fa, passcode, ...) that hold a value, in the page, open shadow roots and same-origin frames; a value typed and cleared between two checks is
  still seen (the page keeps a flag, `window.__piFramesSecret`, set by the fields' own `input` events). A page that nests deeper than the check
  reads (eight shadow roots or frames) and a visible frame whose content it cannot reach (another origin: a payment or sign-in widget) count as
  a credential present; a frame with no area, or not displayed, is not a picture of anything and does not. A page that cannot be checked at all
  is not recorded. The pause lasts until the page navigates and the check is clean; the gap says why in `data.detail` (`field`, `typed`,
  `too_deep`, `unreadable_frame` or `host`). What no script in the page can see (a closed shadow root, a value set by script with no event) is the
  host's to pause with `frames.pause(session)` (lifted with `frames.resume(session)`).
  A host that lets a person drive a session (the live view) passes `hold: (ref) => boolean`: while it answers `true` for a session no frame is stored and one gap
  (`credential_on_page`, detail `host`) marks the span, not one per skipped frame; when it answers `false` frames resume. A hold that throws counts as `true`.
  The screencast sends a frame only when the page repaints, and a person's login has often already left the page, so when a hold lifts the recorder captures one frame of the page as it is then (a one-off screenshot of the followed session, judged like any other: a field still holding a credential makes it the credential gap, not a frame); a capture that fails costs that frame only. No new option. A withheld frame never counts as the last frame kept, so a `session_released` gap inside a hold starts at the last frame stored before it.
- A live-view URL is never recorded or asked for: the recorder reads only the session's DevTools socket and never writes its address.
- Lines reach the sink one at a time, in order. A sink that throws, rejects or does not answer within `sinkTimeoutMs` (5 s) cannot fail a browser
  call: that line is dropped and counted in `frames.stats()`, and a frame that was not saved never becomes the point a later gap starts from.
- `frames.watch(...).release` ends the capture, and writes the `session_released` gap, once the provider has released the session: a release it
  refuses leaves the capture running.
- **`frame.track`** (a WebM per session with an index) is made at export, from the recorded frames, by `exportFrameTracks`:

  ```js
  import { exportFrameTracks } from "@parcha/pi-browser/recorder";
  const tracks = await exportFrameTracks({ lines, readBlob: (sha256) => bytesOfBlob(sha256), endAt: recordingEndMs, fps: 10 });
  for (const { line, blobs } of tracks) { /* line is the frame.track line; blobs holds the WebM and its index by sha256 */ }
  ```

  One track per session that has a frame. The video is VP9 at a constant `fps` (default 10) on one canvas, the largest frame in even numbers (a smaller
  frame is centred on it); each frame is shown until the next one, and while a gap lasts the video shows a slate: from the moment a
  `credential_on_page` or `session_released` gap was written, and from the last frame the earlier process saved for a `process_killed` gap (nothing is
  known after it). The track runs from the session's first frame to `endAt` (default: the last line, a lone frame lasting one frame's time). The line is
  `{ kind: "frame.track", t: <the track's end>, conv, data: { session, fps, from, to }, blobs: [<webm sha256>, <index sha256>] }`; the index (JSON) lists every
  frame with its `t` and its `ms` offset into the video, and every gap with `from`, `to`, `reason` and `detail`, so a viewer maps a time in the recording to a
  time in the video (`t - from`). A frame whose blob is missing, does not hash to its name or is not a JPEG shows the slate and is reported in `skipped`.
  The step starts `ffmpeg` (`ffmpeg` option: a path; default the one on the PATH) in a private temporary directory with `PATH`, `LANG`, `LC_ALL` and `HOME`
  only, with fixed arguments and no URL, a timeout (`timeoutMs`, 120 s) and an `AbortSignal`; a failure is a `TrackExportError` (`ffmpeg_missing`,
  `ffmpeg_failed`, `ffmpeg_timeout`, `aborted`) and writes nothing.

### A live view of your own Chrome

Browserbase and Kernel give a host a live-view URL for their browsers. `@parcha/pi-browser/live-view` gives the same for the cdp provider's own Chrome: a canvas
showing the session's active page, and the person's mouse, keys, paste, address bar, back and reload sent to it.

```ts
import { createLiveView, liveViewProvider } from "@parcha/pi-browser/live-view";
import { cdpProvider } from "@parcha/pi-browser/providers/cdp";

const liveView = createLiveView({
  hostOrigin: "https://app.example",              // the one origin that may frame the viewer (null: none)
  baseUrl: "https://app.example/live/run-123",    // where you mount it; omit it and the live view serves itself on 127.0.0.1
});
server.on("request", (req, res) => { if (!liveView.handle(req, res)) next(req, res); });
server.on("upgrade", (req, socket, head) => { if (!liveView.upgrade(req, socket, head)) socket.destroy(); });

const provider = liveViewProvider(cdpProvider({ chrome }), liveView);   // wrap it as the recorder's `watch` wraps a provider
createBrowserExtension({ provider: () => provider, onSession: (row) => { /* row.liveView.fullscreen is the viewer's URL */ }, ... });
```

The URL is a full-control credential and goes to `onSession` only (never a result, a record or the model): `https://.../live/run-123/v/<id>#t=<token>`. The
token is 256 random bits in the fragment, so it reaches no server log, proxy or Referer; the viewer's script sends it as the WebSocket's first message and
nothing is accepted before it. The upgrade's `Origin` must be the viewer's own origin (behind a proxy, pass the upgrade through with `Origin` intact).
There is one authenticated viewer per session (a second is refused `viewer_in_use`); the token, the stream and the viewer's socket end at the session's release.
The page is served with `Referrer-Policy: no-referrer`, `default-src 'self'` and `frame-ancestors` set to `hostOrigin`. The viewer may send a page only to
http(s) addresses. Frames are held one at a time and acknowledged after they were sent; none is written anywhere.

A person and the model never act on the browser together. Every browser tool is a model call on its session's gate (`drivingGates`, shared by default between the
live view and the toolset, so you pass nothing): while a person has driven within the last 3 s the call is refused before it does anything (`refused`,
`person_driving: ...`, retryable), and while a call runs the viewer's input is discarded with a notice, not queued. To use your own registry, pass the same one to both
sides: `const gates = createDrivingGates({ idleMs: 5_000 }); createLiveView({ hostOrigin, gates }); createBrowserExtension({ ..., gates });`.

`drivingGates(tag).viewing()` is true for as long as an authenticated viewer is connected to that session, even when the person sits still longer than the 3 s driving window (a person mid-sign-in): the host's own custody reads it before it releases a session on its own. A custom registry's gates implement `viewing()` and `setViewing(on)`; the live view sets it on a viewer's hello and clears it when that viewer leaves or the session is released.

v1 limits: JS dialogs show with accept and dismiss; a file chooser and downloads are not supported; use it on practice sites until the credential guards
of #1000 land (a person's real password typed into a page the model's own code can read).

## How it compares

Our own bench, run by this package's authors with `gpt-6-luna` only, 3 samples per case, against `pi-agent-browser-native`
0.9.3 on the same prompts and model. Five cases are public-registry lookups (two behind walls, where abstaining is the right
answer); three are loopback fixtures. Treat it as ours, not independent.

- Local Chrome, 48 runs: no wrong answers from either; median $0.0013 a run against $0.0024, 6 tool calls against 9, 7 tool
  errors in 180 calls against 85 in 260, and no process left running after a run, against a browser daemon left after each one.
- Browserbase, 30 runs: a tie on outcomes (5 correct, 10 abstentions, 0 wrong for each). This package's median was $0.0034 a
  run against $0.0046, with more tool calls on the walled cases (16 against 12).
- A crash in the middle of a form submit is covered by neither: with a scripted model both submitted twice, and a resumed
  model that was not told about the cut call repeated the submit in 0 of 10 runs for each.
- Much of the other arm's tool-error count is how luna calls that tool, not the extension. Another model may give other numbers.

## Development

```sh
npm run build -w @parcha/pi-browser
npm test -w @parcha/pi-browser               # everything but the real-Chrome suites
CHROME_PATH=/path/to/chrome npm run test:chrome -w @parcha/pi-browser
```

The real-Chrome suites (`stagehand_real_chrome`, `cdp_local_chrome`, `effects-chrome`, `coding_agent_real_chrome`,
`readme_example`) skip with a typed reason where no Chrome can load Stagehand's extension, and fail instead under
`AGENTRUN_REQUIRE_LOCAL_CHROME=1`, which CI sets. The crash matrix (`test/custody.test.mjs`) SIGKILLs a child process at each
cut point of a session's life against the shared fake and reopens the run's SQLite file. The wire checks (`test/wire/`) plant
sentinel credentials in a fake provider and scan every byte a run produced. The suites run on Node 22 and 24.

Apache-2.0. Copyright 2026 Parcha Labs, Inc. `NOTICE` records the Stagehand (MIT) code this package copies: the Chrome launch
flags and the vendored facade.
