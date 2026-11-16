// A feed's XML read with no entity expanded (feed/parse.ts): a document that declares entities (billion laughs, an
// external SYSTEM entity) is refused in words, quickly and small, and a trigger reading one says so and stays on; only
// the five XML references (&amp; &lt; &gt; &quot; &apos;) and numeric character references decode, each once, in text
// and in attributes, never inside CDATA; and a feed with thousands of escaped references (HTML content, as Statuspage
// serves it) is read whole.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed } from "../dist/feed/parse.js";
import { serve } from "./support.mjs";
import { fakeClock, firings, made } from "./trigger-support.mjs";
import { checked } from "./email-support.mjs";
import { created, feed, feedTrigger, firedFeed, posts, T0, tick } from "./feed-support.mjs";

const LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE rss [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
 <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
 <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
 <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
 <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
 <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">
]>
<rss version="2.0"><channel><title>Laughs</title><item><guid>laugh-1</guid><title>&lol9;</title><description>&lol9;</description></item></channel></rss>`;
const PASSWD = `<?xml version="1.0"?>
<!DOCTYPE rss [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<rss version="2.0"><channel><title>Outside</title><item><guid>xxe-1</guid><title>Read &xxe;</title><description>&xxe;</description></item></channel></rss>`;
/** An RSS feed of one item, its title and description as given (already XML-escaped as the test means them). */
const rss = (title, description = "x", extra = "") => `<?xml version="1.0"?><rss version="2.0"><channel><title>Refs</title><item><guid>ref-1</guid><title>${title}</title><description>${description}</description>${extra}</item></channel></rss>`;

/** `body` read: its first item's fields, or the refusal's words. */
function read(body) {
  try {
    return { feed: parseFeed(body) };
  } catch (error) {
    return { refused: String(error?.message ?? error) };
  }
}

test("billion laughs is refused in words, at once and small: no entity is expanded", () => {
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const { feed: parsed, refused } = read(LAUGHS);
  assert.ok(performance.now() - started < 1_000, "read at once");
  assert.ok(process.memoryUsage().heapUsed - before < 64 * 1024 * 1024, "no blow-up");
  assert.equal(parsed, undefined, "a feed that declares entities is refused, never read in part");
  assert.match(refused, /entit/i, "the words say why");
  assert.doesNotMatch(refused, /lollol/);
});

test("an external SYSTEM entity is never read: refused in words, and no byte of the file it names is in what the read hands back", () => {
  const { feed: parsed, refused } = read(PASSWD);
  assert.equal(parsed, undefined);
  assert.match(refused, /entit/i);
  assert.doesNotMatch(refused, /root:/);
});

test("only the five XML references and numeric character references decode, each once; an HTML name stays as written; CDATA is read as it is", () => {
  const { feed: parsed, refused } = read(rss("Fish &amp; chips &lt;3 &quot;q&quot; &apos;a&apos; Caf&#233; &#x41;&#x1F600; &amp;#233; &amp;lt; &nbsp;x", "<![CDATA[<p>Fish &amp; chips</p>]]>", `<link>https://blog.example/a?b=1&amp;c=2</link>`));
  assert.equal(refused, undefined, refused);
  const [item] = parsed.items;
  assert.equal(item.title, `Fish & chips <3 "q" 'a' Café A😀 &#233; &lt; &nbsp;x`);
  assert.equal(item.link, "https://blog.example/a?b=1&c=2");
  assert.equal(item.summary, "Fish & chips", "the CDATA's HTML read once, as HTML");
  const atom = read(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A &amp; B</title><entry><id>tag:a.example,2005:1</id><title>T&#8217;s</title><link rel="alternate" href="https://a.example/x?y=1&amp;z=2"/><updated>2026-06-01T00:00:00Z</updated><content type="html">&lt;p&gt;Caf&amp;#233; &amp;amp; more&lt;/p&gt;</content></entry></feed>`);
  assert.equal(atom.refused, undefined, atom.refused);
  assert.equal(atom.feed.title, "A & B");
  assert.deepEqual([atom.feed.items[0].title, atom.feed.items[0].link, atom.feed.items[0].summary], ["T’s", "https://a.example/x?y=1&z=2", "Café & more"]);
});

test("a feed with thousands of escaped references (HTML content in every entry) is read whole", () => {
  const entries = Array.from({ length: 30 }, (_, i) => `<entry><id>tag:status.example,2005:Incident/${i}</id><title>Incident ${i}</title><link rel="alternate" href="https://status.example/incidents/${i}"/><updated>2026-06-01T00:${String(i).padStart(2, "0")}:00Z</updated><content type="html">${"&lt;p&gt;&lt;small&gt;Jun &lt;var data-var=&apos;date&apos;&gt;1&lt;/var&gt;&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; - Fixed &amp;amp; watched.&lt;/p&gt;".repeat(5)}</content></entry>`);
  const { feed: parsed, refused } = read(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Status</title>${entries.join("")}</feed>`);
  assert.equal(refused, undefined, refused);
  assert.equal(parsed.items.length, 30);
  assert.match(parsed.items[0].summary, /^Jun 1\nResolved - Fixed & watched\./);
});

test("a trigger whose feed starts declaring entities says so in words and stays on; nothing fires, nothing of the file is in any payload; the feed fixed, it goes on", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api, data } = await serve(t, { triggerClock: clock });
  await made(api, "reader");
  const blog = await feed(t, { format: "rss", title: "Turned", items: posts(2) });
  const { id } = await created(api, feedTrigger("reader", { urls: [blog.url] }));
  await firings(api, id, 1);
  for (const [n, body] of [[1, LAUGHS], [2, PASSWD]]) {
    blog.raw(body);
    clock.to(tick(n));
    const view = await checked(api, id, tick(n));
    assert.deepEqual([view.enabled, view.last_check.ok], [true, false], view.last_check.message);
    assert.match(view.last_check.message, /entit/i);
    assert.doesNotMatch(view.last_check.message, /root:|lollol/);
  }
  assert.equal((await firings(api, id, 1)).length, 1, "nothing fired");
  blog.raw();
  blog.add({ id: "new-1", link: "https://blog.example/new-1", title: "New 1", published: "2026-06-01T00:40:00Z" });
  clock.to(tick(3));
  const view = await checked(api, id, tick(3));
  assert.equal(view.last_check.ok, true, view.last_check.message);
  const fired = (await firings(api, id, 2)).find((f) => f.run_id);
  assert.ok(fired, "the fixed feed's new item fires");
  const { payload, content } = firedFeed(data, fired.run_id);
  assert.equal(payload.title, "New 1");
  assert.doesNotMatch(content, /root:/);
});
