---
description: A newer release exists, but its notes cannot be read (no changelog, the release list rate limited). The report says incomplete and names what it could not read; it never says safe.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com, api.github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what
their URLs return today; use them in place of fetching.

--- https://api.github.com/repos/example-org/widget/releases/latest (fetched 2026-11-09) ---
{ "tag_name": "v2.5.0", "name": "v2.5.0", "prerelease": false, "published_at": "2026-11-05T10:12:00Z" }

--- https://raw.githubusercontent.com/example-org/widget/v2.5.0/CHANGELOG.md (fetched 2026-11-09) ---
404: Not Found

--- https://api.github.com/repos/example-org/widget/releases?per_page=10 (fetched 2026-11-09) ---
{ "message": "API rate limit exceeded for this address.", "documentation_url": "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api", "status": "403" }

--- https://api.github.com/repos/example-org/widget/releases/tags/v2.5.0 (fetched 2026-11-09) ---
{ "message": "API rate limit exceeded for this address.", "documentation_url": "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api", "status": "403" }
