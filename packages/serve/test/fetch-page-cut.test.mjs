// web_fetch's direct fetch of a page cut before it was read: pi-browser's readPage cuts a page's HTML at 1,000,000
// characters, so the text is the start of the page's. Every part of it says so (html_chars, the page's whole length)
// and none gives the text it read as the page's whole length (no original_chars); truncated and next_offset say only
// that more parts follow.
import assert from "node:assert/strict";
import { test } from "node:test";
import { webFetch } from "../dist/web-fetch.js";

const URL_ = "http://public.example/big";
const net = (html) => ({ lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) });

test("a page whose HTML was cut before it was read gives the page's whole length in html_chars and no original_chars, in one part", async () => {
  const html = `<html><head><title>Big</title></head><body><h1>Big page</h1>${'<div class="row"><span class="cell"></span></div>\n'.repeat(30_000)}<p>The end.</p></body></html>`;
  const page = await webFetch(URL_, net(html));
  assert.equal(page.ok, true, page.error);
  assert.deepEqual([page.via, "truncated" in page, page.html_chars, "original_chars" in page], ["direct", false, html.length, false], "its text is one part: none follows");
  assert.match(page.text, /^# Big page/);
  assert.ok(!page.text.includes("The end."), "past the cut");
});

test("a page read whole says nothing of a cut, nor of how it was converted", async () => {
  const page = await webFetch(URL_, net("<html><body><h1>Small</h1></body></html>"));
  assert.equal(page.text, "# Small");
  assert.deepEqual(["truncated" in page, "html_chars" in page, "converted" in page], [false, false, false]);
});

test("a cut page read in parts to its end: every part gives html_chars and none original_chars; truncated and next_offset only while a part follows, so the last part says the cut alone", async () => {
  const html = `<html><head><title>Long</title></head><body><h1>Long page</h1>${Array.from({ length: 40_000 }, (_, i) => `<p>Paragraph ${i} of the page, with its words.</p>`).join("\n")}<p>The end.</p></body></html>`;
  const parts = [];
  for (let offset = 0, i = 0; i < 100; i += 1) {
    const page = await webFetch(URL_, { ...net(html), offset, maxChars: 50_000 });
    assert.equal(page.ok, true, page.error);
    assert.deepEqual([page.html_chars, "original_chars" in page], [html.length, false], `part ${i}`);
    parts.push(page);
    if (!page.truncated) { assert.equal("next_offset" in page, false, "the last part names no next"); break; }
    assert.equal(page.next_offset, offset + page.chars, `part ${i} names where the next begins`);
    offset = page.next_offset;
  }
  assert.ok(parts.length > 3, `${parts.length} parts`);
  const text = parts.map((page) => page.text).join("");
  assert.match(text, /^# Long page\n\nParagraph 0 of the page, with its words\./);
  assert.ok(!text.includes("The end."), "the page's end is past the cut");
});
