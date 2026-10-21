---
packages: @parcha/agentrun-pi
kind: feature
---
`agentrun.decisions` is now a keyed document family: one document per typed-question receipt, written once, instead of one session document whose `receipts` list was rewritten at every commit.
- A recording of a run grew with the square of its questions (a 200-item scripted run: 17 MB of decisions in a 22 MB recording); it now grows with the questions (the same run: 0.4 MB of decisions in a 4.9 MB recording; 400 items: 9.8 MB, down from 77 MB).
- The row is the same, byte for byte: each keyed document's value is exactly one receipt as before, so `readDecisions`, `appendDecision`, `createDecisionWriter` and `decisionRecovery` keep their behaviour: the same receipts in the same order, and a resumed run answers a question from its receipt without asking again.
- One form per store: a store that already holds the single document keeps writing it to the end of its run, with no migration, so no recording holds both. A fresh store writes the keyed form, with a small counting document, `agentrun.decisions.count`, beside it.
- Readers read both forms in the commit before this one, and the harness pins `@parcha/agentrun-pi` exactly, so the two release together: a harness never meets a writer whose rows its cost fold cannot read (a cap that counted from the single document only would let a run spend past it).
