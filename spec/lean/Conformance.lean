import AgentRunSemantics.Json

/-!
# Conformance runner

`lake exe conformance [dir]` reads every `*.json` case in `dir` (default `conformance`),
runs the Lean model with oracles scripted by the case, and compares the result with the
case's `expected` block. `packages/dsl/test/lean-conformance.test.mjs` reads the same files
and compares the TypeScript interpreter against the same block.
-/

open Lean AgentRun AgentRun.JsonIn

/-! ## A minimal JSON Schema check (the `schemaOk` oracle for conformance cases) -/

partial def accepts (catalog : List (String × Json)) (schema : Json) (v : Option Value) : Bool :=
  let resolved := match get? schema "$ref" with
    | some (.str r) => ((catalog.find? (fun (k, _) => "#/definitions/" ++ k == r)).map (·.2)).getD schema
    | _ => schema
  let s := resolved
  match v with
  | none => (get? s "type").isNone && (get? s "enum").isNone && (get? s "anyOf").isNone
  | some v =>
    let typeOk := match get? s "type" with
      | none => true
      | some (.str t) => typeMatches t v
      | some (.arr ts) => ts.toList.any fun | .str t => typeMatches t v | _ => false
      | _ => false
    let enumOk := match get? s "enum" with
      | some (.arr es) => es.toList.any fun e => Value.deepEq (value e) v
      | _ => true
    let anyOfOk := match get? s "anyOf" with
      | some (.arr bs) => bs.toList.any fun b => accepts catalog b (some v)
      | _ => true
    let objOk := match v with
      | .obj kvs =>
        let props := fields ((get? s "properties").getD (.obj ∅))
        let reqOk := match get? s "required" with
          | some (.arr rs) => rs.toList.all fun | .str k => (lookup k kvs).isSome | _ => true
          | _ => true
        let propsOk := props.all fun (k, ps) => match lookup k kvs with
          | some x => accepts catalog ps (some x)
          | none => true
        let extraOk := match get? s "additionalProperties" with
          | some (.bool false) => kvs.all fun (k, _) => (props.find? (·.1 == k)).isSome
          | _ => true
        reqOk && propsOk && extraOk
      | _ => true
    let arrOk := match v, get? s "items" with
      | .arr xs, some it => xs.all fun x => accepts catalog it (some x)
      | _, _ => true
    let strOk := match v, get? s "minLength" with
      | .str t, some (.num n) => decide ((t.length : Rat) ≥ toRat n)
      | _, _ => true
    typeOk && enumOk && anyOfOk && objOk && arrOk && strOk
where
  typeMatches (t : String) : Value → Bool
    | .null => t == "null"
    | .bool _ => t == "boolean"
    | .num n => t == "number" || (t == "integer" && n.den == 1)
    | .str _ => t == "string"
    | .arr _ => t == "array"
    | .obj _ => t == "object"

/-- Every schema of the workflow and its children, by id. Conformance cases keep ids unique. -/
partial def catalogOf (j : Json) : List (String × Json) :=
  fields ((get? j "schemas").getD (.obj ∅)) ++ childCatalogs ((get? j "root").getD .null)
where
  childCatalogs (n : Json) : List (String × Json) :=
    let here := match get? n "workflow" with
      | some w => catalogOf w
      | none => []
    let kids := (match get? n "steps" with | some (.arr xs) => xs.toList | _ => []) ++
      (match get? n "branches" with
        | some (.arr xs) => xs.toList
        | some (.obj kvs) => kvs.toList.filterMap fun (_, b) => get? b "body"
        | _ => []) ++
      (match get? n "body" with | some b => [b] | none => [])
    here ++ kids.flatMap childCatalogs

/-! ## Scripted oracles -/

def entry (script : Json) (kind : String) (path : ExecPath) : Option Json :=
  (get? script kind).bind (get? · path.render)

def thrown (e : Json) : Option String :=
  match get? e "throw" with
  | some (.str m) => some m
  | _ => none

def roundTo4 (q : Rat) : Rat := ((q * 10000 + 1 / 2).floor : Rat) / 10000

def answerConfidence (a : Json) : Rat :=
  match strD a "type" with
  | "noul" => match get? a "noul" with
    | some (.num n) => let p := toRat n; (if p ≥ 1 / 2 then p - 1 / 2 else 1 / 2 - p) * 2
    | _ => 0
  | _ => match get? a "confidence" with
    | some (.num n) => toRat n
    | _ => 0

def answerValue (a : Json) : Value :=
  match strD a "type" with
  | "choice" => .str (strD a "choice")
  | "noul" => match get? a "noul" with
    | some (.num n) => .bool (decide (toRat n ≥ 1 / 2))
    | _ => .null
  | _ => match get? a "score" with
    | some (.num n) => .num (max 0 ((toRat n + 1 / 2).floor : Rat))
    | _ => .null

