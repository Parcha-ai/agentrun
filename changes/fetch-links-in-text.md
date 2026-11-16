---
packages: @parcha/agentrun-serve
kind: fix
---
A web_fetch page's `links` now hold the absolute URLs written out in its text, not only its markdown link targets. A page fetched directly that is not HTML lists the URLs in its body; it listed none before. That covers a JSON API, a plain-text file and an XML feed:
- a JSON body's URLs are read from its string values, so a Statuspage incident's `shortlink` or a search API hit's `url` counts
- any other body is read with its entities undone once, so an Atom entry's `<link href>` counts, and so does the escaped `&lt;a href=&quot;…&quot;&gt;` in its content, instead of a garbage link running to the next space
- a feed's namespace name (`xmlns`) is not a link

A page read through Parallel lists the URLs its markdown writes out as well as its link targets. A template eval's web fake gives a faked page the same links. An HTML page fetched directly keeps its link targets alone, as before. The same dedup, fragment removal, caps and `links_cut` count apply.

The eval link check matches a cited link from any of those bodies. Two more fixes there:
- A URL now ends at `|`, so a Slack-style `<https://x|text>` link is cited as `https://x`. A markdown link's target still runs to its `)`, so `[route](https://maps.example/?markers=a|b)` is cited whole, as a page's links read it.
- A call that is not a web call counts too: its urls are the URLs its result holds, a JSON string that is a URL whole counted whole (a calendar event's `htmlLink`). The check now shows when the answer cites a link and some call returned URLs, not only when the run made a web call. A grader reads only the head of such a result, so a link that matches nothing names a call whose result was cut, as it names a page whose links were cut.

Where a URL in text ends, which trailing punctuation is not its own, and where a markdown link's target ends are now one module, `text-urls.ts`. The link check, a page's links and the timeline's scrub all read through it. The scrub keeps going through a `|`, so a query value holding one is still elided whole.
