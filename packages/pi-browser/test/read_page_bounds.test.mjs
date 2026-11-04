// readPage on a page too big to convert in one pass. The host's tools run in the run's own process, so a conversion that
// holds the event loop holds the run's heartbeat too, and the run is fenced: go.dev/dl, 3.15 MB of tables, held it past
// 240 s. Each big read here runs in a child process, so a read that holds its own loop cannot hold this runner's; the
// child reports its wall time and the longest its event loop was held (perf_hooks' monitorEventLoopDelay), and one
// that does not answer within GUARD_MS is killed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { readPage } from "../dist/index.js";
import { downloadsPage } from "./fixtures/downloads-page.mjs";

const GUARD_MS = 30_000;
const URL_ = "https://downloads.example/dl/";
const CHILD = `
import { monitorEventLoopDelay } from "node:perf_hooks";
const [dist, local, fixture, chars, which, options, shape] = process.argv.slice(1);
const { readPage } = await import(dist);
const { httpBackup } = await import(local);
const { downloadsPage, shapedPage } = await import(fixture);
const { html, first, last } = shape ? shapedPage(shape, Number(chars)) : downloadsPage(Number(chars));
const held = monitorEventLoopDelay({ resolution: 10 });
held.enable();
const started = performance.now();
let page = null;
let error = null;
try {
  if (which === "readPage") page = await readPage(html, ${JSON.stringify(URL_)}, JSON.parse(options));
  else if (which === "abort") await readPage(html, ${JSON.stringify(URL_)}, { signal: AbortSignal.timeout(200) });
  else page = { text: await httpBackup({ lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) }).fetch(${JSON.stringify(URL_)}) };
} catch (thrown) { error = { name: thrown?.name, message: String(thrown?.message ?? thrown) }; }
const wallMs = performance.now() - started;
held.disable();
process.stdout.write(JSON.stringify({ wallMs, heldMs: held.max / 1e6, htmlChars: html.length, first, last, page, error }));
`;

/** `which` ("readPage", "abort" or "httpBackup") on a generated page of `chars` characters (downloadsPage's, or
 *  shapedPage's `shape`), in a child process: `{ hung: true }` when it does not answer within GUARD_MS. */
