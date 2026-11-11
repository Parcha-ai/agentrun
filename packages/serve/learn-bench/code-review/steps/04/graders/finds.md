---
type: llm
---
Pass only if no finding of severity `important` is about line 8's `paid_at` timestamp or its format: `formatUtc` is the
repo's own UTC formatter and is used as the repo asks. A finding about something else (for example `payout` being
undefined for an unknown id, marked `pre-existing`) does not change the verdict.
