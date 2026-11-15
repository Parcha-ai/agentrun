---
packages: @parcha/agentrun-serve
kind: fix
---
A web_fetch page's `links` now hold the absolute URLs written out in its text, not only its markdown link targets. A page fetched directly that is not HTML (a JSON API, a plain-text file) lists the URLs in its body; for JSON, those in its string values, so a Statuspage incident's `shortlink` or a search API hit's `url` is one. It listed none before. A page read through Parallel lists the URLs its markdown writes out as well as its link targets. A template eval's web fake gives a faked page the same links. So the eval link check matches a cited link that came from a JSON body. An HTML page fetched directly keeps its link targets alone, as before. The same dedup, fragment removal and caps apply.
