import assert from "node:assert/strict";
import test from "node:test";
import { createRedactor, redactDeep, scrubPageUrl } from "../dist/index.js";
import { fetchableUrl } from "../dist/core/uri.js";
import { scrubFetchedUrl } from "../dist/core/redact.js";

const R = "[redacted]";

test("a registered value is scrubbed everywhere, in its raw and URL-encoded forms", () => {
  const secret = "s3cr3t/Key+val=ue";
  const redact = createRedactor(() => [secret]);
  const text = `a ${secret} b ${secret} c https://h.test/x?q=${encodeURIComponent(secret)}`;
  assert.equal(redact(text), `a ${R} b ${R} c https://h.test/x?q=${R}`);
});

test("a value is scrubbed in every spelling web_fetch sends it in: wherever the URL's first '#' falls, and whatever follows a trailing '%'", () => {
  const secrets = [["private#token#123", "token"], ["s>ec ret#mid#tail%zz", "tail"], ["private#token#123%", "token"], ["sixchars%4", "sixchars"]];
  // What follows a value can finish an escape it ends with: `%` before `41`, or `%4` before `1`, stays raw.
  const urls = (s) => [`https://s.example/?q=${s}`, `https://s.example/?q=1#frag=${s}`, `https://s.example/${s}/page`, `https://s.example/?a=${s}&b=${s}`,
    `https://s.example/?q=${s}41`, `https://s.example/?q=${s}1&n=2`, `https://s.example/?q=1#f=${s}41`, `https://s.example/?q=${s}zz`];
  for (const [secret, marker] of secrets) {
    const redact = createRedactor(() => [secret]);
    for (const url of urls(secret)) {
      const sent = fetchableUrl(url);
      assert.equal(redact(sent).includes(marker), false, `${sent} -> ${redact(sent)}`);
    }
  }
});

test("the values are read at every call, so a value registered after the redactor was built is covered", () => {
  const values = [];
  const redact = createRedactor(() => values);
  assert.equal(redact("key kernel_abcdefgh"), "key kernel_abcdefgh");
  values.push("kernel_abcdefgh");
  assert.equal(redact("key kernel_abcdefgh"), `key ${R}`);
});

test("a value shorter than 8 characters, an empty value and a non-string are never scrubbed", () => {
  const redact = createRedactor(() => ["abc1234", "", null, 12345678, "abcd1234"]);
  assert.equal(redact("abc1234 12345678 abcd1234"), `abc1234 12345678 ${R}`);
});

test("a value inside a longer registered value never leaves the rest of the longer one behind", () => {
  const short = "bb_proj_a1b2c3d4";
  const long = `kernel_sk_${short}_9f8e7d6c5b4a`;
  for (const order of [[short, long], [long, short]]) {
    const out = createRedactor(() => order)(`key=${long} id=${short}`);
    assert.equal(out, `key=${R} id=${R}`, `registered as ${order.map((v) => v.length).join(", ")}`);
  }
});

