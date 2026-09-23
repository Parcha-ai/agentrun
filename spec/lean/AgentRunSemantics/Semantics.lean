import AgentRunSemantics.Syntax

/-!
# Semantics

A big-step interpreter for the workflow language, mirroring `runNodeOnState` /
`runNodeBody` in `packages/dsl/src/workflow.ts`.

Everything the TypeScript interpreter delegates is an `Oracle` field: `runNode`,
`runJudge`, `runEffect`, code execution, `ask` predicates, JSON Schema checks, the host
policy's `decodeSubmission` / `afterNode`, and the scheduler's choice of which concurrent
failure is reported. Theorems quantify over every `Oracle`.

`eval` is structurally recursive (no `partial`, no fuel): Lean's kernel accepts it as a
total function, which is the termination half of T3.
-/

namespace AgentRun

/-- An execution path (`executionPath`): `["root", "steps", "0", ...]`. -/
abbrev ExecPath := List String

/-- One step of a static node address. -/
inductive AddrSeg where
  | step (i : Nat)
  | branch (i : Nat)
  | named (name : String)
  | body
  | child
  deriving Repr, DecidableEq

/-- A static node address (the validator's `path`, e.g. `root.steps[1].body`): like an
execution path but without map item or loop iteration indexes, so every node of a
document has exactly one address. -/
abbrev Addr := List AddrSeg

def ExecPath.render (p : ExecPath) : String :=
  String.join (p.map fun seg => "/" ++ (seg.replace "~" "~0").replace "/" "~1")

/-- What an oracle is told about the call site. -/
structure Ctx where
  path : ExecPath
  /-- The node label, prefixed by enclosing child invocations (`invocation/label`). -/
  label : String
  deriving Repr

/-- A generative node's decoded, schema-valid, verified submission. -/
structure GenOut where
  value : Value
  /-- The `<key>$verify` record when the node declares `verify`. -/
  verify : Option Value := none
  /-- What `hostPolicy.decodeSubmission` returned as host state. -/
  host : List (String × Value) := []
  deriving Repr, Inhabited

inductive StateReason where
  | missingInterpolation
  | expectedList
  | emptySelection
  | missingMapResult
  | parallelWriteConflict
  | reservedStateKey
  deriving Repr, DecidableEq

inductive Err where
  /-- `WorkflowStateError` with reason `required_nonempty` (`assertNodeInputs`). `addr` and
  `headPresent` are ghost fields: the failing node's static address, and whether the first
  key of the path was present in the state. The TypeScript error carries neither. -/
  | required (label : String) (addr : Addr) (path : Path) (headPresent : Bool)
  | state (reason : StateReason) (label : String) (path : Path)
  /-- An oracle failed: provider, schema, verification or code error. -/
  | adapter (label : String) (message : String)
  /-- An engine check outside the state contract (bad choice, capacity, question guard). -/
  | engine (label : String) (message : String)
  | outputInvalid (label : String)
  | inputInvalid (label : String)
  | invalid
  deriving Repr

structure Escalation where
  kind : String
  stage : String
  summary : String
  label : String
  state : State
  path : ExecPath
  deriving Repr

inductive Outcome where
  | ok (s : State)
  | escalated (e : Escalation)
  | failed (e : Err)
  deriving Repr

def Outcome.isOk : Outcome → Bool
  | .ok _ => true
  | _ => false

/-- An observable runtime event (`onEvent`), restricted to the control-flow events the
conformance traces compare. -/
structure Event where
  path : ExecPath
  text : String
  deriving Repr, DecidableEq

abbrev Run := Outcome × List Event

structure Oracle where
  /-- A `code` node's return value (`fn(state)`), or the thrown error. -/
  code : Ctx → State → Except String Value
  /-- `runNode` for agent/decide/extract, after decoding, schema checks and verification. -/
  gen : Ctx → GenKind → Value → Except String GenOut
  /-- `runNode` for a report; `value` is `report_markdown`. -/
  report : Ctx → Value → Except String GenOut
  /-- `runJudge` for `judge`: the decoded value and its `$answers` sidecar. -/
  judge : Ctx → Value → Except String (Value × Value)
  /-- `runJudge` for `pick` over `n` options: an item index (or none-of-these) and the sidecar. -/
  pick : Ctx → Value → Nat → Except String (Option Nat × Value)
  /-- `runJudge` for `sift` over `n` items: per item its value, sidecar and keep verdict. -/
  sift : Ctx → Value → Nat → Except String (List (Value × Value × Bool))
  /-- `runJudge` for `route`: the chosen branch name, its confidence and the sidecar. -/
  route : Ctx → Value → Except String (String × Rat × Value)
  /-- `runEffect`, including retries, polling, memo and the result schema check. -/
  effect : Ctx → Value → Except String Value
  /-- `runJudge` for an `ask` predicate: the probability of yes. -/
  ask : Ctx → Value → Except String Rat
  /-- JSON Schema acceptance (`Compile(schema).Check(value)`); `none` is `undefined`. -/
  schemaOk : String → Option Value → Bool
  /-- `hostPolicy.afterNode`: a patch applied after every step. -/
  afterNode : Option (Ctx → State → List (String × Value))
  /-- `describeItem` for `pick` options: rendering of the describe template for item `i`. -/
  render : String → State → String
  /-- `deps.maxQuestionsPerRequest` (default 256). -/
  questionLimit : Nat
  /-- Which of several concurrent failures (map items, parallel branches) is reported. -/
  choose : List Outcome → Outcome
  choose_mem : ∀ l, l ≠ [] → choose l ∈ l

/-! ## Interpolation -/

def ratToString (q : Rat) : String :=
  if q.den = 1 then toString q.num else
    -- Terminating decimals only (conformance cases); other rationals render as a fraction.
    let rec digits (r : Rat) : Nat → String
      | 0 => ""
      | k + 1 => if r = 0 then "" else
          let r10 := r * 10
          let d := r10.floor
          toString d ++ digits (r10 - d) k
    let sign := if q < 0 then "-" else ""
    let a := if q < 0 then -q else q
    let whole := a.floor
    sign ++ toString whole ++ "." ++ digits (a - whole) 20

def jsonEscape (s : String) : String :=
  "\"" ++ String.join (s.toList.map fun c =>
    if c = '"' then "\\\"" else if c = '\\' then "\\\\" else if c = '\n' then "\\n"
    else c.toString) ++ "\""

mutual
/-- `JSON.stringify` for inline interpolation. -/
def Value.toJs : Value → String
  | .null => "null"
  | .bool b => if b then "true" else "false"
  | .num n => ratToString n
  | .str s => jsonEscape s
  | .arr xs => "[" ++ Value.toJsList xs ++ "]"
  | .obj kvs => "{" ++ Value.toJsFields kvs ++ "}"
def Value.toJsList : List Value → String
  | [] => ""
  | [x] => Value.toJs x
  | x :: xs => Value.toJs x ++ "," ++ Value.toJsList xs
def Value.toJsFields : List (String × Value) → String
  | [] => ""
  | [(k, v)] => jsonEscape k ++ ":" ++ Value.toJs v
  | (k, v) :: rest => jsonEscape k ++ ":" ++ Value.toJs v ++ "," ++ Value.toJsFields rest
end

def Value.toText : Value → String
  | .str s => s
  | v => v.toJs

def interpText (s : State) : List TextPart → Except Path String
  | [] => .ok ""
  | .lit t :: rest => (interpText s rest).map (t ++ ·)
  | .ref p :: rest => match resolveRef s p with
    | some v => (interpText s rest).map (v.toText ++ ·)
    | none => .error p

mutual
/-- `interpolateValue`: a missing path is an error (`missing_interpolation`). -/
def interp (s : State) : Tmpl → Except Path Value
  | .lit v => .ok v
  | .ref p => match resolveRef s p with
    | some v => .ok v
    | none => .error p
  | .text parts => (interpText s parts).map .str
  | .arr xs => (interpList s xs).map .arr
  | .obj kvs => (interpFields s kvs).map .obj
def interpList (s : State) : List Tmpl → Except Path (List Value)
  | [] => .ok []
  | t :: ts => match interp s t, interpList s ts with
    | .ok v, .ok vs => .ok (v :: vs)
    | .error p, _ => .error p
    | .ok _, .error p => .error p
def interpFields (s : State) : List (String × Tmpl) → Except Path (List (String × Value))
  | [] => .ok []
  | (k, t) :: rest => match interp s t, interpFields s rest with
    | .ok v, .ok vs => .ok ((k, v) :: vs)
    | .error p, _ => .error p
    | .ok _, .error p => .error p
end

/-- A node's prompt state: its `state` map interpolated, or the whole state. -/
def promptState (label : String) (s : State) : Option Tmpl → Except Err Value
  | some t => match interp s t with
    | .ok v => .ok v
    | .error p => .error (.state .missingInterpolation label p)
  | none => .ok (.obj s)

/-! ## Predicates -/

def scalarMatches : Option Value → Scalar → Bool
  | some (.str a), .str b => a == b
  | some (.num a), .num b => a == b
  | some (.bool a), .bool b => a == b
  | _, _ => false

/-- `predicateMatches` for the mechanical predicates. -/
def mechHolds (v : Value) : Pred → Bool
  | .fieldEquals p x => scalarMatches (getPathP v p) x
  | .fieldTrue p => match getPathP v p with
    | some (.bool true) => true
    | _ => false
  | .isIn p xs => xs.any (scalarMatches (getPathP v p))
  | .empty p => match getPathP v p with
    | some (.arr xs) => xs.isEmpty
    | some (.str "") | some .null | none => true
    | _ => false
  | .countGte p n => match getPathP v p with
    | some (.arr xs) => decide ((xs.length : Rat) ≥ n)
    | some (.num m) => decide (m ≥ n)
    | _ => decide ((0 : Rat) ≥ n)
  | .noNewItems p => match getPathP v p with
    | some (.arr xs) => xs.isEmpty
    | some t => !t.truthy
    | none => true
  | .gte p n => match getPathP v p with
    | some (.num m) => decide (m ≥ n)
    | _ => false
  | .lt p n => match getPathP v p with
    | some (.num m) => decide (m < n)
    | _ => false
  | .ask .. => false

/-- `evaluatePredicate`: mechanical predicates read the state; `ask` asks the oracle. -/
def evalPred (O : Oracle) (ctx : Ctx) (s : State) : Pred → Except Err Bool
  | .ask gte st => match promptState ctx.label s st with
    | .error e => .error e
    | .ok asked => match O.ask ctx asked with
      | .error m => .error (.adapter ctx.label m)
      | .ok p => .ok (decide (p ≥ gte.getD (3 / 5)))
  | p => .ok (mechHolds (.obj s) p)

/-! ## Node inputs, host state, step wrapper -/

def headPresent (s : State) : Path → Bool
  | k :: _ => s.has k
  | [] => true

/-- `assertNodeInputs`: every `requires` path must hold a concrete (non-empty) value. -/
def checkRequires (label : String) (addr : Addr) (s : State) : List Path → Except Err Unit
  | [] => .ok ()
  | p :: ps => match getPathS s p with
    | some v => if hasConcreteValue v then checkRequires label addr s ps
      else .error (.required label addr p (headPresent s p))
    | none => .error (.required label addr p (headPresent s p))

/-- The reserved host state key. -/
def hostKey : String := "$host"

/-- `hostStateOf`. -/
def hostOf (s : State) : List (String × Value) :=
  match s.get hostKey with
  | some v => v.asObj
  | none => []

/-- Merge `decodeSubmission`'s host state into `$host`. -/
def withHost (s : State) (h : List (String × Value)) : State :=
  if h.isEmpty then s else s.set hostKey (.obj (State.setAll (hostOf s) h))

def evt (path : ExecPath) (text : String) : Event := ⟨path, text⟩

/-- `runNodeOnState` around a step body: start/end events and `hostPolicy.afterNode`. -/
def stepWrap (O : Oracle) (isStep : Bool) (ctx : Ctx) (r : Run) : Run :=
  if isStep then
    let start := evt ctx.path ("node.start:" ++ ctx.label)
    let fin (st : String) := evt ctx.path ("node.end:" ++ ctx.label ++ ":" ++ st)
    match r with
    | (.ok s, ev) =>
      match O.afterNode with
      | none => (.ok s, start :: ev ++ [fin "ok"])
      | some f =>
        let patch := f ctx s
        if (lookup hostKey patch).isSome then
          (.failed (.state .reservedStateKey ctx.label [hostKey]), start :: ev ++ [fin "failed"])
        else (.ok (s.setAll patch), start :: ev ++ [fin "ok"])
    | (.escalated e, ev) => (.escalated e, start :: ev ++ [fin "escalated"])
    | (.failed e, ev) => (.failed e, start :: ev ++ [fin "failed"])
  else r

/-! ## Parallel merge (the `parallel` case of `runNodeBody`) -/

/-- The keys a branch changed relative to the baseline (`$host` merges separately). -/
def patchOf (baseline out : State) : List (String × Value) :=
  out.entries.filter fun (k, v) =>
    k != hostKey && !(match baseline.get k with
      | some b => Value.eqv v b
      | none => false)

/-- Apply one branch's patch; `w` holds the keys earlier branches wrote. -/
def mergePatch : List (String × Value) → List String → State → Except String (List String × State)
  | [], w, m => .ok (w, m)
  | (k, v) :: rest, w, m => if w.contains k then .error k else mergePatch rest (k :: w) (m.set k v)

/-- Domain merge: apply each branch's patch in branch order; a key written by two
branches is a `parallel_write_conflict`. Returns the conflicting key on failure. -/
def mergePatches : List (List (String × Value)) → List String → State → Except String State
  | [], _, m => .ok m
  | p :: ps, w, m => match mergePatch p w m with
    | .ok (w', m') => mergePatches ps w' m'
    | .error k => .error k

/-- The host-state delta merge. `writer` tracks which keys some branch already wrote. -/
structure HostAcc where
  merged : List (String × Value)
  writer : List String
  changed : Bool

def hostStep (base : List (String × Value)) (acc : HostAcc) (kv : String × Value) :
    Except String HostAcc :=
  let (k, v) := kv
  if (match lookup k base with | some b => Value.eqv v b | none => false) then .ok acc else
  let acc := { acc with changed := true }
  if acc.writer.contains k && (match lookup k acc.merged with
      | some m => Value.eqv m v | none => false) then .ok acc else
  let b := lookup k base
  let appendable : Option (List Value) := match v with
    | .arr vs => match b with
      | none => some vs
      | some (.arr bs) =>
        if bs.length ≤ vs.length && Value.deepEqList bs (vs.take bs.length) then
          some (vs.drop bs.length) else none
      | some _ => none
    | _ => none
  match appendable with
  | some added =>
    let prior := match lookup k acc.merged with
      | some (.arr xs) => xs
      | _ => []
    .ok { acc with merged := State.set acc.merged k (.arr (prior ++ added)), writer := k :: acc.writer }
  | none =>
    if acc.writer.contains k && !(match lookup k acc.merged with
        | some m => Value.eqv m v | none => false) then .error k
    else .ok { acc with merged := State.set acc.merged k v, writer := k :: acc.writer }

def hostMergeAll (base : List (String × Value)) : HostAcc → List (String × Value) → Except String HostAcc
  | acc, [] => .ok acc
  | acc, kv :: rest => match hostStep base acc kv with
    | .ok acc' => hostMergeAll base acc' rest
    | .error k => .error k

def hostMerge (base : List (String × Value)) : HostAcc → List (List (String × Value)) → Except String HostAcc
  | acc, [] => .ok acc
  | acc, h :: hs => match hostMergeAll base acc (State.entries h) with
    | .ok acc' => hostMerge base acc' hs
    | .error k => .error k

/-- Merge completed branch states into the baseline. -/
def mergeParallel (label : String) (baseline : State) (outs : List State) : Outcome :=
  let base := hostOf baseline
  match hostMerge base ⟨base, [], false⟩ (outs.map hostOf) with
  | .error k => .failed (.state .parallelWriteConflict label [hostKey, k])
  | .ok acc =>
    let start := if acc.changed then baseline.set hostKey (.obj acc.merged) else baseline
    match mergePatches (outs.map (patchOf baseline)) [] start with
    | .ok m => .ok m
    | .error k => .failed (.state .parallelWriteConflict label [k])

/-- Collect concurrent results: all must complete, or the scheduler reports one failure. -/
def gather (O : Oracle) (rs : List Outcome) : Except Outcome (List State) :=
  let fails := rs.filter (!·.isOk)
  if fails.isEmpty then .ok (rs.filterMap fun | .ok s => some s | _ => none)
  else .error (O.choose fails)

/-! ## Loops -/

/-- Run a loop body up to `fuel` more times starting at iteration `i`. Returns the
outcome, the events, and `some n` when `until` held after `n` iterations. -/
def loopRun (body : Nat → State → Run) (untilP : Nat → State → Except Err Bool) :
    Nat → Nat → State → Outcome × List Event × Option Nat
  | 0, _, s => (.ok s, [], none)
  | k + 1, i, s =>
    match body i s with
    | (.ok s', ev) =>
      match untilP i s' with
      | .ok true => (.ok s', ev, some (i + 1))
      | .ok false =>
        let r := loopRun body untilP k (i + 1) s'
        (r.1, ev ++ r.2.1, r.2.2)
      | .error e => (.failed e, ev, none)
    | (o, ev) => (o, ev, none)

/-! ## Map -/

/-- Select a map item's result (`resultPath`, the body's `as`, or the whole item state). -/
def mapSelect (label : String) (bodyAs : Option String) (resultPath : Option Path) :
    Outcome → Outcome × Option Value
  | .ok s' => match resultPath with
    | some p => match getPathR (.obj s') p with
      | some v => (.ok s', some v)
      | none => (.failed (.state .missingMapResult label p), none)
    | none => match bodyAs with
      | some k => (.ok s', some ((s'.get k).getD .null))
      | none => (.ok s', some (.obj s'))
  | o => (o, none)

def runItems (f : Nat → Value → Run) : Nat → List Value → List Run
  | _, [] => []
  | i, x :: xs => f i x :: runItems f (i + 1) xs

def optionsOf (O : Oracle) (tmpl : String) (s : State) (items : List Value) : List String :=
  (List.range items.length).zip items |>.map fun (i, item) =>
    let t := O.render tmpl ((s.set "item" item).set "item_index" (.num i))
    if t.isEmpty then s!"item {i}" else t

def sidecarEmpty : Value :=
  .obj [("answers", .obj []), ("confidence", .obj []), ("weakest", .null), ("min_confidence", .null)]

def artifactRecord (type : String) (path : Option String) : Value :=
  let p := path.getD ""
  .obj [("path", .str p), ("filename", .str ((p.splitOn "/").getLast?.getD p)), ("type", .str type)]

def seg (i : Nat) : String := toString i

/-- A code node's state patch: `{[as]: out}`, the returned object itself, or `{[label]: out}`. -/
def codePatch (label : String) (as : Option String) (out : Value) : List (String × Value) :=
  match as with
  | some k => [(k, out)]
  | none => match out with
    | .obj kvs => kvs
    | v => [(label, v)]

/-- Keys of a list of named branches. -/
def branchNames (bs : List (String × Node)) : List String := bs.map (·.1)

mutual
/-- Run one node on a state. `path` is the execution path, `addr` the static address,
`lp` the label prefix of enclosing child invocations. -/
def eval (O : Oracle) : Node → ExecPath → Addr → String → State → Run
  | .chain steps, path, addr, lp, s => evalChain O steps 0 path addr lp s
  | .code label as, path, _, lp, s =>
    let ctx : Ctx := ⟨path, lp ++ label⟩
    stepWrap O true ctx <|
      match O.code ctx s with
      | .error m => (.failed (.adapter ctx.label m), [])
      | .ok out =>
        let patch := codePatch label as out
        if (lookup hostKey patch).isSome then
          (.failed (.state .reservedStateKey label [hostKey]), [])
        else (.ok (s.setAll patch), [])
  | .gen kind label _ as requires st verify, path, addr, lp, s =>
    let ctx : Ctx := ⟨path, lp ++ label⟩
    stepWrap O true ctx <|
      match checkRequires label addr s requires with
      | .error e => (.failed e, [])
      | .ok () => match promptState label s st with
        | .error e => (.failed e, [])
        | .ok asked => match O.gen ctx kind asked with
          | .error m => (.failed (.adapter ctx.label m), [])
          | .ok out =>
            let key := as.getD label
            let s1 := s.set key out.value
            let s2 := if verify.isSome then s1.set (key ++ "$verify") (out.verify.getD .null) else s1
            (.ok (withHost s2 out.host), [])
  | .report label requires st, path, addr, lp, s =>
    evalReport O label requires st path addr lp s
  | .artifact label type fpath requires st, path, addr, lp, s =>
    if artifactIsProse type then evalReport O label requires st path addr lp s else
    let ctx : Ctx := ⟨path, lp ++ label⟩
    stepWrap O true ctx <|
      match checkRequires label addr s requires with
      | .error e => (.failed e, [])
      | .ok () => (.ok (s.set "artifact" (artifactRecord type fpath)), [])
  | .map label itemsPath body as resultPath, path, addr, lp, s =>
    match getPathS s itemsPath with
    | some (.arr items) =>
      let runs := runItems (fun i item =>
        eval O body (path ++ ["items", seg i, "body"]) (addr ++ [.body]) lp
          ((s.set "item" item).set "item_index" (.num i))) 0 items
      let selected := runs.map fun r => mapSelect label body.asField resultPath r.1
      let ev := (runs.map (·.2)).flatten
      match gather O (selected.map (·.1)) with
      | .error o => (o, ev)
      | .ok _ => (.ok (s.set as (.arr (selected.map fun x => x.2.getD .null))), ev)
    | _ => (.failed (.state .expectedList label itemsPath), [])
  | .parallel label branches, path, addr, lp, s =>
    let runs := evalBranches O branches 0 path addr lp s
    let ev := (runs.map (·.2)).flatten
    match gather O (runs.map (·.1)) with
    | .error o => (o, ev)
    | .ok outs => (mergeParallel label s outs, ev)
  | .loop label body untilP maxIters, path, addr, lp, s =>
    let r := loopRun
      (fun i st => eval O body (path ++ ["iterations", seg i, "body"]) (addr ++ [.body]) lp st)
      (fun i st => evalPred O ⟨path ++ ["iterations", seg i], lp ++ label⟩ st untilP)
      maxIters 0 s
    match r with
    | (.ok s', ev, some n) =>
      (.ok s', ev ++ [evt path s!"loop.exited:{lp ++ label}:condition_met:{n}"])
    | (.ok s', ev, none) =>
      (.ok s', ev ++ [evt path s!"loop.exited:{lp ++ label}:bound_reached:{maxIters}"])
    | (o, ev, _) => (o, ev)
  | .escalate label when kind stage summary, path, _, lp, s =>
    match evalPred O ⟨path, lp ++ label⟩ s when with
    | .error e => (.failed e, [])
    | .ok fired =>
      let ev := [evt path s!"escalate.evaluated:{lp ++ label}:{fired}"]
      if fired then (.escalated ⟨kind, stage, summary, label, s, path⟩, ev) else (.ok s, ev)
  | .judge label st _ as requires, path, addr, lp, s =>
    let ctx : Ctx := ⟨path, lp ++ label⟩
    stepWrap O true ctx <|
      match checkRequires label addr s requires with
      | .error e => (.failed e, [])
      | .ok () => match promptState label s (some st) with
        | .error e => (.failed e, [])
        | .ok asked => match O.judge ctx asked with
          | .error m => (.failed (.adapter ctx.label m), [])
          | .ok (v, sidecar) => (.ok ((s.set as v).set (as ++ "$answers") sidecar), [])
  | .pick label itemsPath describe allowNone st as requires, path, addr, lp, s =>
    let ctx : Ctx := ⟨path, lp ++ label⟩
    stepWrap O true ctx <|
      match checkRequires label addr s requires with
      | .error e => (.failed e, [])
      | .ok () => match getPathS s itemsPath with
        | some (.arr items) =>
          if items.isEmpty then
            if allowNone then
              (.ok ((s.set as (.obj [("index", .null), ("item", .null), ("none", .bool true),
                ("option", .null)])).set (as ++ "$answers") sidecarEmpty), [])
            else (.failed (.state .emptySelection label itemsPath), [])
          else if items.length > 240 - (if allowNone then 1 else 0) then
            (.failed (.engine label "too many items for one choice"), [])
          else
            let options := optionsOf O describe s items
            match promptState label s st with
            | .error e => (.failed e, [])
            | .ok base =>
              let asked := Value.obj [("state", base), ("candidates", .arr (options.map .str))]
              match O.pick ctx asked items.length with
              | .error m => (.failed (.adapter ctx.label m), [])
              | .ok (none, sidecar) =>
                if allowNone then
                  (.ok ((s.set as (.obj [("index", .null), ("item", .null), ("none", .bool true),
                    ("option", .null)])).set (as ++ "$answers") sidecar), [])
                else (.failed (.engine label "no choice came back"), [])
              | .ok (some i, sidecar) =>
                match items[i]?, options[i]? with
                | some item, some opt =>
                  (.ok ((s.set as (.obj [("index", .num i), ("item", item), ("none", .bool false),
                    ("option", .str opt)])).set (as ++ "$answers") sidecar), [])
                | _, _ => (.failed (.engine label "the choice names no item"), [])
        | _ => (.failed (.state .expectedList label itemsPath), [])
  | .sift label itemsPath st _ questions keep as requires, path, addr, lp, s =>
    let ctx : Ctx := ⟨path, lp ++ label⟩
    stepWrap O true ctx <|
      match checkRequires label addr s requires with
      | .error e => (.failed e, [])
      | .ok () => match getPathS s itemsPath with
        | some (.arr items) =>
          if items.length * questions > O.questionLimit then
            (.failed (.engine label "questions exceed maxQuestionsPerRequest"), [])
          else if items.isEmpty then
            (.ok (s.set as (.obj [("items", .arr []), ("values", .arr []), ("answers", .arr []),
              ("kept", .arr [])])), [])
          else match promptState label s st with
            | .error e => (.failed e, [])
            | .ok base => match O.sift ctx (.obj [("state", base), ("items", .arr items)]) items.length with
              | .error m => (.failed (.adapter ctx.label m), [])
              | .ok answers =>
                if answers.length != items.length then
                  (.failed (.engine label "no answer for an item"), [])
                else
                  let kept : List Nat := ((List.range items.length).zip answers).filterMap fun (i, _, _, k) =>
                    if !keep || k then some i else none
                  (.ok (s.set as (.obj [
                    ("items", .arr (kept.filterMap fun i => items[i]?)),
                    ("values", .arr (answers.map (·.1))),
                    ("answers", .arr (answers.map (·.2.1))),
                    ("kept", .arr (kept.map fun (i : Nat) => Value.num (i : Rat)))])), [])
        | _ => (.failed (.state .expectedList label itemsPath), [])
  | .route label st branches unsure as requires, path, addr, lp, s =>
    let ctx : Ctx := ⟨path, lp ++ label⟩
    match checkRequires label addr s requires with
    | .error e => (.failed e, [])
    | .ok () => match promptState label s (some st) with
      | .error e => (.failed e, [])
      | .ok asked => match O.route ctx asked with
        | .error m => (.failed (.adapter ctx.label m), [])
        | .ok (choice, confidence, sidecar) =>
          if !(branchNames branches).contains choice then
            (.failed (.engine label "the choice names no branch"), [])
          else
            let isUnsure := match unsure with
              | some (_, gte) => decide (confidence < gte)
              | none => false
            let taken := match unsure with
              | some (b, _) => if isUnsure then b else choice
              | none => choice
            let value := Value.obj [("branch", .str choice), ("taken", .str taken), ("unsure", .bool isUnsure)]
            let routed := match as with
              | some k => (s.set k value).set (k ++ "$answers") sidecar
              | none => s
            let ev := [evt path s!"route.chosen:{lp ++ label}:{taken}"]
            match evalNamed O branches taken path addr lp routed with
            | some (o, ev') => (o, ev ++ ev')
            | none => (.failed (.engine label "the taken branch does not exist"), ev)
  | .call label _ input _ as _ requires, path, addr, lp, s =>
    let ctx : Ctx := ⟨path, lp ++ label⟩
    stepWrap O true ctx <|
      match checkRequires label addr s requires with
      | .error e => (.failed e, [])
      | .ok () => match interp s input with
        | .error p => (.failed (.state .missingInterpolation label p), [])
        | .ok args => match O.effect ctx args with
          | .error m => (.failed (.adapter ctx.label m), [])
          | .ok result => (.ok (s.set as result), [])
  | .workflow label child root input out as, path, addr, lp, s =>
    let ctx : Ctx := ⟨path, lp ++ label⟩
    stepWrap O true ctx <|
      match interpFields s input with
      | .error p => (.failed (.state .missingInterpolation label p), [])
      | .ok childInput =>
        if !(match child.input with
            | some id => O.schemaOk id (some (.obj childInput))
            | none => true) then (.failed (.outputInvalid label), [])
        else if (lookup hostKey childInput).isSome then (.failed (.inputInvalid child.name), [])
        else
          match eval O root (path ++ ["workflow", "root"]) (addr ++ [.child]) (lp ++ label ++ "/") childInput with
          | (.escalated e, ev) =>
            (.escalated { e with state := s, label := label ++ "/" ++ e.label }, ev)
          | (.failed e, ev) => (.failed e, ev)
          | (.ok cs, ev) =>
            let output := match child.outputPath with
              | some p => getPathS cs p
              | none => some (.obj (cs.erase hostKey))
            if !O.schemaOk child.output output then (.failed (.outputInvalid child.name), ev)
            else if !O.schemaOk out output then (.failed (.outputInvalid label), ev)
            else (.ok (s.setOpt as output), ev)

/-- The report writer (`report`, and prose `artifact` by the documented sugar). -/
def evalReport (O : Oracle) (label : String) (requires : List Path) (st : Option Tmpl)
    (path : ExecPath) (addr : Addr) (lp : String) (s : State) : Run :=
  let ctx : Ctx := ⟨path, lp ++ label⟩
  stepWrap O true ctx <|
    match checkRequires label addr s requires with
    | .error e => (.failed e, [])
    | .ok () => match promptState label s st with
      | .error e => (.failed e, [])
      | .ok asked => match O.report ctx asked with
        | .error m => (.failed (.adapter ctx.label m), [])
        | .ok out => (.ok (withHost (s.set "report_markdown" out.value) out.host), [])

def evalChain (O : Oracle) : List Node → Nat → ExecPath → Addr → String → State → Run
  | [], _, _, _, _, s => (.ok s, [])
  | n :: ns, i, path, addr, lp, s =>
    match eval O n (path ++ ["steps", seg i]) (addr ++ [.step i]) lp s with
    | (.ok s', ev) =>
      let r := evalChain O ns (i + 1) path addr lp s'
      (r.1, ev ++ r.2)
    | r => r

def evalBranches (O : Oracle) : List Node → Nat → ExecPath → Addr → String → State → List Run
  | [], _, _, _, _, _ => []
  | b :: bs, i, path, addr, lp, s =>
    eval O b (path ++ ["branches", seg i]) (addr ++ [.branch i]) lp s
      :: evalBranches O bs (i + 1) path addr lp s

def evalNamed (O : Oracle) : List (String × Node) → String → ExecPath → Addr → String → State → Option Run
  | [], _, _, _, _, _ => none
  | (name, body) :: rest, taken, path, addr, lp, s =>
    if name = taken then
      some (eval O body (path ++ ["branches", name, "body"]) (addr ++ [.named name]) lp s)
    else evalNamed O rest taken path addr lp s
end

end AgentRun
