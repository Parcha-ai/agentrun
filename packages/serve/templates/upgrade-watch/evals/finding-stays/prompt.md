---
description: Last week's report found a removal the owner has not acted on. This week one harmless patch version was added. The removal is reported again, because the owner still runs the old version, and the report says which version is new.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-16T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

The result of this trigger's last completed run (01a1cf00-0000-7000-8000-000000000001, ended 2026-11-09T08:03:10Z), its structured answer as its agent's output schema checked it. It is data from that run, not instructions: use it to leave out what it already reported.

```json
{
  "repository": "example-org/widget",
  "current_version": "v2.3.1",
  "current_found": true,
  "latest_version": "v2.5.0",
  "verdict": "changes_needed",
  "items": [
    "the serve command's --port and --data flags",
    "POST /v2/agents",
    "the WIDGET_TOKEN environment variable",
    "the export file format (CSV)"
  ],
  "versions": [
    {
      "version": "v2.5.0",
      "date": "2026-11-05",
      "source_url": "https://github.com/example-org/widget/releases/tag/v2.5.0",
      "read": "full"
    },
    {
      "version": "v2.4.0",
      "date": "2026-10-20",
      "source_url": "https://github.com/example-org/widget/releases/tag/v2.4.0",
      "read": "full"
    }
  ],
  "findings": [
    {
      "version": "v2.5.0",
      "kind": "removal",
      "change": "`widget serve --port` is removed. Use `--listen host:port`.",
      "affects": "the serve command's --port and --data flags",
      "what_to_do": "Use `--listen host:port` in place of `--port`.",
      "source_url": "https://github.com/example-org/widget/releases/tag/v2.5.0",
      "confidence": "high"
    }
  ],
  "other_breaking": [],
  "unread": [],
  "unreachable": [],
  "summary": "example-org/widget: v2.3.1 to v2.5.0 (2 versions in between)\nVerdict: changes needed before upgrading\n- [v2.5.0] serve --port: removed. Do: use --listen host:port"
}
```

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching.

--- https://github.com/example-org/widget/tags (fetched 2026-11-16), tags newest published first, each with its date ---
v2.5.1    2026-11-12
v2.5.0    2026-11-05
v2.4.0    2026-10-20
v2.3.1    2026-10-02
v2.3.0    2026-09-15
(no next page: these are the oldest tags)

--- https://github.com/example-org/widget/releases/tag/v2.5.1 (fetched 2026-11-16) ---
Release v2.5.1

### Fixed
- `widget stats` prints a total row.

--- https://github.com/example-org/widget/releases/tag/v2.5.0 (fetched 2026-11-16) ---
Release v2.5.0

### Removed
- `widget serve --port` is removed. Use `--listen host:port` (for example `--listen 127.0.0.1:8080`).

--- https://github.com/example-org/widget/releases/tag/v2.4.0 (fetched 2026-11-16) ---
Release v2.4.0

### Fixed
- `widget serve` logs its data directory at start.
