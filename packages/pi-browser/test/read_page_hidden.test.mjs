// readPage leaves out what a page hides from everyone who reads it, so web_fetch's text is the page a person sees: an
// element with the hidden attribute, an inline display:none or visibility:hidden, a closed dialog, a class the page's
// own style sets to display:none or visibility:hidden, and the common pop-up and display-none utility classes. A
// record page's help pop-ups (hidden until a click) are not its record. What only a screen reader hears (sr-only,
// wb-inv) and what only a screen reader skips (aria-hidden) are both read: each is shown to someone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { readPage } from "../dist/index.js";

const URL_ = "https://records.example/corp?id=1";
const page = (body, head = "") => `<!doctype html><html><head><title>Record</title>${head}</head><body>${body}</body></html>`;
const textOf = async (html) => (await readPage(html, URL_)).text;

test("a record page's hidden help pop-ups are not its record: a section.mfp-hide is left out, the record around it is read", async () => {
  const text = await textOf(page(`
    <main>
      <h1>Example Shop Inc.</h1>
      <dl><dt>Status</dt><dd>Active</dd><dt>Corporation number</dt><dd>4261607</dd></dl>
      <p>Annual filings: <a href="#help-filing" class="popup">What is this?</a> Filed on time.</p>
      <section id="help-filing" class="mfp-hide wb-popup-mid"><h2>Overdue filing</h2>
        <p>A corporation that does not file may receive a notice of intent to dissolve.</p></section>
    </main>`));
  assert.match(text, /Example Shop Inc\./);
  assert.match(text, /Active/);
  assert.match(text, /4261607/);
  assert.match(text, /Filed on time\./);
  assert.doesNotMatch(text, /intent to dissolve/);
  assert.doesNotMatch(text, /Overdue filing/);
});