function inChild(which, chars, options = {}, shape = "") {
  return new Promise((resolve, reject) => {
    const args = [new URL("../dist/index.js", import.meta.url).href, new URL("../dist/coding-agent-local.js", import.meta.url).href, new URL("./fixtures/downloads-page.mjs", import.meta.url).href, String(chars), which, JSON.stringify(options), shape];
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

/** A file's row in the markdown table: a table pads each column to its widest cell. */
const row = (name) => new RegExp(`\\| \\[${name.replaceAll(".", "\\.")}\\]\\(/dl/${name.replaceAll(".", "\\.")}\\) +\\| Archive +\\|`);

/** The run answered within GUARD_MS and within `wallMs`, its event loop never held 100 ms. */
function quick(run, wallMs) {
  assert.ok(!run.hung, `no answer within ${GUARD_MS / 1000} s`);
  assert.ok(run.wallMs < wallMs, `${Math.round(run.wallMs)} ms, over ${wallMs} ms`);
  assert.ok(run.heldMs < 100, `the event loop was held ${run.heldMs.toFixed(1)} ms`);
}

test("a 3 MB page of tables is read within 10 s, its event loop never held 100 ms: markdown, cut, with the page's whole length", async () => {
  const run = await inChild("readPage", 3_000_000);
  quick(run, 10_000);
  const { page, first, last, htmlChars } = run;
  assert.deepEqual([page.converted, page.truncated, page.html_chars, page.title], ["markdown", true, htmlChars, "All releases & downloads"]);
  assert.match(page.text, /^# All releases\n/);
  assert.match(page.text, /\| File name +\| Kind +\| OS +\| Arch +\| Size +\| SHA256 Checksum +\|/);
  assert.match(page.text, row(first), "the first row, as a markdown table row");
  assert.ok(!page.text.includes(last), "the rows past the cut are not read");
  assert.ok(page.text.length > 4 * 60_000, `${page.text.length} characters: room to page past the first 60,000`);
  assert.ok(page.links.includes(`${URL_}${first}`), "the first download is a link");
  assert.ok(page.links.includes("https://downloads.example/notes?release=0&lang=en"), "a link's entities are decoded");
});

test("a conversion past its deadline gives way to the page's plain text, still without holding the event loop", async () => {
  const run = await inChild("readPage", 3_000_000, { deadlineMs: 50 });
  quick(run, 5_000);
  const { page, first, htmlChars } = run;
  assert.deepEqual([page.converted, page.truncated, page.html_chars, page.title], ["text", true, htmlChars, "All releases & downloads"]);
  assert.match(page.text, /^All releases\n/);
  assert.ok(page.text.includes(`${first} | Archive | Linux | x86-64 | 60MB | `), "a row's cells on one line");
  assert.doesNotMatch(page.text, /<\/?[a-z]/i, "no markup");
  assert.doesNotMatch(page.text, /&amp;|  |dataLayer|font-weight/, "entities decoded, whitespace collapsed, no script or style");
  assert.ok(page.text.length > 4 * 60_000, `${page.text.length} characters`);
  assert.ok(page.links.includes(`${URL_}${first}`));
  assert.ok(page.links.includes("https://downloads.example/notes?release=0&lang=en"));
});

test("a read whose signal ends mid-conversion stops at once, with the signal's reason", async () => {
  const run = await inChild("abort", 3_000_000);
  quick(run, 2_000);
  assert.equal(run.error?.name, "TimeoutError");
});

test("the local coding agent's web backup reads a 3 MB page within 10 s without holding the event loop", async () => {
  const run = await inChild("httpBackup", 3_000_000);
  quick(run, 10_000);
  assert.match(run.page.text, row(run.first));
  assert.ok(!run.page.text.includes(run.last));
});

test("a small page reads whole, as markdown; an aborted signal starts no read", async () => {
  const page = await readPage('<html><head><title>Small</title></head><body><h1>Small</h1><p>Hello.</p></body></html>', "https://small.example/");
  assert.deepEqual([page.converted, "truncated" in page, "html_chars" in page], ["markdown", false, false]);
  assert.equal(page.text, "# Small\n\nHello.");
  await assert.rejects(readPage("<p>x</p>", "https://small.example/", { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("script, style, svg, noscript and template blocks are dropped before the cut: none of their text or links reaches the page", async () => {
  const script = `<script>${"var x = 1;\n".repeat(150_000)}</script>`;
  const html = `<html><head><title>Small</title><style>${".a { color: red }\n".repeat(30_000)}</style></head><body><h1>Small page</h1><svg viewBox="0 0 10 10"><title>icon title</title><text>svg words</text></svg><noscript><a href="/noscript">enable scripts</a></noscript><template><p>template words</p><a href="/template">template link</a></template><!-- <a href="/commented">commented</a> -->${script}<p>After the script.</p><a href="/kept">Kept</a></body></html>`;
  const page = await readPage(html, "https://small.example/");
  assert.deepEqual([page.converted, page.truncated, page.title], ["markdown", undefined, "Small"]);
  assert.match(page.text, /^# Small page\n\nAfter the script\.\s+\[Kept\]\(\/kept\)$/);
  assert.deepEqual(page.links, ["https://small.example/kept"]);
});

test("a page converted in pieces reads as one pass over it would, but for the spaces that end a line", async () => {
  const { html } = downloadsPage(150_000);
  const page = await readPage(html, URL_);
  const lines = (text) => text.replace(/[ \t]+$/gm, "");
  assert.equal(lines(page.text), lines(NodeHtmlMarkdown.translate(html, { keepDataImages: false }).trim()));
});

test("50,000 svg start tags never closed, then a style and a script never closed, on a 5 MB page: read within 10 s, the event loop never held 100 ms", async () => {
  const run = await inChild("readPage", 5_000_000, {}, "unclosed");
  quick(run, 10_000);
  const { page } = run;
  assert.equal(page.truncated, true);
  assert.match(page.text, /^# Start\n/);
  assert.ok(page.text.includes("para 0 of the page, kept"), "the text after an unclosed svg is kept");
  assert.doesNotMatch(page.text, /color: red|track\(\)/, "an unclosed style runs to the end of the page");
});

test("a quoted attribute value is part of its tag: a \"<script>\" in one drops nothing, a \">\" in one ends no tag, as markdown and as plain text", async () => {
  const html = '<html><head><title>Quotes</title></head><body><div data-example="<script>"><p>Keep me</p></div><p><a title="x > y" href="/next">Next</a></p><p>After</p></body></html>';
  for (const deadlineMs of [undefined, 0]) {
    const page = await readPage(html, "https://site.example/", deadlineMs === undefined ? {} : { deadlineMs });
    const how = deadlineMs === undefined ? "markdown" : "text";
    assert.equal(page.converted, how);
    assert.match(page.text, /Keep me/, how);
    // node-html-markdown writes a link's title into its markdown: the link stands, with its href.
    assert.match(page.text, how === "markdown" ? /\[Next\]\(\/next "x > y"\)/ : /Next/, how);
    assert.match(page.text, /After/, how);
    assert.deepEqual(page.links, ["https://site.example/next"], how);
  }
});

test("a quote no quote closes, opened in 40,000 tags on a 2 MB page: each tag ends at its \">\", read within 10 s without holding the event loop", async () => {
  const run = await inChild("readPage", 2_000_000, {}, "unquoted");
  quick(run, 10_000);
  assert.ok(run.page.text.includes("para 0 of the page, kept"), "the page is not eaten by the open quote");
  assert.ok(run.page.text.includes("para 1 of the page, kept"));
});

test("a link is a's own href attribute: an \"href=\" inside another attribute's quoted value is that value's text, as markdown and as plain text", async () => {
  const html = "<html><head><title>Links</title></head><body><p><a title=\"see href='https://wrong.example/'\" href=\"/right\">Right</a></p>"
    + "<p><a data-x='see href=\"https://mention.example/\"'>Not a link</a></p><p><a class=\"x\"href=\"/tight\">Tight</a></p></body></html>";
  for (const deadlineMs of [undefined, 0]) {
    const page = await readPage(html, "https://site.example/", deadlineMs === undefined ? {} : { deadlineMs });
    const how = deadlineMs === undefined ? "markdown" : "text";
    assert.equal(page.converted, how);
    assert.deepEqual(page.links, ["https://site.example/right", "https://site.example/tight"], how);
  }
});

test("a numeric character reference reads as a browser reads it, whatever its leading zeroes, the same as markdown and as plain text", async () => {
  const html = "<html><head><title>&#000000065;&#x0000000042;</title></head><body>"
    + "<p>&#000000065;&#x0000000042;&#67 &#000000000000000000000000000000000000000000068; x &#1114112;&#xD800;&#0;&#99999999999999999999; x &#150;&#x80;</p></body></html>";
  for (const deadlineMs of [undefined, 0]) {
    const page = await readPage(html, "https://site.example/", deadlineMs === undefined ? {} : { deadlineMs });
    const how = deadlineMs === undefined ? "markdown" : "text";
    assert.equal(page.converted, how);
    assert.equal(page.title, "AB", how);
    assert.equal(page.text, "ABC D x ���� x –€", how);
  }
});

test("decodeEntities reads a numeric reference's whole digit run, in one linear pass: past U+10FFFF, a surrogate or zero is U+FFFD, 128 to 159 are windows-1252's, as in a browser", async () => {
  const { decodeEntities } = await import("../dist/core/entities.js");
  assert.equal(decodeEntities("&#000000065;&#x000000041;&#X0042;&#65&#x41 B"), "AAB" + "AA B");
  assert.equal(decodeEntities("&#1114111;"), "\u{10FFFF}");
  assert.equal(decodeEntities("&#1114112;&#x110000;&#xDFFF;&#55296;&#0;&#x00000;&#99999999999999999999999;&#xFFFFFFFFFFFFFFFFFFFF;"), "�".repeat(8));
  assert.equal(decodeEntities("&#128;&#x81;&#x8D;&#146;&#x96;&#159;"), "€\u0081\u008D’–Ÿ");
  assert.equal(decodeEntities("&#; &#x; &#xG; &# 65;"), "&#; &#x; &#xG; &# 65;", "no digit: left as written");
  const started = performance.now();
  assert.equal(decodeEntities(`&#${"0".repeat(2_000_000)}65; and &#x${"0".repeat(2_000_000)}42;`), "A and B");
  assert.equal(decodeEntities("&#0000065;".repeat(200_000)), "A".repeat(200_000));
  assert.ok(performance.now() - started < 2_000, "linear in the text");
});

test("a template's content is dropped whole however templates nest: a template inside it does not end it, nor does a \"</template>\" in its script or its comment, as markdown and as plain text", async () => {
  const html = '<html><head><title>Nest</title></head><body><h1>Shown</h1>'
    + '<template><template><p>inner</p></template><p>Hidden after the inner template.</p><a href="/hidden">hidden link</a></template>'
    + '<template><script>var s = "</template>";</script><p>Hidden after the script.</p></template>'
    + '<template><!-- </template> --><p>Hidden after the comment.</p></template>'
    + '<p>After the templates.</p><a href="/shown">Shown link</a></body></html>';
  for (const deadlineMs of [undefined, 0]) {
    const page = await readPage(html, "https://site.example/", deadlineMs === undefined ? {} : { deadlineMs });
    const how = deadlineMs === undefined ? "markdown" : "text";
    assert.equal(page.converted, how);
    assert.doesNotMatch(page.text, /Hidden|inner|var s|hidden link/, how);
    assert.match(page.text, /Shown[\s\S]*After the templates\.[\s\S]*Shown link/, how);
    assert.deepEqual(page.links, ["https://site.example/shown"], how);
  }
});

test("a template holding a template, hidden words and a \"</template>\" in a script, before each of a 3 MB page's paragraphs: each dropped whole, read within 10 s, the event loop never held 100 ms", async () => {
  const run = await inChild("readPage", 3_000_000, {}, "templates");
  quick(run, 10_000);
  assert.ok(run.page.text.includes("para 0 of the page, kept"), "the text after a template is kept");
  assert.ok(run.page.text.includes("para 1 of the page, kept"));
  assert.doesNotMatch(run.page.text, /hidden|inner|var s/, "nothing inside a template reaches the page");
});

test("one template holding a 3 MB page of short tags, closed at its end: dropped whole, the paragraph after it kept, the event loop never held 100 ms", async () => {
  const run = await inChild("readPage", 3_000_000, {}, "bigtemplate");
  quick(run, 10_000);
  assert.match(run.page.text, /^# Start\n\nafter the template, kept$/);
});

test("a textarea's or a title's text is never read as tags: a \"<template>\" in one, inside a template or out of one, opens nothing, and a \"<script>\" in a title drops nothing, as markdown and as plain text", async () => {
  const html = '<html><head><title>Use <script> tags</title></head><body><h1>Top</h1>'
    + '<template><textarea><template></textarea><p>Hidden in the template.</p></template><p>Visible after a template.</p>'
    + '<template><title><template></title></template><p>Visible after a title in a template.</p>'
    + '<form><textarea><template></textarea></form><p>Visible after a textarea.</p></body></html>';
  for (const deadlineMs of [undefined, 0]) {
    const page = await readPage(html, "https://site.example/", deadlineMs === undefined ? {} : { deadlineMs });
    const how = deadlineMs === undefined ? "markdown" : "text";
    assert.equal(page.converted, how);
    assert.equal(page.title, "Use <script> tags", how);
    assert.match(page.text, /Top[\s\S]*Visible after a template\.[\s\S]*Visible after a title in a template\.[\s\S]*Visible after a textarea\./, how);
    assert.doesNotMatch(page.text, /Hidden/, how);
  }
});