test("credential shapes are scrubbed with no registered value, and their names and prefixes stay", () => {
  const redact = createRedactor();
  const cases = [
    ["wss://c.test/?signingKey=abc.def&x=1", `wss://c.test/?signingKey=${R}&x=1`],
    ["https://a.test/?API_KEY=v1&apikey=v2&access_token=v3&token=v4&key=v5&jwt=v6&Signature=v7#f", `https://a.test/?API_KEY=${R}&apikey=${R}&access_token=${R}&token=${R}&key=${R}&jwt=${R}&Signature=${R}#f`],
    ['"u=https://a.test/?token=abc" next', `"u=https://a.test/?token=${R}" next`],
    ["sk-proj-abcdefghijklmnop", `sk-proj-a${R}`],
    ["bb_live_abcdEFGH1234", `bb_live_abcd${R}`],
    ["bb_test_wxyz_9876", `bb_test_wxyz${R}`],
    [`AIza${"B".repeat(35)}`, `AIza${R}`],
    ["Authorization: Bearer eyJhbGciOi.payload.sig", `Authorization: Bearer ${R}`],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test("text that only resembles a credential is left alone", () => {
  const redact = createRedactor();
  for (const text of ["https://a.test/?monkey=1&tokens=2&id=3", "risk-assessment task-runner", "Bearer short", "AIzaShort", "bb_live_ab"]) {
    assert.equal(redact(text), text);
  }
});

test("redacting twice changes nothing more than redacting once", () => {
  const redact = createRedactor(() => ["registered-value-1"]);
  const text = "registered-value-1 ?token=abc sk-abcdefghijk bb_live_abcdefgh Bearer abcdefghij AIza" + "C".repeat(32);
  assert.equal(redact(redact(text)), redact(text));
});

test("a page URL keeps its origin, path and query names; every query value, the fragment and the userinfo go", () => {
  const redact = createRedactor();
  assert.equal(scrubPageUrl(["https:", "//user:pw@shop.test:8443/a/b?id=7&q=x&id=8&empty=#frag"].join(""), redact), `https://shop.test:8443/a/b?id=${R}&q=${R}&empty=${R}`);
  assert.equal(scrubPageUrl("http://shop.test/a?", redact), "http://shop.test/a");
  assert.equal(scrubPageUrl("https://shop.test/?a%20b=1", redact), `https://shop.test/?a%20b=${R}`);
});

test("a page URL is still redacted after scrubbing, so a registered value in its path goes too", () => {
  const redact = createRedactor(() => ["reset-token-0123456789"]);
  assert.equal(scrubPageUrl("https://shop.test/reset/reset-token-0123456789?step=2", redact), `https://shop.test/reset/${R}?step=${R}`);
});

test("a URL that is not http(s), or does not parse, is only redacted", () => {
  const redact = createRedactor(() => ["ext-secret-value"]);
  assert.equal(scrubPageUrl("about:blank", redact), "about:blank");
  assert.equal(scrubPageUrl("chrome-error://chromewebdata/?x=1", redact), "chrome-error://chromewebdata/?x=1");
  assert.equal(scrubPageUrl("data:text/plain,ext-secret-value", redact), `data:text/plain,${R}`);
  assert.equal(scrubPageUrl("not a url ?token=abc", redact), `not a url ?token=${R}`);
});

test("redactDeep reaches every string, keys included, and leaves other values and the input alone", () => {
  const redact = createRedactor(() => ["deep-secret-1"]);
  const input = { "deep-secret-1": ["a deep-secret-1", 3, true, null, { nested: "deep-secret-1" }], n: 1, u: undefined };
  const out = redactDeep(input, redact);
  assert.deepEqual(out, { [R]: [`a ${R}`, 3, true, null, { nested: R }], n: 1, u: undefined });
  assert.equal(input["deep-secret-1"][4].nested, "deep-secret-1");
  assert.equal(redactDeep("deep-secret-1", redact), R);
  assert.equal(redactDeep(42, redact), 42);
});


// A public query value (dosId on a state registry URL) is blanked in a browser receipt and kept in a web_fetch receipt. That is intended, and stated in the tools' contracts: pinned here side by side.
test("one URL, two stated rules: a browser page URL shows every query value as the placeholder (the site chose where the browser went, so any value in it can be a credential), a fetched URL keeps a value that is in the URL the model asked for and redacts every other", () => {
  const redact = createRedactor();
  const final = "https://dos.example/CorpSearch?dosId=12345&sessionId=abc";
  assert.equal(scrubPageUrl(final, redact), `https://dos.example/CorpSearch?dosId=${R}&sessionId=${R}`, "browser: every value goes");
  assert.equal(scrubFetchedUrl(final, "https://dos.example/CorpSearch?dosId=12345", redact), `https://dos.example/CorpSearch?dosId=12345&sessionId=${R}`, "fetch: the value the model sent stays, the one the site added goes");
  assert.equal(scrubFetchedUrl(final, "https://dos.example/CorpSearch", redact), `https://dos.example/CorpSearch?dosId=${R}&sessionId=${R}`, "fetch: a value the model did not send goes too");
});
