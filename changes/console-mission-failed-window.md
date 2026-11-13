---
packages: repo
kind: fix
---
Console: Mission Control's Failed tile counts the same runs as Needs you's Failed list beside it, the failures of the last 24 h (imported history left out), and both say so ("Failed · last 24 h", "Failed in the last 24 h · 4"), each with a link to every failed run under the server's own count ("See all 10", "All 10 failed runs"). Before, the tile counted every failed run while the list counted the last day's. A run that fails while the page is open reads the failed total again, once, so "See all" keeps up with the list. The Active tile, which counts queued, working and paused runs, says how many are running now when that differs from what Running now lists.
