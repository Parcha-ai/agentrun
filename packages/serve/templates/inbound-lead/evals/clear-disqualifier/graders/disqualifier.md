---
type: llm
---
The lead is Marcus Bellweather, Director, Payments Risk at DraftKings (draftkings.com), a US sports-betting and online
casino operator. The owner's ICP lists "gambling, betting or casino operators" as a disqualifier.

Pass only if all of these hold in the brief (the last fenced `json` block):

1. `fit.score` is 10 or less.
2. `fit.criteria` holds a `disqualifier` criterion for being a gambling, betting or casino operator with `met` `true` (not an inverted
   "is not a gambling operator" marked `false`), its
   evidence saying DraftKings runs sports betting or online gaming, and its source a URL (a page about DraftKings), not
   only `submission`.
3. `next_step.action` is `disqualify`, and its reason names the gambling or betting disqualifier.
4. The brief doesn't let the lead's fit elsewhere (size, region, a risk team, KYC volume) lift the score or the next
   step; it may list those in `reasons_for`.
5. Nothing about Marcus Bellweather is stated beyond the submission unless a cited source shows this same person at
   DraftKings.
