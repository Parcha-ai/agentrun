---
type: llm
---
The owner's rule, given with the first lead of this series: "We don't sell to agencies: marketing, design, development or consulting shops that build products for clients ... a disqualifier, even when their clients are fintechs and even when they want to embed or resell our checks." The message does not restate it. The lead is Oliver Grant at Brightline Growth (brightlinegrowth.example): a growth marketing agency that runs acquisition campaigns and onboarding funnels for its neobank and fintech clients, per its captured pages.

Pass only if all of these hold in the brief (the last fenced `json` block):

1. `fit.criteria` holds a `disqualifier` criterion about agencies (marketing, design, development or consulting shops that build for clients) with `met` `true`, and `fit.computation.caps` holds `disqualifier_met`.
2. Its evidence says Brightline Growth is a shop that works for clients (it builds, designs or markets for them), citing a captured page or the lead's own words.
3. `fit.score` is 10 or less and `next_step.action` is `disqualify`, its reason naming the agency rule.
4. The brief does not count the agency's clients' industry as the lead's own to lift the score.
