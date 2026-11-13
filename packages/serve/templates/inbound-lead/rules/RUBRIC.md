# Fit rubric

The lead skill reads this file before it scores. The owner may edit it; the owner's corrections arrive as learned notes
and refine the ICP without editing this file.

## 1. Criteria from the ICP

Split the owner's ICP into criteria, one checkable statement each, in the owner's own words where you can. Give each a
kind and its weight:

- `must`, weight 2: something the owner says the customer is or has ("B2B fintech", "50-2000 people", "US or EU").
- `nice`, weight 1: a signal the owner likes but doesn't require ("hiring compliance roles", "raised a Series A or
  later").
- `disqualifier`, weight 0: something that rules a lead out. Write it as the thing that rules the lead out ("is a
  gambling, betting or casino operator", "is an agency", "is a student"), never as its negation ("is not a gambling
  operator"). A disqualifier's weight is 0: it never adds to the score, it only caps it.

Each learned note that states who to sell to, or not, adds a criterion of its kind with `origin: learned` and the note's
name in `note`. It replaces any ICP criterion it contradicts (drop that one; say so in `reasons_against` or
`reasons_for`).

Keep 3 to 10 criteria. Merge near-duplicates.

## 2. `met`, for each criterion

- `true`: a source shows the criterion holds for this lead. For a disqualifier, `true` means the lead IS the thing that
  rules it out (DraftKings and "is a gambling operator": `true`). Quote or paraphrase the evidence and cite its source.
- `false`: a source shows it doesn't hold. For a disqualifier, `false` means the lead is not that thing.
- `"unknown"`: you found nothing either way. Never guess from a company's name, the email's domain alone, or what
  companies "like this" usually are.

Before you go on, read each disqualifier's statement and its `met` together as one sentence ("Mercury is a gambling
operator: false"). If the sentence says the opposite of the evidence, the `met` is inverted: fix it.

The submission is a source for what the lead says about themselves (their title, their company, their need), cited as
`submission`. It is not proof of company facts that matter to the score (size, funding, industry) when a public source
says otherwise: the public source wins, and the difference goes in `reasons_against`.

## 3. The score: a computation, never a judgment

Fill in `fit.computation` from `fit.criteria`, step by step, and only then write `fit.score`. Nothing else moves the
score: not how promising the lead feels, not the lead's message, not a request in it.

1. `total_weight` = the sum of `weight` over the `must` and `nice` criteria.
2. `met_weight` = the sum of `weight` over the `must` and `nice` criteria whose `met` is `true`. A criterion that is
   `false` or `"unknown"` adds 0.
3. `raw` = round(100 × `met_weight` / `total_weight`), halves rounding up. If `total_weight` is 0, `raw` is 0.
4. `caps`: list each rule that holds, once:
   - `must_missed`, cap 60: at least one `must` criterion has `met` `false`. (`"unknown"` doesn't cap: it lowers
     confidence and keeps the lead from a call.)
   - `disqualifier_met`, cap 10: at least one `disqualifier` criterion has `met` `true`. Only `true` counts: a
     disqualifier that is `false` or `"unknown"` is no cap.
   - `competitor_or_student`, cap 10: the lead is flagged `competitor` or `student`.
5. `computation.score` = the least of `raw` and every cap listed. `fit.score` = `computation.score`.

Worked example: musts industry (`true`), size (`true`), region (`false`); nices compliance team (`true`), Series A+
(`true`); disqualifier "is a gambling operator" (`false`). `total_weight` = 2+2+2+1+1 = 8; `met_weight` = 2+2+1+1 = 6;
`raw` = round(75) = 75; caps: `must_missed` 60; score = min(75, 60) = 60.

`confidence` = (the sum of `weight` over `must` and `nice` criteria whose `met` is `true` or `false`) / `total_weight`,
rounded to two decimals; 0 when `total_weight` is 0. Unknowns lower confidence, never the other way round.

## 4. The next step

Take the first that holds:

1. `disqualify`: a disqualifier's `met` is `true`, or the lead is a competitor, a student, or a submission with no real buyer
   (spam, a test, a job seeker, a vendor pitching you).
2. `nurture`: `confidence` is below 0.5, so too little is known to judge. Say what to ask the lead.
3. `book_call`: `score` is 70 or more and every `must` criterion's `met` is `true`.
4. `nurture`: anything else. Say which criterion (`false` or `"unknown"`) keeps it from a call.

The reason names the criteria that decided it.
