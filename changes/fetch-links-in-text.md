---
packages: @parcha/agentrun-serve
kind: fix
---
A web_fetch page's `links` now hold the absolute URLs written out in its text, not only its markdown link targets. A page fetched directly that is not HTML lists the URLs in its body; it listed none before. That covers a JSON API, a plain-text file and an XML feed:
- a JSON body's URLs are read from its string values, so a Statuspage incident's `shortlink` or a search API hit's `url` counts
- an Atom or RSS feed is read with its XML entities undone, so a release entry's `<link href>` counts

A page read through Parallel lists the URLs its markdown writes out as well as its link targets. A template eval's web fake gives a faked page the same links. So the eval link check now matches a cited link that came from a JSON or XML body. An HTML page fetched directly keeps its link targets alone, as before. The same dedup, fragment removal, caps and `links_cut` count apply. A URL is found and its trailing punctuation cut by the timeline's own rule (`TEXT_URL` and `urlEnd` in timeline/util.ts), which the link check now uses too. That rule now also keeps a closing bracket a URL opened (`/wiki/Foo_(bar)`) and leaves a trailing `*` outside the URL.
