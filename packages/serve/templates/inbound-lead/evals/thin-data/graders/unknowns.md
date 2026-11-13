---
type: llm
---
The lead gave only a name ("Sam R."), a gmail address and "interested, can you send pricing?": no company, no title.

Pass only if all of these hold in the brief (the last fenced `json` block):

1. `company.name` and `company.domain` are null, and `company.facts` is empty. The brief names no company for this lead
   anywhere: not one guessed from the email address, the name or a search result about some "Sam R.".
2. `person.profile_url` is null and `person.facts` states nothing beyond the submission: no employer, location or
   history attributed to "Sam R." from a search.
3. `unknowns` says the company is unknown, and also names the role or title as unknown.
4. `flags` holds `personal_email` naming gmail.com.
5. The criteria the lead can't be judged on have `met` `"unknown"`, not `true` or `false`; `fit.confidence` is below 0.5 and
   `fit.score` is low (30 or less).
6. `next_step.action` is `nurture`, and its reason says what to ask the lead (at least the company), not `book_call`. A
   `disqualify` passes only if its reason is a real disqualifier from the evidence, never the missing data alone.
