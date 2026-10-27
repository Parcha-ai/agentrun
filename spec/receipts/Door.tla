---------------------------- MODULE Door ----------------------------
(***************************************************************************)
(* The serve door's journal with a door hook (packages/pi-durable-disk,    *)
(* src/door.ts): the journal of Receipts.tla for one effect per requestId. *)
(* A submit passes the lease check, then one fenced commit looks its       *)
(* requestId up and, when it is new, admits it (a door.input entry). The   *)
(* process that admitted it calls hook.submit once. The hook answers       *)
(* within the bound (the outcome settles the record), or the bound passes  *)
(* (the record says UNKNOWN) and a late answer settles it after. Every     *)
(* write is a commit through the store's fence, refused once the writer's  *)
(* lease is lost. A process may crash at any point, or lose its lease and  *)
(* go on running; the supervisor then starts the next incarnation, which   *)
(* has only the store.                                                     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Reqs,         \* the requestIds
  MaxArrivals,  \* how many submits of one requestId arrive, over every incarnation (retries, two at once)
  MaxInc,       \* how many incarnations run
  MaxLeaseLoss  \* how many times a live incarnation loses its lease

Incs == 1..MaxInc
Settled == {"ACCEPTED", "REJECTED_BUSY", "FAILED"}

VARIABLES
  rec,      \* [Reqs -> status]: the record's status in the store (its last entry); "none" before the admission
  sent,     \* [Reqs -> Nat]: the hook.submit calls the world saw
  by,       \* [Reqs -> 0..MaxInc]: the incarnation whose commit admitted it; 0 before
  arrived,  \* [Reqs -> Nat]: submits that arrived
  checking, \* [Incs -> [Reqs -> Nat]]: submits past the lease check whose admission commit has not run
  call,     \* [Incs -> [Reqs -> {"none", "own", "waiting", "late"}]]: the hook call in that process
  alive,    \* [Incs -> BOOLEAN]
  holds,    \* [Incs -> BOOLEAN]: whether it holds the lease; the store refuses its commits once it does not
  cur,      \* the newest incarnation
  losses    \* lease losses so far

vars == <<rec, sent, by, arrived, checking, call, alive, holds, cur, losses>>

Init ==
  /\ rec = [r \in Reqs |-> "none"] /\ sent = [r \in Reqs |-> 0] /\ by = [r \in Reqs |-> 0]
  /\ arrived = [r \in Reqs |-> 0]
  /\ checking = [i \in Incs |-> [r \in Reqs |-> 0]]
  /\ call = [i \in Incs |-> [r \in Reqs |-> "none"]]
  /\ alive = [i \in Incs |-> i = 1] /\ holds = [i \in Incs |-> i = 1]
  /\ cur = 1 /\ losses = 0

(* --- A submit --- *)

\* It passes the token and the lease check: its process is up and holds the lease.
Arrive(i, r) ==
  /\ alive[i] /\ holds[i] /\ arrived[r] < MaxArrivals
  /\ arrived' = [arrived EXCEPT ![r] = @ + 1]
  /\ checking' = [checking EXCEPT ![i][r] = @ + 1]
  /\ UNCHANGED <<rec, sent, by, call, alive, holds, cur, losses>>

\* The admission: one fenced commit that looks the requestId up and admits it when it is new. A lease lost since the
\* check fails the commit; a requestId already admitted answers its record as it stands.
Admit(i, r) ==
  /\ alive[i] /\ checking[i][r] > 0
  /\ checking' = [checking EXCEPT ![i][r] = @ - 1]
  /\ IF holds[i] /\ rec[r] = "none"
       THEN /\ rec' = [rec EXCEPT ![r] = "ADMITTED"] /\ by' = [by EXCEPT ![r] = i]
            /\ call' = [call EXCEPT ![i][r] = "own"]
       ELSE UNCHANGED <<rec, by, call>> \* the commit refused, or the record answered
  /\ UNCHANGED <<sent, arrived, alive, holds, cur, losses>>

\* hook.submit, once, by the process whose commit admitted the requestId, while it holds the lease.
Dispatch(i, r) ==
  /\ alive[i] /\ holds[i] /\ call[i][r] = "own"
  /\ sent' = [sent EXCEPT ![r] = @ + 1] /\ call' = [call EXCEPT ![i][r] = "waiting"]
  /\ UNCHANGED <<rec, by, arrived, checking, alive, holds, cur, losses>>

\* The hook answers within the bound: the outcome settles the record, unless the lease is gone (it stays ADMITTED).
Settle(i, r) ==
  /\ alive[i] /\ call[i][r] = "waiting"
  /\ \E o \in Settled : rec' = IF holds[i] THEN [rec EXCEPT ![r] = o] ELSE rec
  /\ call' = [call EXCEPT ![i][r] = "none"]
  /\ UNCHANGED <<sent, by, arrived, checking, alive, holds, cur, losses>>

\* The bound passes: the record says UNKNOWN and the call stays open for its late answer. When that commit is refused,
\* the late answer, chained on it, is never written.
Unknown(i, r) ==
  /\ alive[i] /\ call[i][r] = "waiting"
  /\ rec' = IF holds[i] THEN [rec EXCEPT ![r] = "UNKNOWN"] ELSE rec
  /\ call' = [call EXCEPT ![i][r] = IF holds[i] THEN "late" ELSE "none"]
  /\ UNCHANGED <<sent, by, arrived, checking, alive, holds, cur, losses>>

\* The late answer: the real outcome settles the same record through the fenced commit. A process that lost its lease
\* meanwhile is refused, and the record stays UNKNOWN.
LateSettle(i, r) ==
  /\ alive[i] /\ call[i][r] = "late"
  /\ \E o \in Settled : rec' = IF holds[i] THEN [rec EXCEPT ![r] = o] ELSE rec \* fenced
  /\ call' = [call EXCEPT ![i][r] = "none"]
  /\ UNCHANGED <<sent, by, arrived, checking, alive, holds, cur, losses>>

(* --- The process and its lease --- *)

\* A crash loses what only the process held: submits not yet admitted, its hook calls and their late answers.
Crash(i) ==
  /\ alive[i]
  /\ alive' = [alive EXCEPT ![i] = FALSE] /\ holds' = [holds EXCEPT ![i] = FALSE]
  /\ checking' = [checking EXCEPT ![i] = [r \in Reqs |-> 0]]
  /\ call' = [call EXCEPT ![i] = [r \in Reqs |-> "none"]]
  /\ UNCHANGED <<rec, sent, by, arrived, cur, losses>>

\* The lease lapses under a live process: it goes on, and its hook may still answer, but the store refuses its commits.
LoseLease(i) ==
  /\ alive[i] /\ holds[i] /\ losses < MaxLeaseLoss
  /\ holds' = [holds EXCEPT ![i] = FALSE] /\ losses' = losses + 1
  /\ UNCHANGED <<rec, sent, by, arrived, checking, call, alive, cur>>

\* The next incarnation starts once the newest is gone or lost its lease. It has the store alone and resubmits nothing:
\* an ADMITTED or UNKNOWN record is answered as it stands.
Restart ==
  /\ cur < MaxInc /\ ~holds[cur]
  /\ cur' = cur + 1 /\ alive' = [alive EXCEPT ![cur + 1] = TRUE] /\ holds' = [holds EXCEPT ![cur + 1] = TRUE]
  /\ UNCHANGED <<rec, sent, by, arrived, checking, call, losses>>

Next ==
  \/ \E i \in Incs, r \in Reqs : Arrive(i, r) \/ Admit(i, r) \/ Dispatch(i, r) \/ Settle(i, r) \/ Unknown(i, r) \/ LateSettle(i, r)
  \/ \E i \in Incs : Crash(i) \/ LoseLease(i)
  \/ Restart

Spec == Init /\ [][Next]_vars

(* --- Properties --- *)

TypeOK ==
  /\ rec \in [Reqs -> {"none", "ADMITTED", "UNKNOWN"} \cup Settled]
  /\ sent \in [Reqs -> Nat] /\ by \in [Reqs -> 0..MaxInc] /\ arrived \in [Reqs -> 0..MaxArrivals]
  /\ call \in [Incs -> [Reqs -> {"none", "own", "waiting", "late"}]]
  /\ cur \in Incs /\ losses \in 0..MaxLeaseLoss

\* At most one hook.submit per requestId, ever, across incarnations.
I1_OneDispatchPerRequest == \A r \in Reqs : sent[r] <= 1
\* A settled outcome is never overwritten.
I2_SettledNeverOverwritten == [][\A r \in Reqs : rec[r] \in Settled => rec'[r] = rec[r]]_vars
\* UNKNOWN moves only to a settled outcome, written by the late answer of the incarnation that dispatched it while it holds
\* the lease: never by a retry, a resume, or a process whose lease is gone.
I3_UnknownSettledByItsLateAnswer ==
  [][\A r \in Reqs : (rec[r] = "UNKNOWN" /\ rec'[r] # "UNKNOWN") =>
       (rec'[r] \in Settled /\ holds[by[r]] /\ call[by[r]][r] = "late" /\ call'[by[r]][r] = "none")]_vars
\* Nothing is dispatched without a record admitted by the dispatching process, under a held lease.
I4_DispatchOnlyAdmittedUnderLease ==
  [][\A r \in Reqs : sent'[r] > sent[r] => (rec[r] = "ADMITTED" /\ by[r] # 0 /\ holds[by[r]] /\ call[by[r]][r] = "own")]_vars
\* A late answer is pending only on an UNKNOWN record: LateSettle comes only after Unknown.
I5_LateSettleOnlyAfterUnknown == \A i \in Incs, r \in Reqs : call[i][r] = "late" => rec[r] = "UNKNOWN"
=============================================================================
