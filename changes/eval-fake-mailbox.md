---
packages: @parcha/agentrun-serve
kind: feature
---
A template eval case can say `email: fixtures/mailbox.json`, and its runs read a fake mailbox seeded from that file, never real mail. Each run on each of the fixture's `layouts` (`gmail`, `folders`; default `folders`) gets a fresh fake account, saved as the eval's own server's email account and closed after the run, and the case reports per layout.
- A run starts as the package's trigger would: the mailboxes are seeded, the package applied (its email trigger takes its start), the fixture's `message` delivered, and the trigger's next poll fires on it, so the run reads only that message's thread. A fixture with no `message` starts the package's schedule's run, which reads the whole account.
- Graders see each email call with its arguments, a refused one too, and `<mailbox-after>`: the drafts and other messages the run added, what it moved or labelled, and what it sent. A `mailbox` grader checks where one message is after the run (`message_id`, `in`, `not_in`). Any grader of an email case may say `layouts`, and grades only the runs of those layouts.
- On the gmail layout a label's mailbox lists every message carrying the label, as Gmail's does: searching `Ignored` finds the messages labelled `Ignored`, a label added or taken off shows at once, and a flag set through any mailbox shows in all of them.
- The fixture is checked when the case is read; the run's clock is the case's `now`, and so is the trigger's: each run of a schedule case fires on the case's date, never the schedule's next time after the run before. Only the eval's own server honours `email`, so a case with it refuses `--server`.
- The eval runner's per-run fakes (`web`, `monid`, `now`, and now `email`) are one map per agent, read in one place by the runner beside the eval's server.
- The eval's grader agent runs with no computer: it only reads, and on a server with no sandbox its runs failed at the start.
