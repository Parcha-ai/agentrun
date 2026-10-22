---
packages: repo
kind: fix
---
**The chat view puts its dark palette only over an agent's page that declares it supports dark**
- An agent's page whose own color-scheme names `dark` (a `meta name="color-scheme"`, the root element's style, or a `:root` or `html` rule in its style elements, read with the browser's CSS parser) is drawn in the site's dark palette, as before; the report skill's pages declare `light dark`, so they look as they did.
- Any other page is drawn as its author wrote it: no forced background, colour, color-scheme or palette variables. A page that sets a light background and leaves its text at the default (a table header `th{background:#eee}`) was white on light grey; it now keeps its own contrast. Square corners and the site's type still go over every page.
