import Lean.Data.Json
import AgentRunSemantics.Run

/-!
# JSON front end (conformance only)

Reads Workflow v2 JSON into the AST. Fields the model does not use are ignored; a field
the model needs but cannot represent (a fractional `maxIters`, an unknown node kind) is a
parse error, so a conformance case can never silently test less than it says. A node's
host `metadata` is one of the ignored fields by design: the engine never reads it, so the
model has nothing to represent.
-/

namespace AgentRun.JsonIn
open Lean

abbrev P := Except String

def splitPath (s : String) : Path := s.splitOn "."

def toRat (n : JsonNumber) : Rat := (n.mantissa : Rat) / ((10 : Rat) ^ n.exponent)

partial def value : Json → Value
  | .null => .null
  | .bool b => .bool b
  | .num n => .num (toRat n)
  | .str s => .str s
  | .arr xs => .arr (xs.toList.map value)
  | .obj kvs => .obj (kvs.toList.map fun (k, v) => (k, value v))

def fields (j : Json) : List (String × Json) :=
  match j with
  | .obj kvs => kvs.toList
  | _ => []

def get? (j : Json) (k : String) : Option Json :=
  match j.getObjVal? k with
  | .ok .null => none
  | .ok v => some v
  | .error _ => none

def str (j : Json) (k : String) : P String :=
  match get? j k with
  | some (.str s) => .ok s
  | some _ => .error s!"field {k} must be a string"
  | none => .error s!"field {k} is required"

def strD (j : Json) (k : String) (d : String := "") : String :=
  match get? j k with
  | some (.str s) => s
  | _ => d

def optStr (j : Json) (k : String) : Option String :=
  match get? j k with
  | some (.str s) => if s.isEmpty then none else some s
  | _ => none

def isPlaceholderChar (c : Char) : Bool := c.isAlphanum || c == '_' || c == '.' || c == '$'

/-- Split a string into literal text and `{path}` placeholders (the interpolation regex). -/
partial def textParts (cs : List Char) (acc : String) : List TextPart :=
  match cs with
  | [] => if acc.isEmpty then [] else [.lit acc]
  | '{' :: rest =>
    let name := rest.takeWhile isPlaceholderChar
    match rest.drop name.length with
    | '}' :: after =>
      if name.isEmpty then textParts after (acc ++ "{}") else
      (if acc.isEmpty then [] else [TextPart.lit acc]) ++
        TextPart.ref (splitPath (String.ofList name)) :: textParts after ""
    | _ => textParts rest (acc.push '{')
  | c :: rest => textParts rest (acc.push c)

partial def tmpl : Json → Tmpl
  | .str s =>
    match textParts s.toList "" with
    | [.ref p] => .ref p
    | parts => if parts.all (fun | .lit _ => true | _ => false) then .lit (.str s) else .text parts
  | .arr xs => .arr (xs.toList.map tmpl)
  | .obj kvs => .obj (kvs.toList.map fun (k, v) => (k, tmpl v))
  | j => .lit (value j)

def rat (j : Json) (k : String) : P Rat :=
  match get? j k with
  | some (.num n) => .ok (toRat n)
  | _ => .error s!"field {k} must be a number"

def scalar : Json → P Scalar
  | .str s => .ok (.str s)
  | .num n => .ok (.num (toRat n))
  | .bool b => .ok (.bool b)
  | _ => .error "a predicate value must be a string, number or boolean"

def pred (j : Json) : P Pred := do
  let name ← str j "predicate"
  let path := splitPath (strD j "path")
  match name with
  | "no_new_items" => pure (.noNewItems (splitPath (strD j "key")))
  | "field_true" => pure (.fieldTrue path)
  | "count_gte" => pure (.countGte path (← rat j "n"))
  | "empty" => pure (.empty path)
  | "gte" => pure (.gte path (← rat j "n"))
  | "lt" => pure (.lt path (← rat j "n"))
  | "field_equals" => pure (.fieldEquals path (← scalar ((get? j "value").getD .null)))
  | "in" => match get? j "values" with
    | some (.arr xs) => pure (.isIn path (← xs.toList.mapM scalar))
    | _ => throw "in needs values"
  | "ask" => pure (.ask ((get? j "gte").bind fun | .num n => some (toRat n) | _ => none)
      ((get? j "state").map tmpl))
  | other => throw s!"unknown predicate {other}"

def requires (j : Json) : List Path :=
  match get? j "requires" with
  | some (.arr xs) => xs.toList.filterMap fun | .str s => some (splitPath s) | _ => none
  | _ => []

def optTmpl (j : Json) (k : String) : Option Tmpl := (get? j k).map tmpl

