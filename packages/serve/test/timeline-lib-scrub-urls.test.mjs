// A URL scrubbed from timeline text (scrubUrls: what the model read, a tool's result, a page's title) never shows a query
// value, wherever the value sits: an apostrophe is part of a URL (a path's O'Reilly, a query's quoted word), so the query
// after it is scrubbed too. One that closes a quote around the URL stays outside it, beside the punctuation a sentence
// ends a URL with.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubUrls } from "../dist/timeline/index.js";

test("a URL with an apostrophe in its path shows no query value after it", () => {
  assert.equal(scrubUrls("see https://books.example/O'Reilly?token=v now"), "see https://books.example/O'Reilly?token=… now");
  assert.equal(scrubUrls("https://books.example/O'Reilly/Media's?token=v&page=2"), "https://books.example/O'Reilly/Media's?token=…&page=…");
});

test("a URL in quotes shows no query value, and the closing quote stays outside it", () => {
  assert.equal(scrubUrls("url: 'https://api.example/a?token=v'"), "url: 'https://api.example/a?token=…'");
  assert.equal(scrubUrls("['https://api.example/a?token=v', 'https://api.example/b?k=w']"), "['https://api.example/a?token=…', 'https://api.example/b?k=…']");
  assert.equal(scrubUrls("It said 'https://api.example/a?token=v'."), "It said 'https://api.example/a?token=…'.");
});

test("an apostrophe inside a query value never lets the values after it through", () => {
  assert.equal(scrubUrls("https://search.example/?q='rust'&token=v"), "https://search.example/?q=…&token=…");
});

test("a sentence's punctuation after a URL stays outside it, as before", () => {
  assert.equal(scrubUrls("(see https://docs.example/a?b=1)."), "(see https://docs.example/a?b=…).");
  assert.equal(scrubUrls('{"url":"https://docs.example/a?b=1#top"}'), '{"url":"https://docs.example/a?b=…"}');
});
