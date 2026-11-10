---
packages: @parcha/agentrun-serve
kind: fix
---
Template follow-ups after launch:
- `release-notes` makes its own GitHub trigger: each release published on the repository it was applied to starts its notes (only that repository's). Applied where GitHub is not connected, the agent is made and the trigger is skipped with a warning.
- A skipped GitHub trigger's warning says what it would run on, in the template's own words ("…so it runs by itself: Release notes runs on each release to acme/widgets."), never "review pull requests" for every template.
- New eval cases: `code-review/mentions-defused` (a review of a PR whose body and diff mention people and a team posts no plain @-mention) and `kyb/opensanctions-on` (with OpenSanctions on, its pages are an index cited as aggregators, the list owners' records stay the evidence, and the licence is stated); `kyb/clean-public-company` checks that with it off, opensanctions.org is never touched.
