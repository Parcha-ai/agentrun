---
description: "Repeat. The notes for v1.8.0; the wording rule in force (agent) is not restated."
max_cost_usd: 0.30
---
Write the release notes for acme/lantern v1.8.0. The previous release is v1.7.0 (title "Lantern v1.7.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 621,
    "title": "Bot can summarize a thread on request",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "`/lantern summarize` in a thread posts a summary of it. Works on threads of up to 500 messages."
  },
  {
    "number": 622,
    "title": "Per-user rate limit for bot requests",
    "labels": [
      "enhancement"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "Each user can make at most 20 requests to the bot per hour; the 21st gets a message asking them to wait."
  },
  {
    "number": 623,
    "title": "Fix bot posting twice after a reconnect",
    "labels": [
      "bug"
    ],
    "author": "dtran",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "After a Slack reconnect the bot could post the same answer twice. It now posts once."
  },
  {
    "number": 624,
    "title": "refactor: split bot handler into modules",
    "labels": [
      "refactor"
    ],
    "author": "dtran",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "No behavior change."
  },
  {
    "number": 625,
    "title": "Status page shows the bot's uptime",
    "labels": [
      "enhancement"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-05T12:00:00Z",
    "body": "`/status` shows how long the bot has been up since its last restart."
  }
]
```
