// browser_read on a page too big to read in one pass on the event loop. The host's tools run in the run's own process,
// so a read that holds the loop holds the run's heartbeat too, and the run is fenced: browser_read's markdown parsed and
// converted the live page's whole HTML there, and its frame scan parsed up to 2M characters of it. Each big read here
// runs in a child process, through pageTools' browser_read on a fake session, so a read that holds its own loop cannot
// hold this runner's; the child reports its wall time and the longest its event loop was held (perf_hooks'
// monitorEventLoopDelay), and one that does not answer within GUARD_MS is killed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { pageTools } from "../dist/index.js";

const GUARD_MS = 30_000;
const URL_ = "https://downloads.example/dl/";
const FRAME = '<iframe src="https://challenge.example/check?token=SECRET-FRAME">Checking your browser &amp; connection</iframe>';
const CHILD = `
import { monitorEventLoopDelay } from "node:perf_hooks";
const [dist, fixture, chars, options] = process.argv.slice(1);
const { what, oneTable, tools } = JSON.parse(options);
const { pageTools } = await import(dist);
const { downloadsPage } = await import(fixture);
const page = downloadsPage(Number(chars), { oneTable });
const html = page.html.replace("<main>\\n", "<main>\\n" + ${JSON.stringify(FRAME)} + "\\n");
const text = "All releases. The browser's own text of the page.";
const driver = { url: async () => ${JSON.stringify(URL_)}, page: async () => ({ url: ${JSON.stringify(URL_)}, title: "All releases", text, html }) };
const session = { driver, tag: "ar-run-1-1", sessionId: "sess-1", record: { lastUrl: ${JSON.stringify(URL_)} }, notice: null, interrupted: null, recorded: false, effects: null, downloads: null };
const port = { session: async () => session, dispatching: async () => {}, journal: async () => {}, mark: async () => {}, settle: async () => {}, ended: async () => false, dropped: async () => {} };
const filed = [];
const judged = [];
const call = {
  callId: "c1", conversationId: 1, signal: undefined, label: "node", redact: (value) => value,
  evidence: { file: async (label, record) => { filed.push(record); return { path: "evidence/node/1-browser_read.md", bodyLine: 9 }; } },
  classifyPage: async (seen) => { judged.push({ frames: seen.frames ?? null, frameText: seen.frameText ?? null }); return { wall: "content", injection: null, confidence: 0.9 }; },
};
const held = monitorEventLoopDelay({ resolution: 10 });
held.enable();
const started = performance.now();
const out = await pageTools(tools ?? {}).browser_read({ what }, port, call);
const wallMs = performance.now() - started;
held.disable();
const record = filed[0] ?? null;
process.stdout.write(JSON.stringify({ wallMs, heldMs: held.max / 1e6, htmlChars: html.length, first: page.first, last: page.last, text, isError: out.isError === true, shown: out.content[0].text.slice(0, 400), body: record?.body ?? null, extractor: record?.facts.extractor ?? null, ext: record?.ext ?? null, judged }));
`;

/** browser_read `{ what }` on a generated page of `chars` characters, an iframe first in its main element, in a child
 *  process: `{ hung: true }` when it does not answer within GUARD_MS. `tools`: pageTools' options. */
function inChild(chars, options) {
  return new Promise((resolve, reject) => {
    const args = [new URL("../dist/index.js", import.meta.url).href, new URL("./fixtures/downloads-page.mjs", import.meta.url).href, String(chars), JSON.stringify(options)];
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
    const guard = setTimeout(() => child.kill("SIGKILL"), GUARD_MS);
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      if (signal === "SIGKILL") resolve({ hung: true });
      else if (code !== 0) reject(new Error(`the child exited ${code ?? signal}: ${err.slice(0, 2000)}`));
      else resolve(JSON.parse(out));
    });
  });
}

