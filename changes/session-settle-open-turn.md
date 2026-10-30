---
packages: @parcha/agentrun-kernel
kind: feature
---
`AdapterSession.settleOpenTurn({ opening })`: a turn a crash cut off can be ended instead of resumed. It is recorded ended `interrupted` and nothing is sent to the harness, so no later open resumes it. It withdraws only the submission it is named, while that is unplaced and the oldest pending; unnamed, it withdraws nothing, so a settle never drops a message it cannot tell is the caller's. A settle again finds that submission withdrawn and writes nothing. The withdraw and the turn's end are one append (`Drive.recordOnly`, under the guards of an effect), and the turn's end is the journal's next batch, built as `NativeJournal` builds its own (`journalBatchEffect`). `send(text, { id })` names the submission, and an id the session already holds is refused (`SubmissionExists`). It is written once, in the shared adapter session, so every harness adapter has it; the faux harness in `./testing` has it too. Only an open turn is settled.
