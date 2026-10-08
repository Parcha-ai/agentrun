# @agentrun/pi-browser

A browser for pi agents that keeps its promises across crashes. Not yet published; it lives in the agentrun-harness repo.
Node `^22.19.0 || ^24.0.0`, pi 1.0.x.

The design: custody recorded before every provider call and released by a durable task,
reads that rerun after a crash and actions that never do, evidence filed with its SHA-256, failures classified from
typed facts, and no credential in anything the model, a document or a log can see.

## What is in it

- `@agentrun/pi-browser`: the host-neutral core. The model contract (tool names, descriptions, JSON schemas, effect
  and replay classes, the static `browser` and `web` sections), the typed failure envelope, the redactor, the
  screenshot budget, the repeat guard, evidence and decision-hook types, usage and prices, `find` (chunking and
  ranking a long page), `browser_downloads` and the opt-in request observer, and the provider interface. Imports
  nothing outside Node's builtins.
- `@agentrun/pi-browser/durable`: the pi-durable adapter. `createBrowserExtension` is session custody in the run's
  own store (a create committed before the provider is called, release as a durable task, reconcile at run open);
  `createWebExtension` is `web_fetch` and `web_search`.
- `@agentrun/pi-browser/coding-agent`: the pi coding agent's extension, "For pi users" below. This is what `pi install` loads.
- `@agentrun/pi-browser/driver/stagehand`: `stagehandDriver()`, Stagehand v4 over upstream's facade, vendored
  unedited in `src/vendor/stagehand-facade/` (`UPSTREAM.json` names the commit and each file's blob id and SHA-256;
  `node scripts/vendor-facade.mjs --check` verifies, `--commit SHA --release NAME` re-vendors). Stagehand is created sealed: no inference, no cache, its trace
  exporter pointed at a closed loopback port.
- `@agentrun/pi-browser/providers/browserbase`, `/providers/kernel` and `/providers/cdp`: where browsers come from.
  Browserbase through its SDK, with the credential-proxy dial and the connect-URL rewrite; Kernel through its REST API
  (no Kernel SDK), on the package's own HTTP agent; any CDP endpoint, or a local Chrome the provider starts and kills by
  exact pid.
- `@agentrun/pi-browser/testing`: the shared test fake. A fake provider backend with a ledger of every call, a
  credential broker, an HTTP face so the ledger outlives a killed child process, a driver over in-memory pages, and a
  set of sentinel credentials. A host's composition test and this package's crash matrix use the same one.

`@earendil-works/pi-coding-agent`, `@earendil-works/pi-durable` (only for `/durable`) and `@browserbasehq/sdk` (only for the
Browserbase provider) are optional peers; pi supplies the first. Stagehand, undici and the HTML-to-markdown packages are
dependencies.

## The tools

| Tool | Does | Replay after a crash |
|---|---|---|
| `snapshot` | The page's accessibility tree with bracketed ids: a working view for the next `run`. Never filed, so it is not citable evidence. | Reruns. |
| `screenshot`, `browser_read` | Read the page; each read is filed as evidence with its URL, SHA-256 and the offset into the session's recording. A screenshot is held to 2,000 px on its long edge. | Reruns. A read whose session was lost answers `session_replaced`. |
| `browser_downloads` | Copy what the session downloaded into the host's workspace, with a manifest of SHA-256 sums. Listed only when the host gives a `workspace` and the provider can list downloads. | Reruns; files already there are skipped. |
| `run` | Act: code or a batch of ref actions. | Never reruns; the model is told the call may have taken effect and where the page was, and the identical code is refused once (`effect_unknown`). |
| `browser_release`, `browser_relaunch` | End the session; end it and open another. | Idempotent; a create carries a tag, so a rerun finds its session. |
| `web_fetch`, `web_search` | Fetch a page, search, through the provider's services. | Reruns. |

Cost today: `web_fetch` and `web_search` results carry their price as pi usage (the Browserbase provider's list prices). Session minutes are charged by the session meter (`core/usage.ts`, wired into custody): every session tool's result carries the session's time since its last charge as pi usage, at the host's session price, and a session's release records the rest on its record (`spent`), topped up to the provider's 1-minute minimum and marked final, so a retried release adds nothing. A host that gives no session price gets the seconds and no dollars, recorded unpriced, never free: agentrun's run cost shows those minutes as unknown (`browser_minutes_unpriced`, the run's cost `partial`). The run's cost receipt does not yet add the release's remainder.

Every failure is one envelope: `ok: false`, a `code`, `retryable`, `effect` (`none` or `possibly_effected`) and a
message that says the way out.

## For hosts

A host builds the extensions once per run and passes:

- `driver`: `stagehandDriver()` from `@agentrun/pi-browser/driver/stagehand`; a host may pass its own `DriverFactory`.
- `provider`: Browserbase from the run's env (`BROWSERBASE_API_KEY` or `BB_API_KEY`, and the proxy URLs and project id
  as they are today), with the host's own metadata stamped on every session.