/** The run answered within GUARD_MS and within `wallMs`, its event loop never held 100 ms, with no failure. */
function quick(run, wallMs) {
  assert.ok(!run.hung, `no answer within ${GUARD_MS / 1000} s`);
  assert.ok(run.wallMs < wallMs, `${Math.round(run.wallMs)} ms, over ${wallMs} ms`);
  assert.ok(run.heldMs < 100, `the event loop was held ${run.heldMs.toFixed(1)} ms`);
  assert.equal(run.isError, false, run.shown);
}
/** A file's row in the markdown table: a table pads each column to its widest cell. */
const row = (name) => new RegExp(`\\| \\[${name.replaceAll(".", "\\.")}\\]\\(/dl/${name.replaceAll(".", "\\.")}\\) +\\| Archive +\\|`);
/** The judge saw the page's one real frame: its origin, and the text inside it. */
const framed = (run) => assert.deepEqual(run.judged, [{ frames: ["https://challenge.example"], frameText: ["Checking your browser & connection"] }]);

test("browser_read's markdown of a 3 MB page of one table answers within 10 s, its event loop never held 100 ms: the main element's markdown, cut, saying so", async () => {
  const run = await inChild(3_000_000, { what: "markdown", oneTable: true });
  quick(run, 10_000);
  assert.deepEqual([run.extractor, run.ext], ["readability-md", "md"]);
  // The iframe first in the main element: node-html-markdown writes its fallback text, as one pass always did.
  assert.match(run.body, /^Checking your browser & connection\s*\n\n# All releases\n/, "the main element's markdown, from its frame and its heading");
  assert.match(run.body, /\| File name +\| Kind +\| OS +\| Arch +\| Size +\| SHA256 Checksum +\|/);
  assert.match(run.body, row(run.first), "the first row, as a markdown table row");
  assert.ok(!run.body.includes(run.last), "the rows past the cut are not read");
  assert.ok(!run.body.includes("Footer"), "the main element only");
  assert.match(run.body, /\n\n\(Cut: the page is 3,\d{3},\d{3} characters of HTML, and only the first 1,000,000 of its main content, scripts and styles aside, were read as markdown\. browser_read with what: "text" gives all of its text\.\)$/);
  framed(run);
});

test("browser_read's markdown past its deadline gives way to the browser's own text, still without holding the event loop", async () => {
  const run = await inChild(3_000_000, { what: "markdown", oneTable: true, tools: { readDeadlineMs: 50 } });
  quick(run, 5_000);
  assert.deepEqual([run.extractor, run.ext, run.body], ["inner-text", "txt", run.text]);
  framed(run);
});

test("browser_read's text of a 3 MB page scans its frames without holding the event loop", async () => {
  const run = await inChild(3_000_000, { what: "text", oneTable: true });
  quick(run, 5_000);
  assert.deepEqual([run.extractor, run.body], ["inner-text", run.text]);
  framed(run);
});

/** browser_read `{ what }` on `html` in this process: the filed record and what the judge saw. */
async function readHere(html, what = "markdown") {
  const driver = { url: async () => URL_, page: async () => ({ url: URL_, title: "Page", text: "inner", html }) };
  const session = { driver, tag: "ar-run-1-1", sessionId: "sess-1", record: { lastUrl: URL_ }, notice: null, interrupted: null, recorded: false, effects: null, downloads: null };
  const port = { session: async () => session, dispatching: async () => {}, journal: async () => {}, mark: async () => {}, settle: async () => {}, ended: async () => false, dropped: async () => {} };
  const filed = [];
  const call = { callId: "c1", conversationId: 1, signal: undefined, label: "node", redact: (value) => value, evidence: { file: async (label, record) => { filed.push(record); return { path: "evidence/node/1-browser_read.md", bodyLine: 9 }; } } };
  const out = await pageTools().browser_read({ what }, port, call);
  assert.equal(out.isError, undefined, out.content[0].text);
  return filed[0];
}

test("browser_read's markdown is of the page's first article, else its main, else its body, else the whole page: never one inside a script or a comment", async () => {
  const chrome = (inner) => `<html><head><title>Page</title></head><body><nav><a href="/">Menu</a></nav><!-- <article><p>commented</p></article> --><script>var s = "<article><p>scripted</p></article>";</script>${inner}<footer>Footer</footer></body></html>`;
  assert.equal((await readHere(chrome("<main><h1>Main</h1><article><h2>Story</h2><p>Body.</p></article></main>"))).body, "## Story\n\nBody.");
  assert.equal((await readHere(chrome("<main><h1>Main</h1><p>Body.</p></main>"))).body, "# Main\n\nBody.");
  assert.equal((await readHere(chrome("<h1>Plain</h1>"))).body, "[Menu](/)\n\n# Plain\n\nFooter");
  assert.equal((await readHere("<h1>Bare</h1><p>No body tag.</p>")).body, "# Bare\n\nNo body tag.");
});

/** browser_read on `html` in this process: what the judge was shown of the page. */
async function judgedHere(html) {
  const driver = { url: async () => URL_, page: async () => ({ url: URL_, title: "Page", text: "", html }) };
  const session = { driver, tag: "ar-run-1-1", sessionId: "sess-1", record: { lastUrl: URL_ }, notice: null, interrupted: null, recorded: false, effects: null, downloads: null };
  const port = { session: async () => session, dispatching: async () => {}, journal: async () => {}, mark: async () => {}, settle: async () => {}, ended: async () => false, dropped: async () => {} };
  const judged = [];
  const call = {
    callId: "c1", conversationId: 1, signal: undefined, label: "node", redact: (value) => value,
    evidence: { file: async () => ({ path: "evidence/node/1-browser_read.md", bodyLine: 9 }) },
    classifyPage: async (seen) => { judged.push(seen); return { wall: "content", injection: null, confidence: 0.9 }; },
  };
  const out = await pageTools().browser_read({ what: "text" }, port, call);
  assert.equal(out.isError, undefined, out.content[0].text);
  assert.equal(judged.length, 1);
  return judged[0];
}

test("browser_read's frames are read from each frame's own src attribute: a \"src=\" inside another attribute's quoted value is that value's text, as a browser reads it", async () => {
  const html = "<html><head><base target=\"_self href='https://wrong-base.example/'\" href=\"https://cdn.example/app/\"></head><body>"
    + "<iframe title=\"Example src='https://docs.example/'\" src=\"https://challenge.example/\"></iframe>"
    + "<iframe alt='say src=\"https://quoted.example/\"'>Only a mention</iframe>"
    + "<iframe data-note=\"x\"src=\"https://tight.example/\"></iframe>"
    + "<iframe data-src=\"https://lazy.example/\" SRC = 'frames/one.html'></iframe>"
    + "<iframe src=\"https://first.example/\" src=\"https://second.example/\"></iframe></body></html>";
  const seen = await judgedHere(html);
  assert.deepEqual(seen.frames, ["https://challenge.example", "https://tight.example", "https://cdn.example", "https://first.example"],
    "each frame's own src, in page order: a quoted mention is no source, an attribute right after a quote counts, the base href is its own, the first of two src holds");
  assert.deepEqual(seen.frameText, ["Only a mention"]);
});

test("the text inside a frame decodes a numeric reference whatever its leading zeroes", async () => {
  const seen = await judgedHere('<html><body><iframe src="https://challenge.example/">&#000000065;ccess &#x00000064;enied&#0000000000000000000000000000000000033;</iframe></body></html>');
  assert.deepEqual(seen.frameText, ["Access denied!"]);
});

test("a frame inside a template is no frame however templates nest: a template inside it does not end it, nor does a \"</template>\" in its script or its comment", async () => {
  const html = '<html><body><template><template></template><iframe src="https://hidden.example/">nested</iframe></template>'
    + '<template><script>var s = "</template>";</script><iframe src="https://scripted.example/">scripted</iframe></template>'
    + '<template><!-- </template> --><iframe src="https://commented.example/">commented</iframe></template>'
    + '<iframe src="https://shown.example/">Shown</iframe></body></html>';
  const seen = await judgedHere(html);
  assert.deepEqual([seen.frames, seen.frameText], [["https://shown.example"], ["Shown"]]);
});
