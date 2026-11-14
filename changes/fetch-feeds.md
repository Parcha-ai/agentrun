---
packages: @parcha/pi-browser
kind: fix
---
web_fetch reads a site's feeds: a reply of type `application/<name>+xml` or `application/<name>+json` (`application/atom+xml`, `application/rss+xml`, `application/ld+json`) is text, read as it came.
- GitHub's `releases.atom` and `commits.atom` were refused as "not text", so an agent could not read a public repository's releases or commits that way. The rule is the same on every harness: claude-agent and codex run pi's web_fetch.
- Every other non-text type (a PDF, a zip, `application/octet-stream`, an `image/svg+xml`) is still refused.
