---
description: 10 merged PRs, with a revert pair, internal-only PRs and one with no description; the table lists each PR exactly once.
runs: 3
max_cost_usd: 0.20
---
Write the release notes for acme/lantern v1.5.0. The previous release is v1.4.1 (title "Lantern v1.4.1"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 401,
    "title": "Retry webhooks with backoff",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-10-12T12:00:00Z",
    "body": "Failed `lantern notify` webhooks are retried 3 times with exponential backoff."
  },
  {
    "number": 402,
    "title": "Add `--dry-run` to `lantern prune`",
    "labels": [
      "enhancement"
    ],
    "author": "osei-a",
    "merged_at": "2026-10-13T12:00:00Z",
    "body": "`lantern prune --dry-run` lists the index files it would delete and deletes nothing."
  },
  {
    "number": 403,
    "title": "Revert \"Retry webhooks with backoff\"",
    "labels": [],
    "author": "mira-k",
    "merged_at": "2026-10-14T12:00:00Z",
    "body": "Reverts #401. The retries flooded a receiver that was slow, not down. Backing out until there is a cap."
  },
  {
    "number": 404,
    "title": "Config paths with spaces",
    "labels": [
      "bug"
    ],
    "author": "dtran",
    "merged_at": "2026-10-15T12:00:00Z",
    "body": "`--config \"My Logs/lantern.toml\"` failed with \"file not found\". Paths with spaces now work."
  },
  {
    "number": 405,
    "title": "docs: fix a typo in CONTRIBUTING.md",
    "labels": [
      "docs"
    ],
    "author": "jules-p",
    "merged_at": "2026-10-16T12:00:00Z",
    "body": ""
  },
  {
    "number": 406,
    "title": "test: retry the flaky watcher tests",
    "labels": [
      "tests"
    ],
    "author": "dtran",
    "merged_at": "2026-10-17T12:00:00Z",
    "body": "The watcher tests time out on slow CI runners; retry them twice."
  },
  {
    "number": 407,
    "title": "refactor: split search.rs into modules",
    "labels": [
      "refactor"
    ],
    "author": "osei-a",
    "merged_at": "2026-10-18T12:00:00Z",
    "body": "No behaviour change."
  },
  {
    "number": 408,
    "title": "Bump tokio from 1.40.0 to 1.40.1",
    "labels": [
      "dependencies"
    ],
    "author": "jules-p",
    "merged_at": "2026-10-19T12:00:00Z",
    "body": "Patch release, no API changes."
  },
  {
    "number": 409,
    "title": "Read default flags from `LANTERN_OPTS`",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-10-20T12:00:00Z",
    "body": "Default flags can be set in the `LANTERN_OPTS` environment variable. Flags on the command line win over it."
  },
  {
    "number": 410,
    "title": "Tweak spinner",
    "labels": [],
    "author": "osei-a",
    "merged_at": "2026-10-21T12:00:00Z",
    "body": ""
  }
]
```
