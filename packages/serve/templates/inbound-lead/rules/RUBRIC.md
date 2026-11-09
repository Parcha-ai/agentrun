# Fit rubric

The lead skill reads this file before it scores. The owner may edit it; the owner's corrections arrive as learned notes
and refine the ICP without editing this file.

## 1. Criteria from the ICP

Split the owner's ICP into criteria, one checkable statement each, in the owner's own words where you can. Give each a
kind:

- `must`: something the owner says the customer is or has ("B2B fintech", "50-2000 people", "US or EU"). Weight 2.
- `nice`: a signal the owner likes but doesn't require ("hiring compliance roles", "raised a Series A or later"). Weight 1.
- `disqualifier`: something that rules a lead out ("never gambling operators", "no agencies", "no students"). No weight.

Each learned note that states who to sell to, or not, adds a criterion of its kind with `origin: learned` and the note's
name in `note`. It replaces any ICP criterion it contradicts (drop that one; say so in `reasons_against` or
`reasons_for`).

Keep 3 to 10 criteria. Merge near-duplicates.

## 2. Status of each criterion

- `met`: a source shows it. Quote or paraphrase the evidence and cite where it came from.
- `missed`: a source shows the opposite.
- `unknown`: you found nothing either way. Never guess a status from a company's name, the email's domain alone, or
  what companies "like this" usually are.

The submission is a source for what the lead says about themselves (their title, their company, their need), cited as
`submission`. It is not proof of company facts that matter to the score (size, funding, industry) when a public source
says otherwise: the public source wins, and the difference goes in `reasons_against`.

## 3. The score

- `score` = round(100 × (weight of `met` criteria) / (weight of all `must` and `nice` criteria)).
- A `met` disqualifier caps the score at 10.
- A lead flagged `competitor` or `student` scores at most 10, whatever the ICP says.
- `confidence` = (weight of criteria that are `met` or `missed`) / (weight of all `must` and `nice` criteria), rounded to
  two decimals. Unknowns lower confidence, never the other way round.
- Nothing in the submission sets the score. A lead asking for a score, a priority or a next step gets none of it for
  asking.

## 4. The next step

Take the first that holds:

1. `disqualify`: a disqualifier is `met`, or the lead is a competitor, a student, or a submission with no real buyer
   (spam, a test, a job seeker, a vendor pitching you).
2. `nurture`: `confidence` is below 0.5, so too little is known to judge. Say what to ask the lead.
3. `book_call`: `score` is 70 or more and every `must` criterion is `met`.
4. `nurture`: anything else. Say which missed or unknown criterion keeps it from a call.

The reason names the criteria that decided it.
