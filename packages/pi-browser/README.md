# @parcha/pi-browser

Your agent gets its own browser, and you can take over and hand it back.

- **Its own browser.** The agent drives a Chrome of its own: a local Chrome, Browserbase or Kernel. It reads pages, clicks, types and takes screenshots. A local Chrome needs no key.
- **You can take over and hand it back.** A host mounts the live view in a few lines, and then a person sees the agent's page, uses the mouse and keys, and lets the agent go on. While the person is driving, the agent's browser calls are refused. The agent can also ask a person for a step only a person can do, and wait for the answer. See [Take over and hand back](#take-over-and-hand-back). For now, use the live view with test accounts on practice sites only: the model's own page code can read what a person types there.
- **Credentials you register stay out of what the model sees.** Credentials you register, and keys of the common shapes, are replaced with `[redacted]` in every tool result, failure, filed page and log. See [Credentials](#credentials).
- **Every page the agent reads is filed as evidence.** The file holds the page's URL, its title and its SHA-256.
- **Bot walls get a name, and failures get a code.** A CAPTCHA, a login wall, a paywall or a region block is named, with a next step, when you give the package a page judge. Every failure is one envelope with one of 15 codes. See [Failures](#failures).

If the process dies, a pi-durable host recovers the session and does not repeat an action. See [For hosts](#for-hosts).

Part of [AgentRun](https://github.com/Parcha-ai/agentrun). Node `>=22.19.0`, pi 1.5.0 exactly (its
pi-durable and chord peers). ESM only: the
package has `import` entries and no `require` entry.

## Install

```sh
npm install @parcha/pi-browser@latest       # the library: providers, driver, durable adapter
npm install @parcha/pi-browser@latest @earendil-works/pi-durable@1.5.0 @earendil-works/chord@1.5.0 @earendil-works/pi-ai@1.5.0   # a pi-durable host: its peers, pinned to 1.5.0
```

## Quick start

A local Chrome, one page, one snapshot. It needs Chrome or Chromium; `CHROME_PATH` names it. As root or in a container, Chrome cannot start its sandbox: set `PI_BROWSER_NO_SANDBOX=1`, or pass `sandbox: false` beside `executablePath`, and run the container with `--init`, or a Chrome killed on cleanup stays a zombie.

```js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpProvider } from "@parcha/pi-browser/providers/cdp";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";

const profileRoot = await mkdtemp(join(tmpdir(), "pi-browser-"));
const provider = cdpProvider({ chrome: { executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", profileRoot } });
const signal = AbortSignal.timeout(60_000);
let session;
try {
  session = await provider.create({ tag: "quick-start", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, signal);
  const driver = await stagehandDriver()(await provider.attach(session), signal);
  await driver.run({ code: `await page.goto(${JSON.stringify(process.argv[2] ?? "https://example.com")})` });
  console.log(await driver.snapshot());
  await driver.close();
} finally {
  if (session) await provider.release(session);
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

## Providers

The same tools run on three kinds of browser. You pick one when you set up the package.

| Provider | What it is | What it needs |
|---|---|---|
| Local Chrome (`/providers/cdp`) | A Chrome the package starts and stops by exact pid, with its own profile directory and a free debugging port. It can also attach to a Chrome you already run, at a CDP endpoint. | Chrome or Chromium 137 or later. No key. |
| Browserbase (`/providers/browserbase`) | A Browserbase session, through its SDK. | `BROWSERBASE_API_KEY` and the `@browserbasehq/sdk` peer. |
| Kernel (`/providers/kernel`) | A Kernel browser, through its REST API. | `KERNEL_API_KEY`. No SDK. |

The local Chrome's options, in `cdpProvider({ chrome: { ... } })`:

| Option | Meaning |
|---|---|
| `executablePath`, `profileRoot` | The Chrome to start, and the directory its profiles live under. Both are required. |
| `headless` | `true` by default; `false` shows the window. |
| `args` | Extra Chrome flags, added after the package's own. |
| `sandbox` | Chrome's own sandbox, on unless `false`. When absent, `PI_BROWSER_NO_SANDBOX=1` turns it off. Turn it off only where Chrome cannot start its sandbox (root, a container, restricted user namespaces), and only for pages you trust. A Chrome that exits before it opens its debugging port fails the create with its last lines of stderr, and with this hint when it aborted or named the sandbox. |

A host passes the provider it wants; see [For hosts](#for-hosts). `examples/one-script-three-providers.mjs` runs one script on all three.

## Take over and hand back

A person and the agent never drive the browser together. There are two ways for a person to come in.

**The person drives, from a live view.** The live view shows the session's page and sends the person's mouse, keys, paste, address bar, back and reload to it. While a person has driven within the last 3 seconds, every browser call from the agent is refused before it does anything (`refused`, `person_driving`, and it can be retried). While an agent call runs, the person's input is discarded with a notice. A call that waited while the person used the browser is told that the page may have changed, and the agent takes a snapshot before it acts.

**The agent asks for a person.** The tool `browser_request_handoff` takes an instruction (what the person should do) and a completion condition (what the page shows when it is done). It waits until the person finishes, cancels or the request expires. While the person has the browser, every other browser call answers `waiting_for_human`. Afterwards the agent takes a snapshot and checks the condition on the page. The tool is listed only when the host gives a `HandoffPort`, which is how the host reaches the person.

**The limit.** The credential guards are not in this release. Until they ship, use the live view with test accounts on practice sites only. The model's own page code can read what a person types there.

What a host wires:

- **The live view of a local Chrome:** `createLiveView` and `liveViewProvider`.
- **The live-view URL of a Browserbase or Kernel session:** handed to the host only, through `onSession` or the handoff port.
- **`browser_request_handoff`:** listed when the host passes a `handoff` port.

### The live view of your own Chrome

`@parcha/pi-browser/live-view` serves a canvas of the session's active page, and the person's mouse, keys, paste, address bar, back and reload go to it. It works for the local Chrome (the cdp provider). Browserbase and Kernel give a host a live-view URL of their own.

```ts
import { createLiveView, liveViewProvider } from "@parcha/pi-browser/live-view";
import { cdpProvider } from "@parcha/pi-browser/providers/cdp";

const liveView = createLiveView({
  hostOrigin: "https://app.example",              // the one origin that may frame the viewer (null: none)
  baseUrl: "https://app.example/live/run-123",    // where you mount it; omit it and the live view serves itself on 127.0.0.1
});
server.on("request", (req, res) => { if (!liveView.handle(req, res)) next(req, res); });
server.on("upgrade", (req, socket, head) => { if (!liveView.upgrade(req, socket, head)) socket.destroy(); });

const provider = liveViewProvider(cdpProvider({ chrome }), liveView);
createBrowserExtension({ provider: () => provider, onSession: (row) => { /* row.liveView.fullscreen is the viewer's URL */ }, ... });
```

The URL is a full-control credential and goes to `onSession` only (never a result, a record or the model): `https://.../live/run-123/v/<id>#t=<token>`. The
token is 256 random bits in the fragment, so it reaches no server log, proxy or Referer; the viewer's script sends it as the WebSocket's first message and
nothing is accepted before it. The upgrade's `Origin` must be the viewer's own origin (behind a proxy, pass the upgrade through with `Origin` intact).
There is one authenticated viewer per session (a second is refused `viewer_in_use`); the token, the stream and the viewer's socket end at the session's release.
The page is served with `Referrer-Policy: no-referrer`, `default-src 'self'` and `frame-ancestors` set to `hostOrigin`. The viewer may send a page only to
http(s) addresses. Frames are held one at a time and acknowledged after they were sent; none is written anywhere.

Every browser tool is a model call on its session's gate (`drivingGates`, shared by default between the live view and the toolset, so you pass nothing). To use your own
registry, pass the same one to both sides: `const gates = createDrivingGates({ idleMs: 5_000 }); createLiveView({ hostOrigin, gates }); createBrowserExtension({ ..., gates });`.

`drivingGates(tag).viewing()` is true for as long as an authenticated viewer is connected to that session, even when the person sits still longer than the 3 s driving window (a person mid-sign-in): the host's own custody reads it before it releases a session on its own. A custom registry's gates implement `viewing()` and `setViewing(on)`; the live view sets it on a viewer's hello and clears it when that viewer leaves or the session is released.

`readOnly: true` makes the view watch-only: every input, navigation and dialog answer a viewer sends is dropped on the server, before the browser (`held read_only`, and
one that keeps sending is closed), its `ready` carries `readOnly: true` and the page shows "view only" with its controls off; a watching viewer never sets `viewing`, so it
keeps no session open. A browser with no page to show (a headless one that starts with none, or whose last page closed) sends `no_page`, and the page says "No page yet"
until one opens.

`takeOver: { take(tag) }` makes the view drive only once the person takes the browser. The page shows **Take over** and **Hand back** in its own bar and sends `take`
and `give`; outside a hold every input, navigation and dialog answer is dropped on the server (`held not_taken`). A `take` asks the host's `take(tag)` first, which may
refuse in its own words (a spend cap with no room for the person's time; the viewer shows `take_refused` with them), or answers `{ end(why), started?(), cancel?() }` (`started` as the hold goes live, `cancel` instead of `end` when no hold starts after all: the session released, the viewer gone, or the browser held already, which the viewer is told as `take_refused`); the session's gate then
holds the browser for the person (`drivingGates(tag).take()`) until their `give`, `holdIdleMs` with no input (15 minutes), `holdAwayMs` with no viewer connected
(2 minutes), or the session's release, and `end` is called once with why (`given`, `answered`, `cap`, `idle`, `away`, `released`). A host gives the
browser back at its spend cap with `drivingGates(tag).give("cap", words)`: the viewer's `hold` end carries the words as `message`. The viewer is told `hold` as it starts
and ends; `ready` carries `takeOver: true` and whether it holds now, so a viewer that reconnects within the away window still holds it. While held, every model call
waits inside its tool (it does not fail; an abort ends the wait with nothing done), and past the hold's end until the person's last command has returned (a Back
between reading the history and moving; at most `settleMs`, 10 s, after which that command is let go and moves nothing more), then goes on with its old element ids dropped and told plainly that the person had
the browser and the page may have changed. Its result's `details` then say how long it waited (`waited_for_person_ms`), so a timeline shows the call waited for the
person rather than acting while they had the browser; a call stopped while it waits did nothing and carries none. Each change of hands moves the gate's epoch (`drivingGates(tag).epoch()`), and a driver a call took before it is refused at
its next act (a `FenceRefusal`), so an agent action from before the person took over never reaches the page: a `run` of
several actions has all of them checked against the snapshot first (`checkActions`: a stale id anywhere sends none), then is
sent one action at a time, each checked against the epoch. One stopped partway (a take, or a later action failing) says
`effect: "partial"` with `completed`, how many ran. An act already sent (a `run`'s code is one batch inside
the browser, out of reach once sent) ends first: a take while a model call runs is held at once, no call starts, and the
hold goes live (`holding()`, the viewer's `hold`, the person's input taken) once that call returns. A host gives the browser back itself with
`drivingGates(tag).give("answered")` (an agent's handoff that was answered). A watching take-over viewer keeps no session from its idle release; a held one is kept by
its hold. `viewerAssets` (from `@parcha/pi-browser/live-view`) are the viewer's page, script and style, for a host that serves the page from its own origin and
passes only the WebSocket to the live view.

Limits: JS dialogs show with accept and dismiss. A file chooser and downloads are not supported.

## Saved sign-ins

This section says where a profile's state lives. A host can ask for a browser profile by name, and say whether the session keeps what it learns. The host sets it in the session policy (`profile: { name, save }`). A name is 1 to 64 letters, digits, dots, dashes and underscores, and starts with a letter or a digit. A session that names a profile starts from the cookies and logins that profile holds. A provider that cannot keep a profile refuses the request by name, and no session starts.

Where the profile lives:

- **Local Chrome:** a directory `.profiles/<name>` under the profile root you give the provider. A session that saves runs on that directory. A session that does not save runs on a copy, and the profile stays as it was.
- **Browserbase:** a Browserbase context. The provider keeps the map from profile name to context id in a file under the user's config directory, or in the store you pass.
- **Kernel:** a Kernel profile of that name, created if it is not there.

It is never your own browser's profile.

One session at a time may save to a profile in one process. A second saver is refused, and the message says why. Across processes, the last session to end wins. A profile name and a raw Browserbase context id cannot be asked for together.


## The tools

| Tool | Does | Replay after a crash |
|---|---|---|
| `snapshot` | The page's accessibility tree with bracketed ids: a working view for the next `run`. Never filed, so it is not citable evidence. | Reruns. |
| `screenshot`, `browser_read` | Read the page. Each read is filed as evidence with its URL, SHA-256 and the offset into the session's recording. A screenshot is held to 2,000 px on its long edge. A `screenshot` can take a `clip` (CSS pixels from the viewport's top-left corner), an `id` from the latest snapshot or a CSS `selector` (scrolled into view first) to capture one region (a blank `id` or `selector`, or a clip of zero width and height, counts as not given); an empty or off-screen region, or an element that matches nothing or more than one, is refused with the typed envelope before any capture. Its `details.media` gives the image's path, type, size and the region. | Reruns. A read whose session was lost answers `session_replaced`. |
| `browser_downloads` | Copy what the session downloaded into the host's workspace, with a manifest of SHA-256 sums. The durable adapter lists it only when the host supplies `workspace`. | Reruns; files already there are skipped. |
| `run` | Act: code, or a batch of ref actions. | Never reruns. The model is told the call may have taken effect and where the page was, and the identical code is refused once (`effect_unknown`). |
| `browser_release`, `browser_relaunch` | End the session; end it and open another. | Idempotent. A create carries a tag, so a rerun finds its session. |
| `browser_request_handoff` | Hand the session to a person for a step only a human can do, and wait for the host's handoff port to say how it ended. While the person has it, every other call answers `waiting_for_human`. Listed only when the host gives a `handoff` port. | Reruns and waits on the same request; a request asked again carries the same `request_id`, which the port treats as one. |
| `web_fetch`, `web_search` | Fetch a page or search, through the provider's services. | Reruns. |
| `browser_upload` | Choose one workspace file in a file input on the page, as a person picking it would. Nothing is submitted; `run` submits the form afterwards. The durable adapter lists it only when the host supplies `files` or `workspace`. | Never reruns. An upload the page does not answer fails at 60 s as possibly applied, and the identical retry is refused until the agent has looked at the page. |
| `use_website` | Hand a task to another agent that works one website the host granted, in its own browser, and get its report. Listed only when the host passes `sites`. | A `request_id` that already finished answers its result without running again. A task that failed runs again. |

`web_search` hits carry a `snippet` when the search has one: an excerpt of the page with its markdown links reduced to
their text, whitespace collapsed and clipped to `WEB_SEARCH_SNIPPET_MAX` (500) characters, redacted with the rest of the
answer. A host's `searchSources` (`createWebExtension`) are tried in order before the provider's own search; one that
throws hands the call to the next, a cancelled call is never handed on, and the answer names the source in `via`. A
source's optional `available()` is asked at each call; one that answers false is skipped without counting as a failure.
`fetchSources` (`FetchSource`) are readers tried the same way before the provider's own fetch, for a markdown read: a
page one answers is filed exactly as the provider's is, under `via: <name>_fetch`, and a reader's failure never becomes
the call's own while the provider can still be tried.

`web_fetch` and `web_search` results carry their price as pi usage (the Browserbase provider's list prices; a search
source's answer at the usage it reports, else the list search price). Session
minutes are charged by the session meter (`core/usage.ts`, wired into custody): every session tool's result carries the
time since the last charge, and each released session's record carries its total. A host that books session time as spend
passes `onCharge` (below), which hears each charge in the commit that bills it.


## Failures

Every failure is one envelope: `ok: false`, a `code`, `retryable`, `effect` (`none` or `possibly_effected`) and a message that names the way out. A `detail` of at most 2,000 characters may follow, redacted. The code comes from typed facts (a status, a class name, a cause code), never from the text of a message. There are 15 codes.

| Code | Means |
|---|---|
| `browser_unavailable` | The browser or its provider could not be reached. |
| `auth` | The provider refused the key (401) or the kind of session (403). |
| `timeout` | The call ran past its deadline. |
| `aborted` | The run cancelled the call. |
| `refused` | The package declined before it did anything: a bad argument, a person driving, a profile that cannot be used, an identical call that has already failed several times, or no person to hand to. |
| `stale_snapshot` | The snapshot id is stale, the page moved on since the snapshot, or a person used the browser meanwhile. Take a new snapshot. |
| `session_ended` | The provider closed the session, or the browser died. The next call opens a fresh one. |
| `session_replaced` | A call that reran after an interruption lost its session, so its page is gone. |
| `effect_unknown` | An action may have taken effect before an interruption. The identical code is refused once. |
| `code_error` | The code the model sent to `run` threw. |
| `command_failed` | A read failed. |
| `not_content` | The page is not content: a login wall, a paywall, a consent notice, an error page, a loading page, an empty page, or a fresh browser that has loaded no page. |
| `blocked` | A CAPTCHA or bot check, a region block, or a fetch the site refused (HTTP 401, 403, 451 or 999). |
| `rate_limited` | The site or the provider answered 429. |
| `waiting_for_human` | A person has the browser. |

**Walls.** Naming a wall takes a judge. A host passes `decisions.classifyPage`, which gets the page's URL, status, content type and text, and answers one of eight classes: `captcha_or_bot_check`, `login_wall`, `paywall`, `region_or_geo_block`, `consent_interstitial`, `error_or_not_found`, `loading_or_js_required` or `empty_or_template`. A bot check or a region block files as `blocked`, and the others as `not_content`, each with a next step. With no judge, no page is classified. A fetch the site refuses with 401, 403, 451 or 999 still answers `blocked`.

A host with a typed-question judge (Jev's `createJevRunner`, or the DSL's `runJudge`) builds the method with `createPageClassifier({ judge, budget?, maxPages?, redact? })`. `judge` is read on each page and must return a `PageJudge`; the page takes one request, which asks for its wall and for the probability that it carries instructions addressed to an AI reader. Its `injection` decision is marked at `INJECTION_THRESHOLD`. A side counts at `PAGE_WALL_THRESHOLD` (0.6). The run's page budget (`pageBudget`, `PAGE_GUARD_MAX_PAGES` pages by default) bounds how many pages are judged. An aborted page, a spent budget, and a judge that throws or answers in the wrong shape (a probability outside 0 to 1 included) each leave the page `unjudged` with no score. An answer where neither side reaches 0.6 leaves it `unjudged` and keeps its injection score: a page at or over `INJECTION_THRESHOLD` is withheld from a search's snippets and marked as an injection on a read, whatever its wall. Each records the reason in its `guard` record. The method never rejects.

## Credentials

What the package does with the credentials you register and the keys it recognises, so they stay out of the model's view, a log and a filed page:

- **Registered values.** A host registers the exact strings to scrub (`redact.values`; at least 8 characters). Each is replaced with `[redacted]` in the raw, URL-encoded and fetch-sent spellings.
- **Known shapes.** A query parameter named `signingKey`, `api_key`, `token`, `access_token`, `key`, `jwt` or `signature`, an OpenAI-style `sk-` key, a Browserbase `bb_live_` or `bb_test_` key, a Google `AIza` key and a `Bearer` value are replaced the same way.
- **Page URLs.** Every query value is replaced (the names stay), and the fragment and the userinfo are dropped, before a URL is shown or filed.
- **Where it runs.** The redactor runs over tool results, failure messages and details, the repeat guard's text, download reasons and the inputs to a page judge. It runs before any text is cut, filed or shown.
- **The live view's address** is a full-control credential. It goes to the host's `onSession` and the handoff port, and nowhere else.
- **Browserbase.** The provider dials Browserbase through a bound credential proxy, not the raw connect URL.
- **Tested.** The wire tests (`test/wire/`) plant sentinel credentials in a fake provider and scan every byte a run produced: the run's entries and database, every request to the model, its reports, its evidence files and its process log. They look for each value raw, URL-encoded, hex- and base64-encoded, and for its head and tail.

What this does not cover: a value nobody registered and no shape matches, and what a person types into a page. See the limit under [Take over and hand back](#take-over-and-hand-back).

## Peers

Stagehand, undici, zod and the two HTML packages are dependencies. Three optional peers cover the rest. Install only the ones you use:

| Peer | Needed for |
|---|---|
| `@earendil-works/pi-durable` and `@earendil-works/chord` | `/durable`, the adapter for a pi-durable Harness. |
| `@browserbasehq/sdk` | the Browserbase provider. Kernel needs no SDK. |

The pi peers are `@earendil-works/pi-durable` and `chord` `1.5.0` exactly. CI tests pi 1.5.0.

## Entries

- `@parcha/pi-browser`: the host-neutral core. The model contract (tool names, descriptions, JSON schemas, effect and
  replay classes, the `browser` and `web` prompt sections), the typed failure envelope, the redactor, the screenshot
  budget, the repeat guard, evidence and decision-hook types, usage and prices, `find` (chunking and ranking a long page),
  `browser_downloads`, the opt-in request observer, and the provider interface. The public-host guard is here too: `publicFetch(url, { lookup?, fetchImpl?, signal?, maxBytes? })` and
  `readPage(html, url, { deadlineMs?, signal? })`, with `isPrivateAddress` and `pinnedLookup`. `readPage` never holds
  the event loop: it drops a page's script, style, svg, noscript and template blocks, cuts what is left at
  `READ_MAX_CHARS` (`truncated`, with the page's length in `html_chars`), and converts it to markdown in a worker thread
  within `READ_DEADLINE_MS`, falling back to the page's plain text (`converted: "text"`). `browser_read`'s markdown goes
  the same way (of the page's first article, else main, else body, with the browser's own text as its fallback), and
  its frame scan reads the page's first 2,000,000 characters in steps that yield the loop. Outside Node's builtins and
  undici it loads only node-html-parser and node-html-markdown, on demand and in that worker thread.
- `/durable`: the pi-durable adapter. `createBrowserExtension` is session custody in the run's own store (a create is
  committed before the provider is called, release is a durable task, reconcile runs at run open). `createWebExtension` is
  `web_fetch` and `web_search`.
- `/driver/stagehand`: `stagehandDriver()`, Stagehand v4 over upstream's facade, vendored unedited in
  `src/vendor/stagehand-facade/`. `UPSTREAM.json` names the commit and each file's blob id and SHA-256;
  `node scripts/vendor-facade.mjs --check` verifies them and `--commit SHA --release NAME` re-vendors. Stagehand is created
  sealed: no inference, no cache, and no trace endpoint, so no trace is exported. Stagehand attaches one client to a browser
  at a time: closing a driver disconnects it, so the next attach is allowed.
- `/providers/browserbase`, `/providers/kernel`, `/providers/cdp`: where browsers come from. Browserbase through its SDK,
  with the credential-proxy dial and the connect-URL rewrite. Kernel through its REST API on the package's own HTTP agent.
  Any CDP endpoint, or a local Chrome the provider starts and kills by exact pid.
- `/providers/chrome-args`: `chromeArgs()`, the arguments the cdp provider starts a local Chrome with, and `extensionOrigin()`,
  the one Origin its DevTools socket allows (Stagehand's extension). A host that starts its own Chrome for Stagehand takes them
  from here rather than copying Stagehand's `--remote-allow-origins=*`. `findChrome()` finds the Chrome to start: the one
  `PI_BROWSER_CHROME` or `CHROME_PATH` names, else `google-chrome` or `chromium` on the PATH, else the usual install locations.
- `/live-view`: a person sees and drives the local Chrome (the cdp provider) from your page, with nothing leaving the machine but the model. See
  [The live view of your own Chrome](#the-live-view-of-your-own-chrome).
- `/testing`: the shared test fake. A provider backend with a ledger of every call, a credential broker, an HTTP face so the
  ledger outlives a killed child process, a driver over in-memory pages, and sentinel credentials. A host's composition
  test and this package's crash matrix use the same one.

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
- `signIns`: `true` when the plane's sessions open on the agent's saved sign-ins (your kept profile or context). `run`'s
  description then tells the model the browser keeps them, for a page behind a sign-in; without it, it says only that the
  browser keeps cookies across pages. Absent, it is whether a `sessionVault` is given.
- `workspace`: where `browser_downloads` writes, and where `browser_upload` reads when `files` is absent. Absent, `browser_downloads` is not listed, and `browser_upload` is listed only if `files` is given.
- `files`: a `WorkspaceFiles` that resolves `browser_upload` paths. Given, `browser_upload` is listed without a `workspace`.
- `handoff`: a `HandoffPort` that reaches a person (`request`, then `outcome` polled until done, cancelled or expired;
  when a request expires is the port's to decide). Absent, `browser_request_handoff` is not listed.
- `prices`: your session price (for example from `BROWSERBASE_USD_PER_MINUTE`). It prices the session meter, so each session
  tool's result and each released session's record carry dollars. Without it the minutes are recorded unpriced.
- `onCharge(charge, tx, call?)`: each charge of a session's time, `{ conversationId, tag, provider, at, seconds, usd,
  final, state }`, called in the commit that writes it on the session's record, so a host that books it in `tx` books
  exactly what the record bills: at a browser call (`call.callId`), what the session ran since its last charge; at its
  release, or when custody gives up releasing it (`lost`) (`final`), the rest, topped up to `prices.sessionMinimumS`. A session already billed in full is never charged
  again. `state` is `priced`, or `unpriced`/`invalid` with `usd` 0 (no price, not $0). It must not throw: a throw fails the
  commit, and a call's charge is then carried by the session's next one.

Per conversation, the host writes a `BrowserConfig` (`label`, `run`, and the policy: proxies, verified, captcha, geolocation,
region, a raw context id, the session timeout, the idle release and the batch timeout; `DEFAULT_BROWSER_POLICY` holds the
package's defaults to spread and override) in the conversation's creating commit,
selects the extensions for it, and calls `handle.release(conversation, "close", ctx)` when the conversation ends. Releases run
as background tasks, which `waitForIdle` skips and closing the harness aborts: before it closes, a host calls
`handle.drain(harness, ctx, signal?)`, which resolves once none is live. A host that closes with no drain after its `close`
releases gets them at the provider all the same: `handle.close()` waits, 30 s at most, for every one no drain since covered. A release the store cannot record (a storage error)
is still made at the provider, and the record is left for the next run's reconcile; once the store has failed,
`handle.close()` releases every session the process still holds, and over a healthy store it releases nothing. At run open,
after the extensions are installed and
before anything resumes, it calls `handle.reconcile(harness, isActive, ctx)`, and every session a dead process left is bound,
kept or released. A kept session's idle release is armed then, so one no call uses is released an idle window after the
reopen. The host wraps the tools (`handle.tools`) with its own policy: pause, call records, a result cap, media for
the route.

A policy's `navigation` is a restriction the host relies on, so a session that would not hold to it is never started. No
provider enforces a `block` list today, so a policy with one refuses every session. An `allow` list is enforced only by a
provider whose `caps.navigationAllow` is true (Browserbase, through `allowedDomains`); on any other provider the session is
refused. Each refusal names the part of the policy and the provider. Both adapters behave the same.
A provider applies an allow list only when it creates a session, so the durable adapter records it on the session. A live
session used again under a policy whose `allow` list it was not started under (none, or a wider one) is refused the same way,
and `browser_relaunch` starts one under the current policy.

A host with its own provider implements `BrowserProvider`: `name`, `caps`, `create` (at most once, the tag stamped on the
provider's side), `findByTag`, `status`, `attach`, `release`, and optionally `liveView`, `recordings`, `downloads`, `fetch`
and `search`.

Two things to know before you give a model a browser:

- **What a model may reach is your decision.** `web_fetch` takes only absolute `http(s)` URLs with no credentials, and
  `publicFetch` refuses private addresses, but a provider's fetch service and a driven browser go wherever
  their network goes. A host that must not let a model reach internal addresses restricts that network or the URLs it passes.
- **The Browserbase provider changes the process.** Its first call that needs the Browserbase client adds Browserbase's hosts to `NO_PROXY` and `no_proxy`, and
  the first attach replaces `globalThis.WebSocket` with a wrapper that dials a bound credential proxy instead of the raw
  connect URL. Both are process-wide. The wrapper passes every other URL through unchanged. Importing the package does
  neither.

## Development

```sh
npm run build -w @parcha/pi-browser
npm test -w @parcha/pi-browser               # everything but the real-Chrome suites
CHROME_PATH=/path/to/chrome npm run test:chrome -w @parcha/pi-browser
```

The real-Chrome suites (`stagehand_real_chrome`, `cdp_local_chrome`, `effects-chrome`, `screenshot_clip_real_chrome`,
`readme_example`) skip with a typed reason where no Chrome can load Stagehand's extension, and fail instead under
`AGENTRUN_REQUIRE_LOCAL_CHROME=1`, which CI sets. The crash matrix (`test/custody.test.mjs`) SIGKILLs a child process at each
cut point of a session's life against the shared fake and reopens the run's SQLite file. The wire checks (`test/wire/`) plant
sentinel credentials in a fake provider and scan every byte a run produced. The suites run on Node 22 and 24.

Apache-2.0. Copyright 2026 Parcha Labs, Inc. `NOTICE` records the Stagehand (MIT) code this package copies: the Chrome launch
flags and the vendored facade.