test("the hidden attribute, an inline display:none or visibility:hidden in any case and spacing, and a closed dialog are left out; their neighbours are read", async () => {
  const text = await textOf(page(`
    <p>Seen one.</p>
    <div hidden><p>Gone hidden.</p></div>
    <div HIDDEN="until-found">Gone until found.</div>
    <div style="color: red; DISPLAY : None ;">Gone display.</div>
    <span style="visibility:hidden !important">Gone visibility.</span>
    <dialog><p>Gone dialog.</p></dialog>
    <dialog open><p>Seen open dialog.</p></dialog>
    <div style="display:block">Seen block.</div>
    <div style="--display:none; color: blue">Seen custom property.</div>
    <p>Seen two.</p>`));
  for (const seen of ["Seen one.", "Seen open dialog.", "Seen block.", "Seen custom property.", "Seen two."]) assert.ok(text.includes(seen), `${seen} in: ${text}`);
  for (const gone of ["Gone hidden.", "Gone until found.", "Gone display.", "Gone visibility.", "Gone dialog."]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("a class the page's own style hides is left out, at the top level of the style only: a print or media rule, a compound selector or a rule that shows it hides nothing", async () => {
  const text = await textOf(page(`
    <section class="note tooltip-body">Gone styled.</section>
    <section class="banner">Gone listed.</section>
    <section class="print-only">Seen print only.</section>
    <section class="card">Seen compound.</section>
    <section class="shown">Seen shown.</section>
    <p>Seen after.</p>`, `
    <style>
      .tooltip-body { position: absolute; display : none }
      .banner, .other { visibility: hidden; }
      @media print { .print-only { display: none } }
      .deck .card { display: none }
      .shown { display: flex }
    </style>`));
  for (const seen of ["Seen print only.", "Seen compound.", "Seen shown.", "Seen after."]) assert.ok(text.includes(seen), `${seen} in: ${text}`);
  for (const gone of ["Gone styled.", "Gone listed."]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("the common pop-up and display-none utility classes are left out; a screen-reader-only label and an aria-hidden visible value are read", async () => {
  const text = await textOf(page(`
    <div class="modal fade"><p>Gone modal.</p></div>
    <div class="d-none d-md-block">Gone d-none.</div>
    <p class="hide">Gone hide.</p>
    <p class="hidden">Gone hidden class.</p>
    <p class="invisible">Gone invisible.</p>
    <p class="is-hidden">Gone is-hidden.</p>
    <p class="u-hidden">Gone u-hidden.</p>
    <p><span class="wb-inv">Status:</span> Active</p>
    <p><span class="sr-only">Price:</span> <span aria-hidden="true">$19.99</span></p>
    <p class="visually-hidden">Seen visually-hidden.</p>
    <p class="screen-reader-text">Seen screen-reader-text.</p>
    <p class="hidden-xs">Seen hidden-xs.</p>`));
  for (const seen of ["Status:", "Active", "Price:", "$19.99", "Seen visually-hidden.", "Seen screen-reader-text.", "Seen hidden-xs."]) assert.ok(text.includes(seen), `${seen} in: ${text}`);
  for (const gone of ["Gone modal.", "Gone d-none.", "Gone hide.", "Gone hidden class.", "Gone invisible.", "Gone is-hidden.", "Gone u-hidden."]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("a hidden element ends where its own end tag closes it: a same-name element inside is counted, a visible one after is read, and one never closed hides nothing", async () => {
  const text = await textOf(page(`
    <div hidden><div>Gone inner.</div><p>Gone after inner.</p></div><div>Seen sibling.</div>
    <img hidden alt="Gone image"><p>Seen after image.</p>
    <article><span hidden>Gone span</span> Seen beside.</article>
    <section class="mfp-hide"><p>Kept unclosed.</p>`));
  for (const seen of ["Seen sibling.", "Seen after image.", "Seen beside.", "Kept unclosed."]) assert.ok(text.includes(seen), `${seen} in: ${text}`);
  for (const gone of ["Gone inner.", "Gone after inner.", "Gone image", "Gone span"]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("the plain-text read (the markdown conversion out of time) leaves out what is hidden too", async () => {
  const read = await readPage(page(`<p>Seen plain.</p><section class="mfp-hide">Gone plain.</section>`), URL_, { deadlineMs: 0 });
  assert.equal(read.converted, "text");
  assert.ok(read.text.includes("Seen plain."), read.text);
  assert.ok(!read.text.includes("Gone plain."), read.text);
});

test("only a live style element counts: one in a comment, a script, a template or a noscript hides nothing, nor one whose media is not the screen", async () => {
  const text = await textOf(page(`
    <p class="c1">Seen commented.</p><p class="c2">Seen scripted.</p><p class="c3">Seen templated.</p><p class="c4">Seen noscript.</p>
    <p class="m1">Seen print.</p><p class="m2">Seen query.</p>
    <p class="m3">Gone screen.</p><p class="m4">Gone all.</p><p class="m5">Gone list.</p><p class="m6">Gone no media.</p>`, `
    <!-- <style>.c1 { display: none }</style> -->
    <script>const css = "<style>.c2 { display: none }</style>";</script>
    <template><style>.c3 { display: none }</style></template>
    <noscript><style>.c4 { display: none }</style></noscript>
    <style media="print">.m1 { display: none }</style>
    <style media="(max-width: 600px)">.m2 { display: none }</style>
    <style media="screen">.m3 { display: none }</style>
    <style media="ALL">.m4 { display: none }</style>
    <style media="print, screen">.m5 { display: none }</style>
    <style>.m6 { display: none }</style>`));
  for (const seen of ["Seen commented.", "Seen scripted.", "Seen templated.", "Seen noscript.", "Seen print.", "Seen query."]) assert.ok(text.includes(seen), `${seen} in: ${text}`);
  for (const gone of ["Gone screen.", "Gone all.", "Gone list.", "Gone no media."]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("a later declaration or rule that shows the element wins, an inline one over a class, an author display over the hidden attribute; where the outcome is in doubt the text is kept", async () => {
  const text = await textOf(page(`
    <p style="display:none;display:block">Seen inline last.</p>
    <p class="o1">Seen later rule.</p>
    <p class="o2" style="display: block">Seen inline over class.</p>
    <p class="hidden" style="display:flex">Seen inline over utility.</p>
    <div hidden style="display:block">Seen over hidden attribute.</div>
    <p class="o3">Seen important mix.</p>
    <p class="o4 o5">Seen classes in conflict.</p>
    <p class="o6">Seen shown by a compound rule.</p>
    <p style="display:block;display:none">Gone inline last.</p>
    <p class="o7">Gone later rule.</p>
    <p class="o8" style="display:block">Gone by visibility.</p>
    <p class="o9" style="color: red">Gone class, inline silent.</p>`, `
    <style>
      .o1 { display: none } .o1 { display: block }
      .o2 { display: none }
      .o3 { display: none !important } .o3 { display: block }
      .o4 { display: none } .o5 { display: block }
      .o6 { display: none } .open .o6 { display: block }
      .o7 { display: block } .o7 { display: none }
      .o8 { visibility: hidden }
      .o9 { display: none }
    </style>`));
  for (const seen of ["Seen inline last.", "Seen later rule.", "Seen inline over class.", "Seen inline over utility.", "Seen over hidden attribute.", "Seen important mix.", "Seen classes in conflict.", "Seen shown by a compound rule."]) assert.ok(text.includes(seen), `${seen} in: ${text}`);
  for (const gone of ["Gone inline last.", "Gone later rule.", "Gone by visibility.", "Gone class, inline silent."]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("a class or style value written with character references is read decoded", async () => {
  const text = await textOf(page(`
    <section class="mfp&#45;hide">Gone encoded class.</section>
    <p style="display&#58;none">Gone encoded style.</p>
    <p class="d&#x2D;none">Gone hex class.</p>
    <p>Seen after.</p>`));
  assert.ok(text.includes("Seen after."), text);
  for (const gone of ["Gone encoded class.", "Gone encoded style.", "Gone hex class."]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("a stylesheet of 400,000 spaces and 200,000 semicolons is read in one linear pass: the page reads in well under a second, in a child so a stalled loop cannot stall this runner", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { readPage } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    const css = " ".repeat(400000) + ";".repeat(200000);
    const html = "<html><head><style>" + css + "</style></head><body><p>Seen.</p></body></html>";
    const started = performance.now();
    const read = await readPage(html, "https://records.example/");
    process.stdout.write(JSON.stringify({ ms: performance.now() - started, seen: read.text.includes("Seen.") }));`], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const code = await new Promise((resolve) => child.once("exit", (exitCode, signal) => resolve(exitCode ?? signal)));
  clearTimeout(guard);
  assert.equal(code, 0, `the read did not end within 20 s (it was killed): ${out}`);
  const { ms, seen } = JSON.parse(out);
  assert.ok(seen, "the page's text is read");
  assert.ok(ms < 1_000, `read in ${Math.round(ms)} ms`);
});

test("visibility is inherited and a descendant can show itself again: an element hidden by visibility alone is kept whole when anything inside it is set visible; display:none is not undone by a descendant", async () => {
  const text = await textOf(page(`
    <div style="visibility:collapse"><span style="visibility:visible">Seen collapse child.</span></div>
    <div style="visibility:hidden"><span style="visibility: visible">Seen hidden child.</span></div>
    <div class="invisible"><span style="visibility:visible">Seen utility child.</span></div>
    <div class="invisible"><p class="vis">Seen class child.</p></div>
    <section style="visibility:hidden"><div><p><b style="visibility:visible">Seen grandchild.</b></p></div></section>
    <div style="visibility:hidden"><p>Gone no visible descendant.</p></div>
    <div style="display:none"><span style="visibility:visible">Gone display child.</span></div>
    <p>Seen after.</p>`, `<style>.vis { visibility: visible }</style>`));
  for (const seen of ["Seen collapse child.", "Seen hidden child.", "Seen utility child.", "Seen class child.", "Seen grandchild.", "Seen after."]) assert.ok(text.includes(seen), `${seen} in: ${text}`);
  for (const gone of ["Gone no visible descendant.", "Gone display child."]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("only a descendant that is shown keeps a visibility-hidden element: one display:none itself, or inside a display:none element within it, shows nothing", async () => {
  const text = await textOf(page(`
    <div style="visibility:hidden">Gone filing<span style="display:none;visibility:visible">Gone unused</span></div>
    <div style="visibility:hidden">Gone wrapped<div style="display:none"><span style="visibility:visible">Gone deep</span></div></div>
    <div style="visibility:hidden"><span style="visibility:visible">Seen control.</span></div>
    <div style="visibility:hidden">Gone outer<div style="display:none"><div style="visibility:hidden"><span style="visibility:visible">Gone nested</span></div></div></div>
    <p>Seen after.</p>`));
  for (const seen of ["Seen control.", "Seen after."]) assert.ok(text.includes(seen), `${seen} in: ${text}`);
  for (const gone of ["Gone filing", "Gone unused", "Gone wrapped", "Gone deep", "Gone outer", "Gone nested"]) assert.ok(!text.includes(gone), `${gone} in: ${text}`);
});

test("20,000 visibility-hidden elements of different names closed oldest first are dropped in one linear pass, well under a second, in a child so a stalled loop cannot stall this runner", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { dropHidden } = await import(${JSON.stringify(new URL("../dist/core/page-scan.js", import.meta.url).href)});
    let open = "", close = "";
    for (let i = 0; i < 20000; i++) { open += "<x-" + i + " class=\\"invisible\\">t"; close += "</x-" + i + ">"; }
    const html = "<p>Seen.</p>" + open + close;
    const started = performance.now();
    const kept = dropHidden(html, new Map(), (text) => text);
    process.stdout.write(JSON.stringify({ ms: performance.now() - started, seen: kept.includes("Seen.") }));`], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const code = await new Promise((resolve) => child.once("exit", (exitCode, signal) => resolve(exitCode ?? signal)));
  clearTimeout(guard);
  assert.equal(code, 0, `the drop did not end within 20 s (it was killed): ${out}`);
  const { ms, seen } = JSON.parse(out);
  assert.ok(seen, "the page's shown text stays");
  assert.ok(ms < 1_000, `dropped in ${Math.round(ms)} ms`);
});
