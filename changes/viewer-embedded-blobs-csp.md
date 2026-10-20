---
packages: repo
kind: fix
---
The chat view reads an embedded recording's blobs under `connect-src 'self'`, as the docs site serves it. The gallery embeds a recording's blobs as `data:` URLs, and the page `fetch`ed them, which that policy blocks: the run's cited result went unread and the right side showed the run's last message instead of its answer and cites, and an agent's page and its stylesheets did not load. A `data:` URL is now decoded in the page; any other URL is fetched as before.
