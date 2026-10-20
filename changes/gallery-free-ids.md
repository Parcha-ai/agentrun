---
packages: repo
kind: feature
---
**The gallery takes a recording that names no example under an id of its own, and shows three utility-account browser replays**
- A recording whose manifest names an example (its `example`, else a `task` that is an example folder's name) is still that example's: its id is the folder's name, one recording per example, so a re-take replaces it. A recording that names none (its `example` absent or null, its task free text, as in a browser session's replay) may take any id of the lock's form except an example folder's name, so an example's id only ever holds that example's own run. `scripts/recording/gallery.mjs` refuses `<id>: is the example folder examples/<id>, but its manifest names no example`; without the folder list, the check is as before.
- The gallery's lock names a new asset, `recordings-6.tar`: the three recordings it held, byte for byte, and three replays of a browser agent at a utility account (`utility-bills`, `utility-amount-owed`, `utility-last-payment`).
