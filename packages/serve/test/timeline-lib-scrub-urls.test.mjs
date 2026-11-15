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

test("a compact quoted list's URLs are each scrubbed alone, and a URL run into another's path or host never shows its userinfo", () => {
  // Credentials made at runtime: no credential-shaped literal for the source export.
  const signed = (host) => Object.assign(new URL(`https://${host}/`), { username: "user", password: "pw-held" }).href;
  assert.equal(scrubUrls(`['https://a.example/','${signed("b.example")}']`), "['https://a.example/','https://b.example/']");
  assert.equal(scrubUrls(`['https://a.example/x','${signed("b.example")}y?token=v']`), "['https://a.example/x','https://b.example/y?token=…']");
  // Past the first entry's "?" or "#" the rest is its query or fragment: dropped with it, never split out.
  assert.equal(scrubUrls(`['https://a.example/?k=v','${signed("b.example")}x?token=v']`), "['https://a.example/?k=…']");
  // A query key with no "=" before the next entry: the entry rides in the key, its userinfo dropped, its values too.
  assert.equal(scrubUrls(`['https://a.example/?flag','${signed("b.example")}?token=v']`), "['https://a.example/?flag','https://b.example/?token=…']");
  assert.equal(scrubUrls(`https://a.example/?flag,${signed("b.example")}`), "https://a.example/?flag,https://b.example/=…");
  assert.equal(scrubUrls("https://a.example/?next='https://b.example/reset/held-token'"), "https://a.example/?next=…'");
  assert.equal(scrubUrls("https://a.example/#'https://b.example/reset/held-token'"), "https://a.example/'");
  assert.equal(scrubUrls(`https://a.example/,${signed("b.example")}`), "https://a.example/,https://b.example/");
  assert.equal(scrubUrls(`https://a.example,${signed("b.example")}`), "https://a.example,https://b.example/");
  // A URL in another's query is a value, dropped with it.
  assert.equal(scrubUrls("https://a.example/go?next=https://b.example/c?x=1"), "https://a.example/go?next=…");
});

test("a long run of apostrophes or punctuation after a URL is scrubbed in linear time", () => {
  const started = performance.now();
  const runs = ["'".repeat(200_000), `${"'".repeat(100_000)}x`, `${".".repeat(200_000)}x`, `${"',".repeat(50_000)}https://b.example/?k=v`];
  for (const run of runs) assert.ok(scrubUrls(`https://a.example/${run}`).length > 0);
  assert.ok(performance.now() - started < 2_000, `took ${Math.round(performance.now() - started)} ms`);
});

test("an apostrophe inside a query value never lets the values after it through", () => {
  assert.equal(scrubUrls("https://search.example/?q='rust'&token=v"), "https://search.example/?q=…&token=…");
});

test("a sentence's punctuation after a URL stays outside it, as before", () => {
  assert.equal(scrubUrls("(see https://docs.example/a?b=1)."), "(see https://docs.example/a?b=…).");
  assert.equal(scrubUrls('{"url":"https://docs.example/a?b=1#top"}'), '{"url":"https://docs.example/a?b=…"}');
});
