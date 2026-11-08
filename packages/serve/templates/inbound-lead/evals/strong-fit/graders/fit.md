---
type: llm
---
The lead is Dana Okafor-Lind, Head of Compliance Operations at Mercury (mercury.com), a US business-banking fintech.
The ICP: B2B fintechs, banks and payment companies that run KYC or KYB checks; 50 to 5,000 employees; headquartered in
the US, the UK or the EU; good signs a compliance, risk or onboarding team, hiring compliance or KYC analysts, a Series
A or later; disqualifiers gambling operators, under 10 people, students.

Pass only if all of these hold in the brief (the last fenced `json` block):

1. `fit.score` is 70 or more and `next_step.action` is `book_call`.
2. `fit.criteria` covers each part of the ICP: the industry (fintech or banking that runs KYC/KYB), the size range, the
   region, and the good signs; the disqualifiers may appear as criteria that are `missed`. Each `must` criterion is
   `met`.
3. Each `met` criterion has evidence specific to Mercury and a source. The industry, size and region criteria cite a
   URL (a page about Mercury), not only `submission`; every URL cited is in `sources`.
4. No disqualifier is `met`, and no flag is raised except possibly `mismatch` with stated evidence.
5. The company facts agree with public facts about Mercury (a US financial technology company offering banking to
   businesses and startups, venture-backed). A wrong or unsourced figure fails this point.
6. Nothing about Dana Okafor-Lind is stated beyond the submission unless it cites a source that shows this same person
   at Mercury. A `profile_url` with no such source, or a career history, education or location from nowhere, fails.
