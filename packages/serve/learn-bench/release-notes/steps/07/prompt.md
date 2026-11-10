---
description: "Repeat. The notes for v1.12.0; the wording rule in force (assistant) is not restated."
max_cost_usd: 0.30
---
Write the release notes for acme/lantern v1.12.0. The previous release is v1.11.0 (title "Lantern v1.11.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 661,
    "title": "Bot can be paused for maintenance",
    "labels": [
      "enhancement"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "`/lantern pause` stops the bot answering in every channel until `/lantern resume`; meanwhile it replies with a maintenance note. Admins only."
  },
  {
    "number": 662,
    "title": "Bot shows a typing indicator while working",
    "labels": [
      "enhancement"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "While the bot works on an answer, Slack shows it as typing."
  },
  {
    "number": 663,
    "title": "Fix duplicate Jira tickets from /lantern ticket",
    "labels": [
      "bug"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "Running `/lantern ticket` twice in a thread opened two tickets; the bot now links the existing one."
  },
  {
    "number": 664,
    "title": "chore: bump node to 24",
    "labels": [
      "build"
    ],
    "author": "dtran",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "Runtime bump."
  }
]
```