- `evidence`: a sink that files each read where the run's receipts already are, so every reader of a receipt keeps working.
- `onSession`: the host channel. It receives each session's row and, only there, the live-view URLs. Nothing in the
  run log, a result or a log line carries them.
- `decisions`: `classifyPage` and `rankChunks`, answered with the run's judge. Absent, no page is classified and no
  find is ranked.
- `redact.values`: exact strings to scrub besides the built-in shapes.
- `section.addendum`: the host's text after the package's section.
- `workspace`: where `browser_downloads` writes; absent, that tool is not listed.
- `prices`: the host's session price (for example from `BROWSERBASE_USD_PER_MINUTE`). It prices the session meter (each session tool's result and each released session's record); without it the minutes are recorded unpriced.

Per conversation, the host writes a `BrowserConfig` (`label`, `run`, and the policy: proxies, verified, captcha,
geolocation, region, a raw context id, the session timeout, the idle release and the batch timeout) in the
conversation's creating commit, selects the extensions for it, and calls `handle.release(conversation, "close", ctx)`
when the conversation ends. At run open, after the extensions are installed and before anything resumes, it calls
`handle.reconcile(harness, isActive, ctx)`; every session a dead process left is bound, kept, or released. The host
wraps the tools (`handle.tools`) with its own policy: pause, call records, a result cap, media for the route.

