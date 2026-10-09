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