/-- `answersSidecar`. -/
def sidecarOf (answers : Json) : Value :=
  let cs := (fields answers).map fun (id, a) => (id, roundTo4 (answerConfidence a))
  let weakest := cs.foldl (fun acc (id, c) => match acc with
    | some (_, c') => if c < c' then some (id, c) else acc
    | none => some (id, c)) none
  .obj [("answers", value answers), ("confidence", .obj (cs.map fun (id, c) => (id, .num c))),
    ("weakest", match weakest with | some (id, _) => .str id | none => .null),
    ("min_confidence", match weakest with | some (_, c) => .num c | none => .null)]

/-- `describeItem`: text interpolation with `(path unset)`, whitespace collapsed. -/
def renderDescribe (tmplStr : String) (s : State) : String :=
  let text := String.join ((textParts tmplStr.toList "").map fun
    | .lit t => t
    | .ref p => match resolveRef s p with
      | some v => v.toText
      | none => "(" ++ ".".intercalate p ++ " unset)")
  " ".intercalate ((text.splitOn " ").flatMap (·.splitOn "\n") |>.filter (!·.isEmpty))

def scripted (catalog : List (String × Json)) (script : Json) : Oracle where
  code ctx _ := match entry script "code" ctx.path with
    | some e => match thrown e with
      | some m => .error m
      | none => .ok (value ((get? e "return").getD .null))
    | none => .error "no scripted code result"
  gen ctx _ _ := match entry script "gen" ctx.path with
    | some e => match thrown e with
      | some m => .error m
      | none => .ok { value := value ((get? e "submission").getD .null)
                      host := (fields ((get? e "host").getD (.obj ∅))).map fun (k, v) => (k, value v) }
    | none => .error "no scripted submission"
  report ctx _ := match entry script "gen" ctx.path with
    | some e => match thrown e with
      | some m => .error m
      | none => .ok { value := .str (strD e "markdown")
                      host := (fields ((get? e "host").getD (.obj ∅))).map fun (k, v) => (k, value v) }
    | none => .error "no scripted report"
  judge ctx _ := match entry script "judge" ctx.path with
    | some e => let answers := (get? e "answers").getD (.obj ∅)
      .ok (.obj ((fields answers).map fun (id, a) => (id, answerValue a)), sidecarOf answers)
    | none => .error "no scripted answers"
  pick ctx _ _ := match entry script "judge" ctx.path with
    | some e => let answers := (get? e "answers").getD (.obj ∅)
      let choice := strD ((get? answers "pick").getD .null) "choice"
      .ok (if choice == "none_of_these" then none else (choice.drop 5).toString.toNat?, sidecarOf answers)
    | none => .error "no scripted answers"
  sift _ _ _ := .error "sift is not scripted in conformance cases"
  route ctx _ := match entry script "judge" ctx.path with
    | some e => let answers := (get? e "answers").getD (.obj ∅)
      let a := (get? answers "branch").getD .null
      .ok (strD a "choice", answerConfidence a, sidecarOf answers)
    | none => .error "no scripted answers"
  effect ctx _ := match entry script "effect" ctx.path with
    | some e => match thrown e with
      | some m => .error m
      | none => .ok (value ((get? e "result").getD .null))
    | none => .error "no scripted effect result"
  ask ctx _ := match entry script "judge" ctx.path with
    | some e => match get? ((get? ((get? e "answers").getD .null) "holds").getD .null) "noul" with
      | some (.num n) => .ok (toRat n)
      | _ => .error "no yes/no answer"
    | none => .error "no scripted answers"
  schemaOk id v := match catalog.find? (·.1 == id) with
    | some (_, s) => accepts catalog s v
    | none => false
  afterNode := if (get? script "after").isSome then
      some fun ctx _ => (fields ((entry script "after" ctx.path).getD (.obj ∅))).map fun (k, v) => (k, value v)
    else none
  render := renderDescribe
  questionLimit := 256
  choose l := l.headD (.ok [])
  choose_mem l h := by cases l with
    | nil => exact absurd rfl h
    | cons a t => simp [List.headD]

/-! ## Comparison -/

def reasonName : StateReason → String
  | .missingInterpolation => "missing_interpolation"
  | .expectedList => "expected_list"
  | .emptySelection => "empty_selection"
  | .missingMapResult => "missing_map_result"
  | .parallelWriteConflict => "parallel_write_conflict"
  | .reservedStateKey => "reserved_state_key"

def errJson : Err → List (String × String)
  | .required l _ p _ => [("kind", "state"), ("reason", "required_nonempty"), ("label", l), ("path", ".".intercalate p)]
  | .state r l p => [("kind", "state"), ("reason", reasonName r), ("label", l), ("path", ".".intercalate p)]
  | .adapter _ _ => [("kind", "adapter")]
  | .engine _ _ => [("kind", "engine")]
  | .outputInvalid _ => [("kind", "output_invalid")]
  | .inputInvalid _ => [("kind", "input_invalid")]
  | .invalid => [("kind", "invalid")]

def lookupStr (k : String) : List (String × String) → Option String
  | [] => none
  | (k', v) :: rest => if k' == k then some v else lookupStr k rest

def groupEvents (evs : List Event) : List (String × List String) :=
  evs.foldl (fun acc e =>
    let k := e.path.render
    match acc.find? (·.1 == k) with
    | some _ => acc.map fun (k', ts) => if k' == k then (k', ts ++ [e.text]) else (k', ts)
    | none => acc ++ [(k, [e.text])]) []

def check (name : String) (c : Json) : Except String Unit := do
  let wfJson := (get? c "workflow").getD .null
  let wf ← workflow wfJson
  let input := state ((get? c "input").getD (.obj ∅))
  let exp := (get? c "expected").getD .null
  let O := scripted (catalogOf wfJson) ((get? c "script").getD (.obj ∅))
  let problems : Array String := #[]
  let valid := (validate wf (some input.keys)).ok
  let expValid := match get? exp "valid" with | some (.bool b) => b | _ => true
  let problems := if valid == expValid then problems else
    problems.push s!"valid: model {valid}, expected {expValid} ({(validate wf (some input.keys)).errors})"
  if !expValid then
    if problems.isEmpty then return () else throw s!"{name}: {problems.toList}"
  let r := runWorkflow O wf input
  let (kind, st) := match r.outcome with
    | .ok s => ("complete", some s)
    | .escalated e => ("escalated", some e.state)
    | .failed _ => ("failed", none)
  let problems := if kind == strD exp "outcome" then problems else
    problems.push s!"outcome: model {kind}, expected {strD exp "outcome"} ({repr r.outcome})"
  let problems := match st, get? exp "state" with
    | some s, some es => if Value.deepEq (.obj s) (value es) then problems else
        problems.push s!"state: model {(Value.obj s).toJs}, expected {(value es).toJs}"
    | _, _ => problems
  -- A complete run's output must agree on presence as well as content: JSON has no
  -- `undefined`, so an absent `output` field means the interpreter returned none.
  let expOutput : Option Json := match exp.getObjVal? "output" with
    | .ok j => some j
    | .error _ => none
  let problems := if kind != "complete" then problems else match r.output, expOutput with
    | some o, some eo => if Value.deepEq o (value eo) then problems else
        problems.push s!"output: model {o.toJs}, expected {(value eo).toJs}"
    | none, none => problems
    | some o, none => problems.push s!"output: model {o.toJs}, expected none"
    | none, some eo => problems.push s!"output: model none, expected {(value eo).toJs}"
  let problems := match r.outcome, get? exp "escalation" with
    | .escalated e, some ee =>
      if e.kind == strD ee "kind" && e.stage == strD ee "stage" && e.label == strD ee "label" then problems
      else problems.push s!"escalation: model {e.kind}/{e.stage}/{e.label}"
    | _, _ => problems
  let problems := match r.outcome, get? exp "error" with
    | .failed e, some ee =>
      let got := errJson e
      let want (k : String) (v : Json) : Bool :=
        (lookupStr k got) == some (match v with | .str s => s | _ => "")
      if (fields ee).all (fun (k, v) => want k v)
      then problems else problems.push s!"error: model {got}, expected {ee.compress}"
    | _, _ => problems
  let events := groupEvents r.events
  let texts (v : Json) : List String := match v with
    | .arr xs => xs.toList.map fun x => match x with | .str s => s | _ => ""
    | _ => []
  let expEvents : List (String × List String) :=
    (fields ((get? exp "events").getD (.obj ∅))).map fun (k, v) => (k, texts v)
  let sort (l : List (String × List String)) := l.mergeSort (fun a b => decide (a.1 ≤ b.1))
  let problems := if sort events == sort expEvents then problems else
    problems.push s!"events: model {sort events}, expected {sort expEvents}"
  if problems.isEmpty then return () else throw s!"{name}: {problems.toList}"

def main (args : List String) : IO UInt32 := do
  let dir : System.FilePath := args.headD "conformance"
  let entries ← dir.readDir
  let files := (entries.toList.map (·.path)).filter (·.extension == some "json")
    |>.mergeSort (fun a b => decide (a.toString ≤ b.toString))
  let mut failures := 0
  for f in files do
    let text ← IO.FS.readFile f
    match Json.parse text with
    | .error e => IO.eprintln s!"{f}: {e}"; failures := failures + 1
    | .ok j =>
      match check (f.fileName.getD f.toString) j with
      | .ok () => IO.println s!"ok   {f.fileName.getD ""}"
      | .error e => IO.eprintln s!"FAIL {e}"; failures := failures + 1
  IO.println s!"{files.length - failures}/{files.length} conformance cases agree with the model"
  return (if failures == 0 && !files.isEmpty then 0 else 1)