A host with its own provider implements `BrowserProvider`: `name`, `caps`, `create` (at most once, the tag stamped on the
provider's side), `findByTag`, `status`, `attach`, `release`, and optionally `liveView`, `recordings`, `downloads`,
`fetch` and `search`.

## For pi users

A browser for the pi coding agent: `snapshot`, `run`, `screenshot`, `browser_read`, `browser_relaunch`, `browser_release`,
and `web_fetch` (plus `web_search` when the provider offers one). The agent opens a Chrome of its own on first use, reads
and drives pages through Stagehand, files every page it reads and every screenshot with the page's URL and a SHA-256, and
closes the Chrome when you release it, when it has been idle for three minutes, or when the session ends.

```sh
pi install npm:@agentrun/pi-browser     # once published; until then: pi install ./packages/pi-browser after a build
```

The local browser needs a Chrome or Chromium: the one named by `--browser-chrome` or `PI_BROWSER_CHROME`, else `CHROME_PATH`,
else the first of `google-chrome`, `chromium` and the usual install locations (`/opt/google/chrome/chrome`, Chrome in
`/Applications`, Chrome in `Program Files`). It is tested on Linux; macOS and Windows are not yet verified. Nothing starts until the model's first browser call.

| Setting | Meaning |
|---|---|
| `--browser-chrome PATH`, `PI_BROWSER_CHROME` | The Chrome to start. A path that does not exist is refused by name, never replaced. |
| `--browser-headed`, `PI_BROWSER_HEADED=1` | Show the window instead of running headless. |
| `--browser-no-sandbox`, `PI_BROWSER_NO_SANDBOX=1` | Start Chrome without its sandbox. Needed as root, in a container, or on a system that restricts user namespaces; use it only for pages you trust. |
| `--browser-endpoint URL`, `PI_BROWSER_ENDPOINT` | Attach to a Chrome you already run (`http://host:port` or `ws://`) instead of starting one. Releasing leaves it running. |
| `--browser-provider browserbase`, `PI_BROWSER_PROVIDER` | Use Browserbase. Needs `BROWSERBASE_API_KEY`; a missing key is refused by name. `BB_API_KEY` is accepted in its place. `PI_BROWSER_PROXIES=1` turns on its proxies. |
| `--browser-provider kernel`, `PI_BROWSER_PROVIDER` | Use Kernel. Needs `KERNEL_API_KEY`; a missing key is refused by name. `KERNEL_BASE_URL` points at another Kernel API. `PI_BROWSER_STEALTH=1` turns on Kernel's stealth mode (its CAPTCHA solver and stealth proxy). |

What it does about your machine and your data:

- The Chrome it starts has its own profile directory under a temporary root and a free debugging port, never your browser's
  profile and never port 9222. The profile is deleted when the browser is released.
- Pages and screenshots are filed under `<project>/.pi/browser/evidence/`, each as a receipt (`tool`, `args`, `status`, the
  page's final URL and title, `sha256`, then the body). A credential-shaped query parameter in a URL, a Bearer value and a
  key of the shapes Stagehand knows are replaced by `[redacted]` before anything is filed, shown to the model or stored.
- Each browser session is appended to the pi session file (`browser.session` entries; the model never sees them). The
  coding agent has no mid-turn resume, so a resumed session gets a fresh browser: cookies and page state are not carried
  over. A Chrome that a crashed pi left running is closed when that session is next started, never adopted.
- Without a fetch service, `web_fetch` reads public hosts only (it refuses loopback, private and link-local addresses at
  every redirect hop, over 5 MiB, and non-text), with no cookies or credentials.
- A PDF the fetch service will not convert to markdown (Browserbase answers HTTP 400) is fetched once more as the raw file.
  The coding agent has no PDF text extractor, so `web_fetch` says the URL is a PDF and that `format: "raw"` returns its bytes,
  base64-encoded. A host with an extractor passes `pdf: { text(bytes, url, signal) }` to `createWebExtension`: the text it
  returns is answered and filed as the page (`extractor: pdf-text`, judged by `classifyPage` like any page). A PDF over
  32 MiB is not handed to it, and it gets 120 s (`maxBytes`, `timeoutMs`); a PDF with no text says so.
- Stagehand's trace export is pointed at a closed loopback port, so nothing you browse is sent to a third party.
- `browser_relaunch` with `verified` or `geolocation` changes nothing on a local Chrome or on Kernel (they are Browserbase
  features).
- On Kernel, each session is tagged with its run and lease tag (found again by tag after a crash) and created with an idle
  timeout equal to the idle release (three minutes), so a browser nobody is connected to is ended by Kernel itself if pi dies;
  a release deletes it and waits until Kernel shows it gone. Stagehand's extension must be stored in your Kernel project: a
  stored extension with the same bytes (Kernel's checksum) is used whatever its name, and never changed; otherwise the first
  session uploads it once as `agentrun-stagehand-<sha256 prefix>`. A plan with no room for it fails the launch naming
  `insufficient_plan`. Kernel's live view is not offered:
  its API has no read-only form of it. Kernel calls go direct, never through `HTTP(S)_PROXY`, as Browserbase's do; a host
  behind a proxy passes its own `fetch` to `kernelProvider`.

Limits: a crash loses the in-flight turn and the browser with it; a `pi install` pulls Stagehand (about 40 MB and 52 packages
with its dependencies).

### In your own pi-durable Harness

Inside this repository, any pi-durable `Harness` can install the extensions; a local Chrome is the default provider and
costs nothing:

```js
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createBrowserExtension } from "@agentrun/pi-browser/durable";
import { stagehandDriver } from "@agentrun/pi-browser/driver/stagehand";
import { cdpProvider } from "@agentrun/pi-browser/providers/cdp";

const provider = cdpProvider({ chrome: { executablePath: "/usr/bin/google-chrome", profileRoot: "/tmp/browser-profiles" } });
const browser = createBrowserExtension({
  provider: () => provider,
  driver: stagehandDriver(),
  evidence: { file: async (label, record) => /* write record.body somewhere; return { path } or null */ null },
});
const registry = createRegistry();
registry.install(browser.extension);          // before the Harness resumes anything
const harness = await Harness.open(storage, { models, registry }, context);
// `isActive` says whether a conversation will continue in this process; a session of one that will not is released.
// Here every conversation resumes, so none is released; a host that ends conversations at exit passes its own check.
await browser.reconcile(harness, () => true, context);   // settles what a dead process left
// a conversation selects the extension and writes its BrowserConfig in its creating commit (`browser.docs.Config`);
// when it ends, `await browser.release(conversation, "close", context)`.
```

Needs Chrome, Node 22.19 or later and `@earendil-works/pi-durable` (an optional peer; Stagehand is a dependency).
`createBrowserExtension` takes no key and sends nothing anywhere but the provider you give it. A published package is
later work.

## How it compares

Our own bench, run by this package's authors with `gpt-6-luna` only, 3 samples per case, against `pi-agent-browser-native` 0.9.3
on the same prompts and the same model. Five of the cases are public-registry lookups (two of them behind walls where
abstaining is the right answer); three are loopback fixtures. Treat it as ours, not independent.

- Local Chrome, 48 runs: no wrong answers from either; median $0.0013 a run against $0.0024, 6 tool calls against 9, 7 tool
  errors in 180 calls against 85 in 260, and no process left running after a run against a browser daemon left after each one.
- Browserbase, 30 runs: a tie on outcomes (5 correct, 10 abstentions, 0 wrong for each); this package's median was $0.0034 a run
  against $0.0046 but took more tool calls on the walled cases (16 against 12).
- A crash in the middle of a form submit is not covered by either: with a scripted model both submitted twice, and a resumed
  model that was not told about the cut call repeated the submit in 0 of 10 runs for each.
- Much of the other arm's tool-error count is how luna calls that tool, not the extension. Another model may give other numbers.

## Tests

```sh
npm run build -w @agentrun/pi-browser
node --test packages/pi-browser/test/*.test.mjs packages/pi-browser/test/wire/*.test.mjs
```

The real-Chrome suites (`stagehand_real_chrome`, `cdp_local_chrome`, `effects-chrome`, `coding_agent_real_chrome`) skip with a typed reason where no
Chrome can load Stagehand's extension, and fail instead under `AGENTRUN_REQUIRE_LOCAL_CHROME=1`, which CI sets. The crash matrix (`test/custody.test.mjs`) SIGKILLs a child process at each cut point of a session's life against the
shared fake and reopens the run's SQLite file. The package wire checks (`test/wire/`) plant sentinel credentials in a
fake provider and scan every byte a run produced. The suites run on Node 22 and 24.

Apache-2.0. Copyright 2026 Parcha Labs, Inc. `NOTICE` records the Stagehand (MIT) code this package copies: the Chrome launch
flags and the vendored facade.
