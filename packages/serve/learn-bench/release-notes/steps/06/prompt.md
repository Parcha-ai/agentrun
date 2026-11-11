---
description: "Repeat. The notes for v1.11.0; the wording rule in force (assistant) is not restated."
max_cost_usd: 0.30
---
Write the release notes for acme/lantern v1.11.0. The previous release is v1.10.0 (title "Lantern v1.10.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 651,
    "title": "Bot replies in the user's language",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "The bot answers in the language the question was asked in: English, Spanish, French or German."
  },
  {
    "number": 652,
    "title": "Status page: per-channel request counts",
    "labels": [
      "enhancement"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "`/status` shows how many requests the bot got in each channel this week."
  },
  {
    "number": 653,
    "title": "Fix: bot lost thread context after 100 replies",
    "labels": [
      "bug"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "In a thread with more than 100 replies the bot answered as if the thread had just started."
  },
  {
    "number": 654,
    "title": "test: more bot integration tests",
    "labels": [
      "tests"
    ],
    "author": "dtran",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "More tests."
  }
]
```
