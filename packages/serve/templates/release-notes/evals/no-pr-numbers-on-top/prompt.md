---
description: PR titles and bodies full of #numbers; no PR or issue number, and no PR link, appears above "Changes by pull request".
runs: 3
max_cost_usd: 0.15
---
Write the release notes for acme/lantern v1.4.1. The previous release is v1.4.0 (title "Lantern v1.4.0"; it credits no authors). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 301,
    "title": "Fix #87: crash on empty config",
    "labels": [
      "bug"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-01T12:00:00Z",
    "body": "Closes #87. An empty `lantern.toml` crashed startup; it is now read as no config at all."
  },
  {
    "number": 302,
    "title": "Add `--max-count N` (#90)",
    "labels": [
      "enhancement"
    ],
    "author": "dtran",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "Resolves #90. `lantern search --max-count N` stops after N matches in each file."
  },
  {
    "number": 303,
    "title": "Follow-up to #302: show --max-count in --help",
    "labels": [
      "docs"
    ],
    "author": "dtran",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": ""
  },
  {
    "number": 304,
    "title": "Treat #-prefixed lines in searches.toml as comments",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "Lines starting with `#` in `searches.toml` are now comments, instead of being read as a saved search named `#`."
  },
  {
    "number": 305,
    "title": "Bump regex to 1.11.1 (RUSTSEC-2026-0012)",
    "labels": [
      "dependencies",
      "security"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-05T12:00:00Z",
    "body": "Upgrades the regex crate to 1.11.1, which fixes RUSTSEC-2026-0012: a crafted pattern could take exponential time. Lantern compiles the patterns users type, so such a search pattern could hang `lantern search`. See also #301."
  }
]
```