/-- The number of properties (questions) of a schema in a catalog. -/
def questionCount (schemas : Json) (id : String) : Nat :=
  match get? schemas id with
  | some s => match get? s "properties" with
    | some p => (fields p).length
    | none => 0
  | none => 0

mutual
partial def node (schemas : Json) (j : Json) : P Node := do
  let kind ← str j "node"
  let label := strD j "label"
  match kind with
  | "chain" => match get? j "steps" with
    | some (.arr xs) => pure (.chain (← xs.toList.mapM (node schemas)))
    | _ => throw "chain needs steps"
  | "code" => pure (.code label (optStr j "as"))
  | "agent" | "decide" | "extract" =>
    let k : GenKind := if kind == "agent" then .agent else if kind == "decide" then .decide else .extract
    pure (.gen k label (strD j "out") (optStr j "as") (requires j) (optTmpl j "state")
      ((get? j "verify").bind fun v => optStr v "out"))
  | "report" => pure (.report label (requires j) (optTmpl j "state"))
  | "artifact" => pure (.artifact label (strD j "type") (optStr j "path") (requires j) (optTmpl j "state"))
  | "map" => pure (.map label (splitPath (strD j "itemsPath")) (← node schemas ((get? j "body").getD .null))
      (strD j "as") ((optStr j "resultPath").map splitPath))
  | "parallel" => match get? j "branches" with
    | some (.arr xs) => pure (.parallel label (← xs.toList.mapM (node schemas)))
    | _ => throw "parallel needs branches"
  | "loop" =>
    let n ← match get? j "maxIters" with
      | some (.num ⟨m, 0⟩) => if m ≥ 0 then pure m.toNat else throw "maxIters must be a natural number"
      | _ => throw "maxIters must be an integer"
    pure (.loop label (← node schemas ((get? j "body").getD .null)) (← pred ((get? j "until").getD .null)) n)
  | "escalate" => pure (.escalate label (← pred ((get? j "when").getD .null)) (strD j "kind")
      (strD j "stage") (strD j "summary"))
  | "judge" => pure (.judge label ((optTmpl j "state").getD (.obj [])) (strD j "out") (strD j "as") (requires j))
  | "pick" => pure (.pick label (splitPath (strD j "itemsPath")) (strD j "describe")
      (match get? j "allowNone" with | some (.bool b) => b | _ => false)
      (optTmpl j "state") (strD j "as") (requires j))
  | "sift" => pure (.sift label (splitPath (strD j "itemsPath")) (optTmpl j "state") (strD j "out")
      (questionCount schemas (strD j "out")) (get? j "keep").isSome (strD j "as") (requires j))
  | "route" =>
    let bs ← (fields ((get? j "branches").getD .null)).mapM fun (name, b) => do
      pure (name, ← node schemas ((get? b "body").getD .null))
    let unsure ← match get? j "unsure" with
      | some u => pure (some (← str u "branch", ← rat u "gte"))
      | none => pure none
    pure (.route label ((optTmpl j "state").getD (.obj [])) bs unsure (optStr j "as") (requires j))
  | "call" =>
    let via : Via := match strD j "via" with
      | "executor" => .executor
      | "shell" => .shell
      | _ => .tool
    let input : Tmpl := match via with
      | .tool => (optTmpl j "args").getD (.obj [])
      | .executor => (optTmpl j "input").getD (.obj [])
      | .shell => .obj ([("command", Tmpl.lit (.str (strD j "command")))] ++
          match optTmpl j "env" with | some e => [("env", e)] | none => [])
    let produces := match get? j "produces" with
      | some (.arr xs) => xs.toList.filterMap fun | .str s => some s | _ => none
      | _ => []
    pure (.call label via input (optStr j "out") (strD j "as") produces (requires j))
  | "workflow" =>
    let (h, root) ← workflowParts ((get? j "workflow").getD .null)
    let input := (fields ((get? j "input").getD (.obj ∅))).map fun (k, v) => (k, tmpl v)
    pure (.workflow label h root input (strD j "out") (strD j "as"))
  | other => throw s!"unknown node kind {other}"

partial def workflowParts (j : Json) : P (Header × Node) := do
  let schemas := (get? j "schemas").getD (.obj ∅)
  let output := (get? j "output").getD .null
  let h : Header := {
    name := strD j "name"
    schemas := (fields schemas).map (·.1)
    input := (get? j "input").bind fun i => optStr i "schemaId"
    output := strD output "schemaId"
    outputPath := (optStr output "path").map splitPath }
  pure (h, ← node schemas ((get? j "root").getD .null))
end

def workflow (j : Json) : P Workflow := do
  let (h, root) ← workflowParts j
  pure ⟨h, root⟩

def state (j : Json) : State := (fields j).map fun (k, v) => (k, value v)

end AgentRun.JsonIn
