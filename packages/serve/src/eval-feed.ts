// A template eval case's fake feed (template-eval.ts `feed:`): its fixture, checked when the case is read, and each run's
// fake feeds on loopback (feed/feed-faux.ts), so no run of an eval reads a real feed. The first URL the package's feed
// trigger names is read from a fake serving the fixture's items; each other URL it names from an empty fake of the same
// format. The eval's own server reads them in place of those URLs (ServeOptions.feedsAt): the trigger, its payload and its
// words keep the package's URLs. The trigger's first poll, at the apply, takes its start on the fixture's items; the
// fixture's `item` is then added (or, when one there has its id, put in its place: an incident updated) and the trigger's
// next poll fires on it.
import { FEED_FORMATS, type FauxItem, type FeedFaux, type FeedFormat, startFeedFaux } from "./feed/feed-faux.js";
import { isObject } from "./validate.js";

/** A feed case's fixture: the feed's format, title and items before the run (newest first), the new or updated item the
 *  run is started on, and the package's trigger that starts it when it has more than one feed trigger. */
export type FeedFixture = { description?: string; format: FeedFormat; title?: string; items: FauxItem[]; item: FauxItem; trigger: string };

const FIXTURE_FIELDS = ["description", "format", "title", "items", "item", "trigger"];

/** `value` read as a feed fixture, each problem through `bad` in words naming `at`; undefined when one does not read. Its
 *  `trigger` is filled in by the caller, from the package. */
export function feedFixtureOf(value: unknown, at: string, bad: (message: string) => void): (Omit<FeedFixture, "trigger"> & { trigger?: string }) | undefined {
  if (!isObject(value)) return bad(`${at}: a feed fixture is {description?, format, title?, items, item, trigger?}`), undefined;
  let ok = true;
  const no = (message: string) => ((ok = false), bad(`${at}: ${message}`));
  for (const key of Object.keys(value).filter((key) => !FIXTURE_FIELDS.includes(key))) no(`no field ${key}: its fields are ${FIXTURE_FIELDS.join(", ")}`);
  if (value.description !== undefined && typeof value.description !== "string") no("description is text");
  if (!FEED_FORMATS.includes(value.format as FeedFormat)) no(`format is ${FEED_FORMATS.slice(0, -1).join(", ")} or ${FEED_FORMATS.at(-1)}`);
  if (value.title !== undefined && typeof value.title !== "string") no("title is the feed's own title, text");
  if (!Array.isArray(value.items) || !value.items.every(isObject)) no("items is the feed's items before the run, newest first, each an object");
  if (!isObject(value.item)) no("item is the new or updated item the run is started on: an object (one with an id of the items' replaces it)");
  if (value.trigger !== undefined && (typeof value.trigger !== "string" || !value.trigger)) no("trigger is the name of the package's feed trigger that starts the run");
  if (!ok) return undefined;
  return {
    ...(typeof value.description === "string" ? { description: value.description } : {}), format: value.format as FeedFormat, ...(typeof value.title === "string" ? { title: value.title } : {}),
    items: value.items as FauxItem[], item: value.item as FauxItem, ...(typeof value.trigger === "string" ? { trigger: value.trigger } : {}),
  };
}

/** One run's fake feeds: where each of the trigger's URLs is read from (`route`), the fixture's item put on the first
 *  (`deliver`), and their close. */
export type CaseFeeds = { route(url: string): string | undefined; deliver(): void; close(): Promise<void> };

/** The fake feeds of one run of a case on `fixture`, for a trigger that reads `urls` (its first the fixture's) and, for a
 *  JSON list, its items at `under`. */
export async function caseFeeds(fixture: FeedFixture, urls: readonly string[], under?: string): Promise<CaseFeeds> {
  const fakes = new Map<string, FeedFaux>();
  try {
    for (const [i, url] of urls.entries()) {
      fakes.set(url, await startFeedFaux({ format: fixture.format, ...(fixture.title !== undefined ? { title: fixture.title } : {}), items: i === 0 ? fixture.items : [], ...(fixture.format === "json-list" && under ? { under } : {}) }));
    }
  } catch (error) {
    for (const fake of fakes.values()) await fake.close();
    throw error;
  }
  const first = fakes.get(urls[0]!)!;
  return {
    route: (url) => fakes.get(url)?.url,
    deliver() {
      const id = (fixture.item as { id?: unknown }).id;
      if (id !== undefined && first.items().some((one) => (one as { id?: unknown }).id === id)) first.update(fixture.item);
      else first.add(fixture.item);
    },
    async close() {
      for (const fake of fakes.values()) await fake.close();
    },
  };
}
