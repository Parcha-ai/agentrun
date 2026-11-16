// The feed trigger's poll (trigger-feed.ts) on a fake network, no server: a JSON list's `fields` and pointers read and
// write own keys only (an item's own "__proto__" or an inherited name is never reached through the prototype), and a
// seen set tells a missing date from a real one at or before 1970 (a legacy cursor's 0 for a JSON list's item is read
// as missing, once; an RSS or JSON Feed item that gains a date still fires an update).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TRIGGER_ADAPTERS } from "../dist/trigger-adapters.js";

const feedAdapter = TRIGGER_ADAPTERS.find((one) => one.id === "feed");
const URL_OF = "https://feeds.example/list.json";
const hashed = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** One poll of `source` over `body` (the text the feed serves), from `cursor` (the setting's text), as the engine runs it. */
async function pollOf(source, body, cursor) {
  const net = {
    lookup: async () => ["93.184.216.34"], local: () => [],
    fetch: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    dial: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  };
  return feedAdapter.poll({ kind: "feed", urls: [URL_OF], every_s: 900, ...source }, { trigger: "trg_x", setting: (field) => (field === "cursor" ? cursor : undefined), credentials: async () => ({ network: net, reach: {} }) });
}
/** The poll that takes the start on `first`, then the one on `then`: its events. */
async function startThen(source, first, then) {
  const start = await pollOf(source, first, undefined);
  assert.equal(start.events, undefined, "the first poll fires none");
  return (await pollOf(source, then, start.cursor.cursor)).events ?? [];
}
const list = (...items) => JSON.stringify(items);

test("`fields` never writes through an item's own \"__proto__\": the shared prototype stays clean, and the value is kept as an own key", async () => {
  try {
    const events = await startThen({ fields: ["/__proto__/polluted"] }, list({ id: 1 }), '[{"id":2,"__proto__":{"polluted":1}}]');
    assert.equal(({}).polluted, undefined, "Object.prototype was written");
    assert.equal(events.length, 1);
    const item = events[0].body.item;
    assert.equal(Object.getPrototypeOf(item), Object.prototype, "the payload's item is a plain object");
    assert.equal(JSON.stringify(item), '{"__proto__":{"polluted":1}}');
    assert.equal(Object.hasOwn(item, "__proto__"), true);
  } finally {
    delete Object.prototype.polluted;
  }
});

test("an id or updated pointer reads own keys only: /constructor/name and /toString are missing on an item without them, never \"Object\"", async () => {
  const first = list({ id: 1, title: "One" }, { id: 2, title: "Two" });
  for (const pointer of ["/constructor/name", "/toString", "/__proto__/constructor/name"]) {
    const events = await startThen({ id: pointer }, first, list({ id: 3, title: "Three", html_url: "https://x.example/3" }, { id: 1, title: "One" }, { id: 2, title: "Two" }));
    assert.equal(events.length, 1, pointer);
    // No id read: the item is keyed by its link, never by the inherited value every item would share.
    assert.equal(events[0].body.id, null, pointer);
  }
  const dated = await startThen({ updated: "/constructor/name" }, list({ id: 1 }), list({ id: 1 }));
  assert.deepEqual(dated, []);
});

test("a JSON list's seen set tells a missing date from an epoch or pre-1970 date: either one is later updated, and fires with update: true", async () => {
  for (const [was, now] of [["1970-01-01T00:00:00Z", "2026-06-01T00:00:00Z"], ["1969-12-31T00:00:00Z", "2026-06-01T00:00:00Z"]]) {
    const events = await startThen({ updated: "/updated_at" }, list({ id: 1, updated_at: was }), list({ id: 1, updated_at: now }));
    assert.equal(events.length, 1, was);
    assert.equal(events[0].body.update, true, was);
  }
  const none = await startThen({ updated: "/updated_at" }, list({ id: 1 }), list({ id: 1, updated_at: "2026-06-01T00:00:00Z" }));
  assert.deepEqual(none, [], "an item first seen with no date does not fire when it gains one");
});

test("a cursor saved before dates were told apart (a 0 for a JSON list's missing date) reads that 0 as missing: the first date it gets fires nothing", async () => {
  const legacy = JSON.stringify({ feeds: { [URL_OF]: { seen: [[hashed("1"), 0]] } } });
  const result = await pollOf({ updated: "/updated_at" }, list({ id: 1, updated_at: "2026-06-01T00:00:00Z" }), legacy);
  assert.equal(result.events, undefined);
  // Rewritten, the set holds the real date: a later one fires.
  const later = await pollOf({ updated: "/updated_at" }, list({ id: 1, updated_at: "2026-06-02T00:00:00Z" }), result.cursor.cursor);
  assert.equal(later.events?.length, 1);
  assert.equal(later.events[0].body.update, true);
});

test("a JSON Feed item that was served with no date and gains one still fires an update, as before", async () => {
  const feedOf = (extra) => JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "F", items: [{ id: "a", url: "https://x.example/a", title: "A", ...extra }] });
  const events = await startThen({}, feedOf({}), feedOf({ date_modified: "2026-06-01T00:00:00Z" }));
  assert.equal(events.length, 1);
  assert.equal(events[0].body.update, true);
});
