---
description: "Repeat. The notes for v1.7.0; the wording rule in force (agent) is not restated."
max_cost_usd: 0.30
---
Write the release notes for acme/lantern v1.7.0. The previous release is v1.6.0 (title "Lantern v1.6.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 611,
    "title": "Bot reacts with an emoji when it picks up a request",
    "labels": [
      "enhancement"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "The bot adds :eyes: to a message when it starts working on it, so people know it saw the request."
  },
  {
    "number": 612,
    "title": "Admins can set the bot's display name",
    "labels": [
      "enhancement"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "`/lantern name <text>` sets the name the bot posts under in this workspace. Admins only."
  },
  {
    "number": 613,
    "title": "Fix: bot ignored mentions in edited messages",
    "labels": [
      "bug"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "Editing a message to add a mention of the bot did nothing. An edit that adds a mention now triggers the bot."
  },
  {
    "number": 614,
    "title": "deps: bump slack-sdk to 3.31",
    "labels": [
      "dependencies"
    ],
    "author": "dtran",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "Routine dependency bump."
  },
  {
    "number": 615,
    "title": "Status page lists the channels the bot is in",
    "labels": [
      "enhancement"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-05T12:00:00Z",
    "body": "`/status` now lists every channel the bot is a member of, with when it last posted there."
  }
]
```
