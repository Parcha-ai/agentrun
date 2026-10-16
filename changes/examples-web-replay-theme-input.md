---
packages: repo
kind: feature
---
**`examples/web`: a replay page's theme, folded long messages and the job's input**
- `pack-page.mjs <outDir> --theme auto|light|dark` (and `packPage`'s `theme` option) writes the theme into the packed bootstrap as a `replay-theme` meta tag, which `replay.js` hands to `mountRunPage`, so a host ships no script of its own. A theme the page does not draw in is refused before anything is written.
- A user message over 600 characters or 8 lines shows its first 600 characters or 8 lines and a "Show the whole message" button (`aria-expanded`), in the live page and in a replay; the state survives a repaint.
- `writeReplay` writes a recording's job blob `input` on the run record (not the history's summaries), checking the manifest's `job.sha256` against the blob's bytes and refusing a mismatch or a blob that is not a JSON object. The page shows the run's first message as "Input", the input pretty-printed, with the message the agent got behind a "Show the message the agent got" button.
