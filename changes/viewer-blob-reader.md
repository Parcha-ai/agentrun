---
packages: repo
kind: fix
---
Every read of a recording's blobs in the viewer goes through one reader, so a page served with `connect-src 'self'` (a static host that sends a content-security policy, such as the docs site) reads an embedded recording: its blobs are `data:` URLs, which a page cannot `fetch` under that policy, so the run's cited result went unread and the right side showed the run's last message in place of its answer and cites, and an agent's page and its stylesheets did not load. The viewer now decodes a `data:` URL in the page and fetches any other URL as before. The chat view also never falls back silently: when the run's result cannot be read it says so on the right side, with the reason, and what follows is called the run's final message, not its answer; when the agent's page cannot be read it says so, with the reason, and the run's answer follows, labelled as such. The public gallery is a `--files` build on a host that sends no such policy and is not affected.
