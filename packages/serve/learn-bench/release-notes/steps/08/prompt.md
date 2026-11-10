---
description: "Repeat. The notes for v1.13.0; the wording rule in force (assistant) is not restated."
max_cost_usd: 0.30
---
Write the release notes for acme/lantern v1.13.0. The previous release is v1.12.0 (title "Lantern v1.12.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 671,
    "title": "Bot can post a recurring thread summary",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "`/lantern summarize every friday` posts the thread's summary each Friday at 9:00 in the channel's time zone."
  },
  {
    "number": 672,
    "title": "Status page shows the last 10 bot errors",
    "labels": [
      "enhancement"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "`/status` lists the bot's last 10 errors instead of only the last one."
  },
  {
    "number": 673,
    "title": "Fix /lantern unmute in private channels",
    "labels": [
      "bug"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "Unmuting the bot in a private channel failed with `not_in_channel`."
  },
  {
    "number": 674,
    "title": "Remove the deprecated /lantern help-old command",
    "labels": [
      "breaking"
    ],
    "author": "dtran",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "`/lantern help-old` is gone; use `/lantern help`."
  }
]
```
