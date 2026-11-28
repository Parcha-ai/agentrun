---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run with a browser that was stopped (a person's stop, or a runner's shutdown or graceful close) logged `browser_spend_uncounted` ("a browser charge was not counted in this process") although every browser charge was booked on the run's ledger: the stop seals the run's journal, pi's next write is refused, and that refusal failed the Session, which the browser's count read as a failed store. The count now tells a write the seal refused from a store failure and stays silent for it; a Session whose store fails, or an observer that throws, is still logged once.
