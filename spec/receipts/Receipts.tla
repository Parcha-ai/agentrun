---------------------------- MODULE Receipts ----------------------------
(***************************************************************************)
(* What a recovery driver keeps across a crash, and what it never does     *)
(* twice. The driver runs a workflow's call steps in order over a          *)
(* journal (packages/dsl/src/recovery/store.ts, RecoveryJournal): each     *)
(* step's effect is admitted before it dispatches and completed with its   *)
(* result after, each in one commit with the driver's state; a resume      *)
(* answers a completed effect from the journal and refuses one whose       *)
(* outcome is unknown.                                                     *)
(* The worker may crash between any two actions; any commit may fail,     *)
(* which stops the run; the host restarts the worker under the same        *)
(* identity at any time, from a checkpoint at or before the journal's      *)
(* position.                                                               *)
(* The host may cancel the run: the driver applies the stop at once, then  *)
(* commits it, and that commit may fail too. The host lets go of the       *)
(* driver with close, which waits for the stop's commit and throws it when *)
(* the store refused it (packages/dsl/src/recovery/driver.ts). A pause     *)
(* takes the same commit path once no effect is in flight.                 *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  N,              \* the driver's call steps, run in order 1..N, one effect key each
  MaxCrashes,     \* how many times the worker may die
  CommitsMayFail  \* whether a commit may fail

Steps == 1..N

VARIABLES
  memo,       \* [Steps -> {"none", "unknown", "completed"}]: the journal's effects
  sent,       \* [Steps -> Nat]: the dispatches the world saw
  at,         \* the step the driver is on; N + 1 once every step committed
  fresh,      \* the step this process admitted and has not yet dispatched, or 0
  flight,     \* the step whose effect is in flight in this process, or 0
  run,        \* "running" | "refused" | "faulted" | "done"
  up,         \* whether the worker is alive
  crashes,    \* how many times it died
  afterFault, \* an admission made after a commit failed (a ghost: the guarded actions never set it)
  stop,       \* the stop this process applied: "none" | "pending" (its commit not yet landed) | "landed" | "refused"
  stopped,    \* whether the journal holds the stop
  told,       \* whether the run reported its stop to the host (a ghost)
  closed,     \* whether the host let go of the driver after that stop: close returned or threw
  heard,      \* whether close threw the stop's refused commit, so the host knows the stop is not on the journal
  afterStop,  \* an admission made while this process had applied a stop (a ghost)
  afterCancel \* an admission made once the journal held the stop (a ghost)

vars == <<memo, sent, at, fresh, flight, run, up, crashes, afterFault, stop, stopped, told, closed, heard, afterStop, afterCancel>>
stopState == <<stop, stopped, told, closed, heard>>
ghosts == <<afterStop, afterCancel>>

Init ==
  /\ memo = [i \in Steps |-> "none"]
  /\ sent = [i \in Steps |-> 0]
  /\ at = 1 /\ fresh = 0 /\ flight = 0 /\ run = "running"
  /\ up = TRUE /\ crashes = 0 /\ afterFault = FALSE
  /\ stop = "none" /\ stopped = FALSE /\ told = FALSE /\ closed = FALSE /\ heard = FALSE
  /\ afterStop = FALSE /\ afterCancel = FALSE

Working == up /\ run = "running"
\* A commit that fails stops the run: nothing is admitted after it.
Fail == /\ CommitsMayFail /\ run' = "faulted" /\ UNCHANGED <<memo, sent, at, fresh, flight>>

(* --- The driver --- *)

\* The effect is on the journal before anything goes out.
Admit ==
  /\ up /\ at <= N /\ flight = 0 /\ fresh = 0 /\ memo[at] = "none"
  /\ afterStop' = (afterStop \/ stop # "none") /\ afterCancel' = (afterCancel \/ stopped)
  /\ afterFault' = (afterFault \/ run = "faulted")
  /\ run = "running"
  /\ \/ /\ memo' = [memo EXCEPT ![at] = "unknown"] /\ fresh' = at
        /\ UNCHANGED <<sent, at, flight, run>>
     \/ Fail
  /\ UNCHANGED <<up, crashes>>
  /\ UNCHANGED stopState

\* Only the effect this process admitted is dispatched, once, and never after a stop: the driver's guard throws the stop
\* before an admitted effect goes out, as it does before admission. A dispatch after a stop is a ghost, like an admission.
Dispatch ==
  /\ Working /\ fresh = at /\ at <= N /\ memo[at] = "unknown"
  /\ afterStop' = (afterStop \/ stop # "none") /\ afterCancel' = (afterCancel \/ stopped)
  /\ sent' = [sent EXCEPT ![at] = @ + 1] /\ flight' = at /\ fresh' = 0
  /\ UNCHANGED <<memo, at, run, afterFault, up, crashes>>
  /\ UNCHANGED stopState

\* The world answers: a result completes the effect with the state that follows, in one commit; an outcome nobody
\* knows leaves it unknown and the run refused.
Settle ==
  /\ Working /\ flight = at /\ at <= N
  /\ \/ /\ memo' = [memo EXCEPT ![at] = "completed"] /\ at' = at + 1 /\ flight' = 0
        /\ UNCHANGED <<sent, fresh, run>>
     \/ /\ run' = "refused" /\ flight' = 0
        /\ UNCHANGED <<memo, sent, at, fresh>>
     \/ Fail
  /\ UNCHANGED <<afterFault, up, crashes>>
  /\ UNCHANGED <<stopState, ghosts>>

\* A resumed driver answers a completed effect from the journal, with no dispatch.
Answer ==
  /\ Working /\ flight = 0 /\ fresh = 0 /\ at <= N /\ memo[at] = "completed"
  /\ at' = at + 1
  /\ UNCHANGED <<memo, sent, fresh, flight, run, afterFault, up, crashes>>
  /\ UNCHANGED <<stopState, ghosts>>

\* A resumed driver meets an effect admitted by an earlier process and never completed: it is refused, never repeated.
Refuse ==
  /\ Working /\ flight = 0 /\ fresh = 0 /\ at <= N /\ memo[at] = "unknown"
  /\ run' = "refused"
  /\ UNCHANGED <<memo, sent, at, fresh, flight, afterFault, up, crashes>>
  /\ UNCHANGED <<stopState, ghosts>>

Finish ==
  /\ Working /\ at = N + 1 /\ run' = "done"
  /\ UNCHANGED <<memo, sent, at, fresh, flight, afterFault, up, crashes>>
  /\ UNCHANGED <<stopState, ghosts>>

(* --- The host's stop --- *)

\* The host cancels: the driver applies the stop at once (nothing is admitted, dispatched or settled after it in this
\* process, and the run reports the stop), then commits it. An effect in flight stays unknown, as a crash leaves it.
Cancel ==
  /\ Working /\ stop = "none"
  /\ run' = "stopped" /\ stop' = "pending" /\ told' = TRUE /\ closed' = FALSE /\ heard' = FALSE
  /\ UNCHANGED <<memo, sent, at, fresh, flight, up, crashes, afterFault, stopped, ghosts>>

\* The stop's commit lands, or the store refuses it.
CommitStop ==
  /\ up /\ stop = "pending"
  /\ \/ /\ stop' = "landed" /\ stopped' = TRUE
     \/ /\ CommitsMayFail /\ stop' = "refused" /\ UNCHANGED stopped
  /\ UNCHANGED <<memo, sent, at, fresh, flight, run, up, crashes, afterFault, told, closed, heard, ghosts>>

\* The host lets go of the driver once the stop's commit has landed or failed (close waits for every commit the driver
\* started), and close throws a refused one: the host hears that the stop is not on the journal.
Close ==
  /\ up /\ stop \in {"landed", "refused"} /\ ~closed
  /\ closed' = TRUE /\ heard' = (stop = "refused")
  /\ UNCHANGED <<memo, sent, at, fresh, flight, run, up, crashes, afterFault, stop, stopped, told, ghosts>>

(* --- The worker --- *)

\* A crash loses what only this process held: the admission it had not dispatched, the effect in flight, a stop whose
\* commit had not landed.
Crash ==
  /\ up /\ crashes < MaxCrashes
  /\ up' = FALSE /\ crashes' = crashes + 1 /\ fresh' = 0 /\ flight' = 0
  /\ UNCHANGED <<memo, sent, at, run, afterFault>>
  /\ stop' = "none" /\ UNCHANGED <<stopped, told, closed, heard, ghosts>>

\* The new process resumes from a checkpoint at or before the journal's position (the first step, when it runs the
\* workflow again from the top): it meets the steps it passes again, answering each completed effect. A stop the
\* journal does not hold died with the process that applied it, and the run resumes; one the journal holds is refused
\* at the open, so a cancelled run never resumes.
Restart ==
  /\ ~up /\ up' = TRUE /\ at' \in 1..at
  /\ run' = IF run = "stopped" /\ ~stopped THEN "running" ELSE run
  /\ UNCHANGED <<memo, sent, fresh, flight, afterFault, crashes>>
  /\ UNCHANGED <<stopState, ghosts>>

Next ==
  \/ Admit \/ Dispatch \/ Settle \/ Answer \/ Refuse \/ Finish
  \/ Cancel \/ CommitStop \/ Close
  \/ Crash \/ Restart

Spec == Init /\ [][Next]_vars

(* --- Properties --- *)

TypeOK ==
  /\ memo \in [Steps -> {"none", "unknown", "completed"}]
  /\ at \in 1..(N + 1) /\ fresh \in 0..N /\ flight \in 0..N
  /\ run \in {"running", "refused", "faulted", "done", "stopped"}
  /\ stop \in {"none", "pending", "landed", "refused"}
  /\ {stopped, told, closed, heard, afterStop, afterCancel} \subseteq BOOLEAN

\* An effect is on the journal before it goes out.
I1_AdmitBeforeDispatch == \A i \in Steps : sent[i] > 0 => memo[i] # "none"
\* No effect key goes out twice, whatever crashed.
I3_OneDispatchPerKey == \A i \in Steps : sent[i] <= 1
\* The driver never moves past an effect it did not complete.
I3_CallRefused == \A i \in Steps : i < at => memo[i] = "completed"
\* Nothing is admitted after a commit failed.
I6_NoAdmissionAfterFault == ~afterFault
\* A completed effect went out exactly once.
I7_CompletedDispatchedOnce == \A i \in Steps : memo[i] = "completed" => sent[i] = 1
\* A finished run completed every effect.
I7_DoneSettledEveryCall == run = "done" => \A i \in Steps : memo[i] = "completed"

\* A stop the host let go of is on the journal, or the host heard that it is not: close throws a refused stop commit.
I8_StopOnJournalOrHeard == (told /\ closed) => (stopped \/ heard)
\* Nothing is admitted or dispatched after a stop, in the process that applied it.
I9_NoAdmissionAfterStop == ~afterStop
\* A cancelled run never resumes: once the journal holds the stop, no process admits anything.
I10_CancelledNeverResumes == ~afterCancel

\* A completed receipt is never erased or changed.
I7_ReceiptsNeverErased == [][\A i \in Steps : memo[i] = "completed" => memo'[i] = "completed"]_vars
=============================================================================
