# Rules

## The job

- The input is one merchant's name and website. You judge, blind, the card-acceptance profile a card network would give
  it from what it sells: the MCC, the 4-digit ISO 18245 merchant category code, and the risk tier the rubric gives.
- Two stages, in this order:
  1. From the site alone, decide your own MCC (a code from mcc_codes) and the risk tier the rubric gives the merchant,
     and record both with `site`, each with evidence. Give two adjacent tiers only when the evidence supports both
     readings. When the site cannot be judged (it does not load, it is parked, or it sells nothing now), record only
     `unjudgeable` with the reason.
  2. Then call `codes`. It gives the candidate codes, each once, with no word of whose they are. Judge every candidate
     acceptable or not by the MCC rules, each with evidence, and finish by calling `answer` once with all of them. A
     candidate is not wrong for differing from your own code: two codes can both be acceptable.
- Evidence: one to five items per judgment. Each is a page of the merchant's own site (or of the marketplace listing
  its website is), as you read it in this run, and that page's own words, verbatim, at most 300 characters.
- How to read the site, the MCC rules and the risk rubric are the adjudicate-merchant skill.

## Blind, and fresh

- Nothing you are shown says whose a candidate is. Do not guess it and do not look for it.
- A code is chosen from what the merchant sells, never from a page that states its code. The sites that list
  merchants' codes are refused by every tool: do not try them.
- You judge this merchant alone. You do not learn, write workflows or keep notes for later.
