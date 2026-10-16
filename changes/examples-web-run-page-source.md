---
packages: repo
kind: feature
---
The `examples/web` run page reads only through a `RunSource`, so the same page shows a live server's runs (`httpSource`) and a replay from static files (`staticSource`). `mountRunPage(root, source)` shows the ways to act and the live browser only when the source has them, and builds no absolute URL, so it works under any path. `writeReplay` is the one writer of a replay's static layout, refusing ids and file paths a page could not ask for, a summary for another id and runs whose paths collide, and swapping the new replay in so a failed write leaves the old one whole, and `pack-page.mjs` writes the self-contained replay page with its Content-Security-Policy in a meta tag. A replay names a dollar figure only for a recording whose manifest says its providers are `real`: otherwise its cost is `null`, its usage rows count model requests with no amount, and the page's header shows no figure.
