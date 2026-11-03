// web_fetch's direct fetch of a page cut before it was read: pi-browser's readPage cuts a page's HTML at 1,000,000
// characters, so the text is the start of the page's. The Page says so (truncated, with the page's whole length in
// html_chars) and never gives the text it read as the page's whole length (no original_chars).
import assert from "node:assert/strict";
import { test } from "node:test";
import { webFetch } from "../dist/web-fetch.js";

const URL_ = "http://public.example/big";
const net = (html) => ({ lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) });

test("a page whose HTML was cut before it was read is truncated, with the page's whole length in html_chars and no original_chars", async () => {
  const html = `<html><head><title>Big</title></head><body><h1>Big page</h1>${'<div class="row"><span class="cell"></span></div>\n'.repeat(30_000)}<p>The end.</p></body></html>`;
  const page = await webFetch(URL_, net(html));
  assert.equal(page.ok, true, page.error);
  assert.deepEqual([page.via, page.truncated, page.html_chars, "original_chars" in page], ["direct", true, html.length, false]);
  assert.match(page.text, /^# Big page/);
  assert.ok(!page.text.includes("The end."), "past the cut");
});

test("a page read whole says nothing of a cut, nor of how it was converted", async () => {
  const page = await webFetch(URL_, net("<html><body><h1>Small</h1></body></html>"));
  assert.equal(page.text, "# Small");
  assert.deepEqual(["truncated" in page, "html_chars" in page, "converted" in page], [false, false, false]);
});
