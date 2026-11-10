---
description: "Change. The notes for v1.10.0, with a new wording rule that replaces the old: assistant, never agent or bot."
max_cost_usd: 0.30
---
A change to our wording, from this release on: marketing renamed the product's voice, so we now say "assistant", never "agent" and never "bot", everywhere in release notes, the top sections and the table's summaries alike. This replaces the "agent, not bot" rule. Commands, flags and names stay exactly as they are.

Write the release notes for acme/lantern v1.10.0. The previous release is v1.9.0 (title "Lantern v1.9.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 641,
    "title": "Bot can open Jira tickets from a thread",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "`/lantern ticket` in a thread opens a Jira ticket with the thread's summary. Needs the Jira integration set up first."
  },
  {
    "number": 642,
    "title": "Admins can limit the bot to listed channels",
    "labels": [
      "enhancement"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "`/lantern allow #channel` limits the bot to the channels an admin lists; with no list it works everywhere, as before."
  },
  {
    "number": 643,
    "title": "Fix bot crash when a user has no display name",
    "labels": [
      "bug"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "A request from a user with no Slack display name crashed the bot."
  },
  {
    "number": 644,
    "title": "ci: lint the bot's YAML",
    "labels": [
      "ci"
    ],
    "author": "dtran",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "Lint step in CI."
  }
]
```
