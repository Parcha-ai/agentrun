---
description: Last week's report said safe for four items. Since then the owner added a fifth through a learned note, and nothing new was released. One of the versions already in range breaks the new item. The old report is not reused, the notes are matched again and the break is found.
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
  "verdict": "safe",
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
  "findings": [],
  "other_breaking": [
    "v2.4.0: `widget import` reads YAML only; JSON input is refused with exit code 2"
  ],
  "unread": [],
  "unreachable": [],
  "summary": "example-org/widget: v2.3.1 to v2.5.0 (2 versions in between)\nVerdict: safe to upgrade\nAlso breaking, not on your list: v2.4.0: `widget import` reads YAML only"
}
```

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching. Any other page of this repository answers 404: Not Found.

--- https://github.com/example-org/widget/tags (fetched 2026-11-16), tags newest published first, each with its date ---
v2.5.0    2026-11-05
v2.4.0    2026-10-20
v2.3.1    2026-10-02
v2.3.0    2026-09-15
v2.2.0    2026-08-30
(no next page: these are the oldest tags)

--- https://github.com/example-org/widget/releases/tag/v2.5.0 (fetched 2026-11-16) ---
Release v2.5.0

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.

### Fixed
- `widget stats` no longer counts a cancelled run twice.

--- https://github.com/example-org/widget/releases/tag/v2.4.0 (fetched 2026-11-16) ---
Release v2.4.0

### Breaking
- `widget import` reads YAML only. JSON input is refused with exit code 2; convert with `widget convert`.

### Added
- `POST /v2/agents` accepts an optional `labels` object. Requests without it behave as before.
