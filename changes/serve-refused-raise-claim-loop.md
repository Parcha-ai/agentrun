---
packages: @parcha/agentrun-serve
kind: fix
---
A command a run's loop refuses after the runner's dispatch took it for now (a row that arrives before the run's harness loop is chosen, as the row that wakes a parked run does) is now written refused. Before, the refusal was dropped and the row stayed untaken: a raise the cap's rule refuses (a race of two raises, or a retry) woke a run parked at its cap, the run parked again, and the untaken row made it claimable again at once, every poll, for good. A capped workflow run also wrote a new `agentrun.budget` entry on each of those claims. A workflow run parked at its cap that no raise of its claim resumes now parks again on the pause it stood at, with nothing written, before any step runs.
