---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A feed trigger: `{kind: "feed", urls, every_s?: 900, items?, id?, accept?}` starts a run for each new or updated item in 1 to 20 feeds, RSS, Atom, JSON Feed or a JSON list such as GitHub's pulls API (read at its `items` and `id` pointers). It polls, so nothing outside has to reach the server.
- It starts watching at its first poll, which a create or a turn-on runs at once and waits on (10 seconds at most); the items already there start no run, and the check says how many. Turning it on again forgets what it read.
- An item fires once, and again with `update: true` when its `updated` time moves on. Each URL keeps the keys it has seen (the larger of 1,000 and twice the feed's length) in the trigger's settings, with no store change. One poll starts 20 runs at most across all its URLs, oldest first, and the check says how many wait for the next. Reads are conditional on ETag and Last-Modified.
- A `410`, or a `404` three checks running, stops that URL and the check names it; the trigger turns itself off (`source_unreadable`) only when every URL has stopped.
- Reads are held to the MCP servers' address check (no private, link-local or own address; each of at most 5 redirects checked again), plain `http` on a public address only, 20 s and 5 MB at most, and no entity declared in a DTD (such a feed is refused in words; the trigger stays on). Only XML's five named references and numeric character references decode.
- The payload: `{id, link, title, published, updated, author, summary, categories, feed: {title, url}, update}` for a feed, `{id, link, title, item, update}` for a JSON list.
- Template packages may use feed triggers: `urls` takes parameters inside a URL, or one whole array parameter (required or with a default; given empty, apply skips the trigger with a `triggers.<i>` warning and the agent stands); `every_s`, `items` and `id` take none; `where` in values are filtered as the other kinds' are. A template eval case's `feed:` fixture serves fake feeds to the case's run and fires on its new or updated item. A triggered case, an email one included, now puts its mail or item in only once the trigger's first poll has read, so a slow first poll no longer takes it as part of the start.
- The generated clients and the console's types know the kind; the console lists a feed trigger with its words. Its form comes later.
- The parser is fast-xml-parser 4.5.7, pinned exact (198 kB unpacked, with strnum 1.1.2 at 19 kB).
