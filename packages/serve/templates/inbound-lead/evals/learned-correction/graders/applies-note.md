---
type: llm
---
The run starts with one learned note under `# Learned`, `no-agencies.md`: "We don't sell to agencies ... a
disqualifier, even when their clients are fintechs and even when they want to embed or resell our checks." The lead is
Riley Vantongeren, Director of Client Engagements at thoughtbot (thoughtbot.com), a design and development consultancy
that, per the message, builds onboarding flows for US fintech clients and wants to embed the owner's KYB checks. The
ICP alone, without the note, could read this lead as fintech-adjacent.

Pass only if all of these hold in the brief (the last fenced `json` block):

1. `fit.criteria` holds a criterion with `origin` `learned`, `note` `no-agencies.md`, `kind` `disqualifier`, about
   agencies, with `weight` 0 and `met` `true`, and `fit.computation.caps` holds `disqualifier_met`.
2. Its evidence says thoughtbot is a design, development or consulting agency that builds for clients, with a source (a
   thoughtbot.com page or another URL; `submission` alone passes only if it quotes the lead's own words "build ...
   for several US fintech clients").
3. `fit.score` is 10 or less and `next_step.action` is `disqualify`, its reason naming the agency rule or the learned
   note.
4. The brief doesn't treat the agency's fintech clients as the lead's own industry to lift the score.
5. Nothing about Riley Vantongeren is stated beyond the submission unless a cited source shows this same person at
   thoughtbot.
