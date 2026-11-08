---
description: "A PR whose title reads like a tidy-up, and a chore: bump dependency PR, each carry a breaking change only in their change fragment; an Upgrading line for each says what a user must do. Pass: 3 of 3."
runs: 3
max_cost_usd: 0.15
---
Write the release notes for acme/lantern v2.0.0. The previous release is v1.4.0 (title "Lantern v1.4.0"; it credits no authors). The repo keeps change fragments in `changes/`; each PR's fragment, read at its merge commit, is in its `fragment` field (PR 204 has none). These are all the pull requests merged in the range; there is no GitHub access in this run, so work from this list only.

```json
[
  {
    "number": 201,
    "title": "Tidy CLI flag names",
    "labels": [
      "cleanup"
    ],
    "author": "dtran",
    "merged_at": "2026-11-02T12:00:00Z",
    "body": "Makes flag names consistent across commands.",
    "fragment": {
      "path": "changes/output-flag.md",
      "text": "---\nkind: breaking\n---\n`lantern search --out FILE` is now `lantern search --output FILE`, the same as `lantern export`. `--out` is no longer accepted: it fails with \"unknown flag: --out\". Rename it in your scripts."
    }
  },
  {
    "number": 202,
    "title": "Show progress while indexing",
    "labels": [
      "enhancement"
    ],
    "author": "mira-k",
    "merged_at": "2026-11-03T12:00:00Z",
    "body": "Adds a progress bar.",
    "fragment": {
      "path": "changes/index-progress.md",
      "text": "---\nkind: feature\n---\n`lantern index` shows a progress bar when its output is a terminal."
    }
  },
  {
    "number": 203,
    "title": "Fix double overwrite prompt",
    "labels": [
      "bug"
    ],
    "author": "osei-a",
    "merged_at": "2026-11-04T12:00:00Z",
    "body": "",
    "fragment": {
      "path": "changes/export-prompt-once.md",
      "text": "---\nkind: fix\n---\n`lantern export --output FILE` asked twice before overwriting an existing file; it now asks once."
    }
  },
  {
    "number": 204,
    "title": "test: snapshot tests for export",
    "labels": [
      "tests"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-05T12:00:00Z",
    "body": "Adds snapshot tests for `lantern export`. No behaviour change."
  },
  {
    "number": 205,
    "title": "chore: bump toml_edit from 0.22 to 0.23",
    "labels": [
      "dependencies",
      "chore"
    ],
    "author": "jules-p",
    "merged_at": "2026-11-06T12:00:00Z",
    "body": "Bumps toml_edit from 0.22 to 0.23.",
    "fragment": {
      "path": "changes/toml-duplicate-keys.md",
      "text": "---\nkind: breaking\n---\nA `lantern.toml` with the same key twice in one table is now refused at start, with \"duplicate key `<name>`\"; before, the last value won silently. Remove the duplicate keys from your `lantern.toml` before you upgrade."
    }
  }
]
```
