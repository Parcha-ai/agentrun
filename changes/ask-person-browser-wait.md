---
packages: @parcha/agentrun-serve
kind: fix
---
A runner run whose agent asks the person (ask_person) while its browser session is open now waits for the answer in its claim instead of parking. Its session, its live view and its page stay: the owner can watch live and take over while the run waits, and the answer resumes the agent on the same session. The person's time on the session is held on the run's ledger under its cap, as a browser hand-over's is. When the cap has no room for more of that time, or the session is let go (its idle release), the run parks on its question as before. A run with no browser session open parks on ask_person as it did.
