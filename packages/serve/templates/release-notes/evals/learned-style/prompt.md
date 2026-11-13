---
description: "The owner's preference \"agent, not bot\" lives only in a seeded learned note, never in the message; PR titles and bodies say bot throughout, and the draft never does. Pass: 3 of 3."
runs: 3
max_cost_usd: 0.15
---
Write the release notes for acme/lantern v1.6.0. The previous release is v1.5.0 (title "Lantern v1.5.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 601,
    "title": "Slack bot answers in threads",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "The bot now replies in the thread where it was mentioned, instead of in the channel."
  },
  {
    "number": 602,
    "title": "bot: retry Slack posts on rate limit",
    "labels": [
      "bug"
    ],
    "author": "dtran",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "When Slack answered 429, the bot dropped the message. It now waits for `Retry-After` and posts again, up to 3 times."
  },
  {
    "number": 603,
    "title": "Let admins mute the bot per channel",
    "labels": [
      "enhancement"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "`/lantern mute` in a channel stops the bot posting there; `/lantern unmute` undoes it. Admins only."
  },
  {
    "number": 604,
    "title": "Bot status page shows the last error",
    "labels": [
      "enhancement"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "The status page at `/status` shows the bot's last error and when it happened."
  },
  {
    "number": 605,
    "title": "ci: run the bot's integration tests nightly",
    "labels": [
      "ci"
    ],
    "author": "dtran",
    "merged_at": "2026-11-05T12:00:00Z",
    "body": "Nightly workflow for the Slack bot integration tests."
  },
  {
    "number": 606,
    "title": "Fix bot crash on empty message",
    "labels": [
      "bug"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-06T12:00:00Z",
    "body": "A Slack message with only an attachment and no text crashed the bot."
  }
]
```
