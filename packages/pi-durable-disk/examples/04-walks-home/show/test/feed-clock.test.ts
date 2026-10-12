import assert from "node:assert/strict";
import { test } from "node:test";
import { Feed } from "../page/feed.ts";
import { emptyState } from "../reduce.ts";

const at = (feed: Feed, now: number) => {
  feed.state = { ...emptyState(), now };
  (feed as unknown as { receivedAt: number }).receivedAt = performance.now();
};

test("the page's caption clock never goes backwards between events, so a note the page stamped is never left in the future", () => {
  const feed = new Feed();
  at(feed, 100_000);
  const a = feed.captionNow();
  // The next event on a quiet feed carries a time earlier than the clock had run to (the page clock ran on by wall time).
  at(feed, 99_000);
  assert.ok(feed.captionNow() >= a, "the clock holds");
});

test("a reset starts the clock over: a new run's time is its own", () => {
  const feed = new Feed();
  at(feed, 100_000);
  feed.captionNow();
  feed.resetClock();
  at(feed, 2_000);
  assert.ok(feed.captionNow() < 3_000);
});

test("each time the feed starts over it is a new generation, so what the page remembered about the old timeline is not mistaken for the new one", () => {
  const feed = new Feed();
  const first = feed.generation;
  feed.resetClock();
  assert.equal(feed.generation, first + 1);
  feed.resetClock();
  assert.equal(feed.generation, first + 2);
});

test("an event the page itself heard (the tab's) restarts the elapsed time: stamped from the caption clock, it is not counted again", async () => {
  const feed = new Feed();
  feed.state = { ...emptyState(), now: 1_000 };
  (feed as unknown as { receivedAt: number }).receivedAt = performance.now();
  await new Promise((r) => setTimeout(r, 60));
  const stamped = feed.captionNow();
  assert.ok(stamped >= 1_050, "the wall time since the last event is in the clock");
  feed.inject({ t: "net", at: stamped, net: { online: false, reason: null } });
  const after = feed.captionNow();
  assert.ok(after < stamped + 40, `the clock went on from the stamped time, not from it plus the elapsed time again (${stamped} then ${after})`);
});

test("every path that advances the page's time restarts the elapsed time from the event: fold (skills, landing) as inject (the tab's)", async () => {
  const feed = new Feed();
  feed.state = { ...emptyState(), now: 1_000 };
  (feed as unknown as { receivedAt: number }).receivedAt = performance.now();
  await new Promise((r) => setTimeout(r, 60));
  const stamped = feed.captionNow();
  feed.fold({ t: "thread", at: stamped, id: "walk", patch: { status: "learning" } });
  const after = feed.captionNow();
  assert.ok(after < stamped + 40, `fold went on from the stamped time, not from it plus the elapsed time again (${stamped} then ${after})`);
});
