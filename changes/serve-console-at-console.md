---
packages: @parcha/agentrun-serve
kind: feature
---
The server answers its console (`apps/console`) at `/console/` on its own origin, with the page's CSP and security headers; `/console` redirects there. The console's files are public, like the page's, and its `/v2` calls hold the owner's session the same way. The page at `/` is unchanged.
- The server's build copies `apps/console/dist` (its `index.html` and hashed `assets/`, never a source map) into `dist/console` when the console was built first (`npm ci && npm run build` in `apps/console`). It refuses an `index.html` with an inline script or style, which the CSP would block, or an absolute `src` or `href`. A server built without the console answers `/console/` with a 404 that says so.
- `index.html` is `no-store`; the hashed assets are cached for a year. A path with a dot segment, a percent-encoding or a hidden file, a link out of the console's directory, or a kind of file Vite does not build is a 404.
- The image builds the console into the server's dist and keeps none of its sources or dependencies. `startServe({ console })` points the server at another built console.
