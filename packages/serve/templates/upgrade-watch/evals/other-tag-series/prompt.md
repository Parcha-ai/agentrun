---
description: The repository tags two products. Its newest release is of the other one (a CLI), while the owner already runs the newest release of the series they use. The report says up to date and does not take the other product's tag for a newer version.
runs: 3
max_cost_usd: 0.50
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com, api.github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what
their URLs return today; use them in place of fetching.

--- https://api.github.com/repos/example-org/widget/releases/latest (fetched 2026-11-09) ---
{ "tag_name": "cli-v1.9.0", "name": "widget-cli 1.9.0", "prerelease": false, "published_at": "2026-11-08T09:00:00Z" }

--- https://api.github.com/repos/example-org/widget/releases?per_page=10 (fetched 2026-11-09) ---
[
  { "tag_name": "cli-v1.9.0", "name": "widget-cli 1.9.0", "published_at": "2026-11-08T09:00:00Z", "body": "### Removed\n- `widget-cli login --port` is removed. Use `--listen`." },
  { "tag_name": "v2.5.0", "name": "v2.5.0", "published_at": "2026-11-05T10:12:00Z", "body": "### Added\n- `widget serve --tls-cert` and `--tls-key` serve over HTTPS." },
  { "tag_name": "cli-v1.8.0", "name": "widget-cli 1.8.0", "published_at": "2026-10-28T09:00:00Z", "body": "### Fixed\n- Login retries once on a timeout." },
  { "tag_name": "v2.4.0", "name": "v2.4.0", "published_at": "2026-10-20T08:30:00Z", "body": "### Fixed\n- `widget serve` logs its data directory at start." }
]
