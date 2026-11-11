---
description: "Repeat. The notes for v1.9.0; the wording rule in force (agent) is not restated."
max_cost_usd: 0.30
---
Write the release notes for acme/lantern v1.9.0. The previous release is v1.8.0 (title "Lantern v1.8.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 631,
    "title": "Bot answers DMs",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "You can now send the bot a direct message; it answers in the DM."
  },
  {
    "number": 632,
    "title": "Admins can export the bot's audit log as CSV",
    "labels": [
      "enhancement"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "`/lantern audit export` sends the admin a CSV of the bot's actions over the last 30 days."
  },
  {
    "number": 633,
    "title": "Fix time zone in bot reminders",
    "labels": [
      "bug"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "Reminders set with `/lantern remind` fired in UTC instead of the user's Slack time zone."
  },
  {
    "number": 634,
    "title": "docs: contributor guide for the bot",
    "labels": [
      "documentation"
    ],
    "author": "dtran",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "CONTRIBUTING.md for working on the bot."
  },
  {
    "number": 635,
    "title": "Breaking: bot needs the reactions:write scope",
    "labels": [
      "breaking"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-05T12:00:00Z",
    "body": "The bot now needs the Slack scope `reactions:write`. Reinstall the app from the Slack App Directory to grant it."
  }
]
```
