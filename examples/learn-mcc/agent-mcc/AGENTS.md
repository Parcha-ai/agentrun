# Rules

## The job

- The input is a merchant's name and website. The answer is the merchant's card-acceptance profile, as an acquirer
  would set it from what the merchant sells:
  - its MCC, the 4-digit ISO 18245 merchant category code a card network would assign it from what it sells, a code in
    mcc_codes, with that code's title;
  - its risk tier, low, medium or high, the tier the risk rubric gives it, with the rubric's reasons in at most 600
    characters;
  - the flags its own pages show, from the answer's list, and no flag they do not show;
  - what its website showed: live, unreachable, parked, or another business;
  - its confidence, from 0 to 1, that the MCC is the one a card network would assign;
  - evidence for the MCC, the tier and each flag.
- Finish by calling answer once, with 1 to 10 evidence items. Each names what it supports (the MCC, the risk tier, or a
  flag by its name), the page as you read it in this run, and that page's words, verbatim, at most 300 characters. The
  MCC's evidence is a page of the merchant's own site (or of the marketplace listing its website is) that says what it
  sells.
- How to do the job by hand, and the risk rubric, are the classify-merchant skill.

## Every run leaves the job cheaper

- When a part of the job repeats from merchant to merchant, write a workflow for that part and name it for what it
  does: reading the merchant's site, finding its policy pages, choosing the code from what it sells, tiering the risk
  by the rubric, sending a site that needs JavaScript to the browser. A workflow for the whole job,
  `merchant-mcc-risk`, runs the parts.
- When `<learned>` offers workflows, run them first with the agentrun tool: load one by name with this merchant's
  input, then run it.
  - When it completes, use what it returned and save nothing. Every clean run of the same revision counts toward
    trusting it, and a new revision starts that count again.
  - When it escalates or fails, do that part by hand. When you see what made it stop, fix that workflow under its own
    name: load it, change it, inspect it with this merchant's input, dry-run it, and save it under the same name.
- Write a new workflow only for a part that no offered workflow covers: call agentrun with describe, inspect the complete
  workflow with this merchant's input, dry-run it, and save it. Save only a workflow whose dry run passed, and never run
  a workflow you saved in this run: later runs try it.
- After a save, call learn with type workflow and the workflow's name as id. Its text says which inputs it fits, never
  what a page said.
- `merchant-mcc-risk` takes `{ "name", "website" }` and returns
  `{ "mcc", "mccDescription", "riskTier", "riskRationale", "flags", "siteStatus", "evidence", "confidence" }`, the
  answer's own shape.
- If no `merchant-mcc-risk` exists after your first run, write one for the whole job from steps: calls, extracts,
  judges, and narrow agent steps for the open-ended looking (they run on the cheap model). Embed parts into it as they
  are admitted.
- `<learned>` lists a workflow from its admission, on trial. Admitted includes trial: build on parts on trial now and
  do not wait for them to be promoted; `merchant-mcc-risk`'s own clean runs on trial are what earn its trust.
- Once workflows for parts are admitted (`<learned>` lists them), write `merchant-mcc-risk` from them: load each part
  and embed it as a `workflow` step, a complete inline child whose input comes from this job's input or earlier steps;
  cover the parts no workflow covers with call, extract or agent steps; return the answer's full shape. Inspect it with
  this merchant's input, dry-run it, and save it. A part takes this job's input or fields of it: a part whose input is
  something a run finds on the way (a policy page's URL) is never offered to a later run, so it cannot be embedded.
- When a part gets a new revision, write `merchant-mcc-risk` again with that revision embedded: a revised part does not
  reach `merchant-mcc-risk` until then.
- When `merchant-mcc-risk` escalates on a kind of merchant it does not handle yet, grow it rather than rework it: add a
  route for that kind (Jev picks the merchant's kind, then a branch for it), and keep the paths for the kinds it already
  handles as they are. Every branch leaves the values later steps read under the same names.
- When an offered workflow completes, use what it returned and save nothing, even when the answer looks wrong to you:
  a complete answer is not a reason to rewrite, only an escalation or a failure is. Saving a new revision after a
  complete run starts its trust over.
- When the host tells you the proven revision of a workflow escalated and a newer revision is on trial, load that
  workflow and run it first. Do the job by hand only if it escalates too. When it completes, use what it returned: its
  clean runs are what earn it trust. Fix it (a new revision) only after it escalates or fails, not before trying it.
- A workflow works for any merchant. Never put a merchant's name, domain, answer or a page's words in one. It reads with
  the job's tools, decides with pick, judge or route, and hands anything unsure back with escalate.
- A choice among listed options that needs knowledge the state does not hold (what a merchant's business is, for its
  MCC) is an agent node on the host's node model, given what it needs from the job's input and earlier steps. A choice
  decidable from evidence already in the state stays a Jev pick, judge or route, and Jev checks what the state can show.

## Notes

- When a line in `<learned>` helped, call learn with type used and its id. When this run shows a line in `<learned>` is
  wrong, call learn with type correction and the general rule. A coding convention you met (how card networks code a
  kind of business) is a lesson worth noting, in general words.
- A note states a general rule, never this merchant's name, site or answer.
- Give learn an id only to name a learning listed in `<learned>` or a workflow you saved; a new note has no id.
