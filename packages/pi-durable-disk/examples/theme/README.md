# The robot demo's theme

One stylesheet and its fonts for the tab page (laptop and phone) and the stage. Tokens are agentrun.ai's dark palette (`#080809 / #111113 / #2c2c30 / #f2f2f2 / #a4a4ad`), accent orange `#ff8700` used once per screen
(the agent acting now), green for done, purple for a thread or GPU, Inter for text and JetBrains Mono for eyebrows, numbers and tool lines. No light mode, no red, no emoji.

- `theme.css`: tokens and components: `.eyebrow`, `.num` (+ `.u` for the unit), `.step`, `.dot` (`.act .done .gpu .run`), `.card`, `.chat` with `.turn.user` (right, plain) and `.turn.agent` (left), `.tool` (one quiet line, the
  result in a `<pre>` that opens on tap), `.composer` (16 px input, 44 px targets, safe-area bottom), `.btn` / `.btn.primary`, `.status`.
- `copy-theme.mjs`: `copyTheme(outDir, require)` writes `theme/theme.css`, `theme/fonts.css` and the font files (Inter 400/500/600, JetBrains Mono 400/500/700, latin woff2, OFL 1.1, from the `@fontsource` packages at
  build time: nothing binary is committed, the page needs no network). Call it from a page's build with a `require` made where `@fontsource/inter` and `@fontsource/jetbrains-mono` are installed.
- `preview.html`: the component sheet (open it next to a built `theme/` folder) used for the before/after screenshots.

A page links `theme/fonts.css` then `theme/theme.css` and sets only layout. Link them from the root (`/theme/...`) on a page served at `/run/<id>`, relative on a page served under a path (the stage).
