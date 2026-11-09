// readPage leaves out what a page hides from everyone who reads it, so web_fetch's text is the page a person sees: an
// element with the hidden attribute, an inline display:none or visibility:hidden, a closed dialog, a class the page's
// own style sets to display:none or visibility:hidden, and the common pop-up and display-none utility classes. A
// record page's help pop-ups (hidden until a click) are not its record. What only a screen reader hears (sr-only,
// wb-inv) and what only a screen reader skips (aria-hidden) are both read: each is shown to someone.
import assert from "node:assert/strict";
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
