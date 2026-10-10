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
(* identity at any time.                                                   *)
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
  afterFault  \* an admission made after a commit failed (a ghost: the guarded actions never set it)

vars == <<memo, sent, at, fresh, flight, run, up, crashes, afterFault>>

Init ==
  /\ memo = [i \in Steps |-> "none"]
  /\ sent = [i \in Steps |-> 0]
  /\ at = 1 /\ fresh = 0 /\ flight = 0 /\ run = "running"
  /\ up = TRUE /\ crashes = 0 /\ afterFault = FALSE

Working == up /\ run = "running"
\* A commit that fails stops the run: nothing is admitted after it.
Fail == /\ CommitsMayFail /\ run' = "faulted" /\ UNCHANGED <<memo, sent, at, fresh, flight>>

(* --- The driver --- *)

\* The effect is on the journal before anything goes out.
Admit ==
  /\ up /\ at <= N /\ flight = 0 /\ fresh = 0 /\ memo[at] = "none"
  /\ afterFault' = (afterFault \/ run = "faulted")
  /\ run = "running"
  /\ \/ /\ memo' = [memo EXCEPT ![at] = "unknown"] /\ fresh' = at
        /\ UNCHANGED <<sent, at, flight, run>>
     \/ Fail
  /\ UNCHANGED <<up, crashes>>

\* Only the effect this process admitted is dispatched, once: the interpreter runs no call retry under recovery.
Dispatch ==
  /\ Working /\ fresh = at /\ at <= N /\ memo[at] = "unknown"
  /\ sent' = [sent EXCEPT ![at] = @ + 1] /\ flight' = at /\ fresh' = 0
  /\ UNCHANGED <<memo, at, run, afterFault, up, crashes>>

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

\* A resumed driver answers a completed effect from the journal, with no dispatch.
Answer ==
  /\ Working /\ flight = 0 /\ fresh = 0 /\ at <= N /\ memo[at] = "completed"
  /\ at' = at + 1
  /\ UNCHANGED <<memo, sent, fresh, flight, run, afterFault, up, crashes>>

\* A resumed driver meets an effect admitted by an earlier process and never completed: it is refused, never repeated.
Refuse ==
  /\ Working /\ flight = 0 /\ fresh = 0 /\ at <= N /\ memo[at] = "unknown"
  /\ run' = "refused"
  /\ UNCHANGED <<memo, sent, at, fresh, flight, afterFault, up, crashes>>

Finish ==
  /\ Working /\ at = N + 1 /\ run' = "done"
  /\ UNCHANGED <<memo, sent, at, fresh, flight, afterFault, up, crashes>>

(* --- The worker --- *)

\* A crash loses what only this process held: the admission it had not dispatched, the effect in flight.
Crash ==
  /\ up /\ crashes < MaxCrashes
  /\ up' = FALSE /\ crashes' = crashes + 1 /\ fresh' = 0 /\ flight' = 0
  /\ UNCHANGED <<memo, sent, at, run, afterFault>>

Restart ==
  /\ ~up /\ up' = TRUE
  /\ UNCHANGED <<memo, sent, at, fresh, flight, run, afterFault, crashes>>

Next ==
  \/ Admit \/ Dispatch \/ Settle \/ Answer \/ Refuse \/ Finish
  \/ Crash \/ Restart

Spec == Init /\ [][Next]_vars

(* --- Properties --- *)

TypeOK ==
  /\ memo \in [Steps -> {"none", "unknown", "completed"}]
  /\ at \in 1..(N + 1) /\ fresh \in 0..N /\ flight \in 0..N
  /\ run \in {"running", "refused", "faulted", "done"}

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

\* A completed receipt is never erased or changed.
I7_ReceiptsNeverErased == [][\A i \in Steps : memo[i] = "completed" => memo'[i] = "completed"]_vars
=============================================================================
