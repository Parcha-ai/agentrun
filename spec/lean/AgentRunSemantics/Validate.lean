import AgentRunSemantics.Desugar
import AgentRunSemantics.Semantics

/-!
# Validation: the structural rules of `validateWorkflow`

A decidable mirror of the graph rules in `validateWorkflow` (`workflow.ts`). In scope:
reachability of `requires`, `itemsPath` and interpolation heads (tracked while the
validator's `reachability` is knowable); the reserved `$` keys; parallel write
disjointness as `declaredWrites` computes it; loop bounds; terminal report/artifact
placement; output path producers; artifact files produced by earlier shell calls; child
workflows validated with their invocation's input keys.

Out of scope (need a JSON Schema engine or JavaScript): schema compilation and `$ref`s,
question schemas, typed path checks, code compilation and probes, predicate paths checked
against probed code shapes, numeric call bounds, unknown-key checks, the document shape
schema (including the rule that a node's host `metadata`, when present, is an object). These rules are intended to be a subset of the TypeScript rules. The validator sweep
checks that relationship on its corpus; it is not a proof of implementation equivalence.
-/

namespace AgentRun

/-- `s.startsWith("$")`, written with `front` so the kernel can evaluate it. -/
@[irreducible] def startsWithDollar (s : String) : Bool := s.front == '$'

mutual
def tmplRefs : Tmpl → List Path
  | .lit _ => []
  | .ref p => [p]
  | .text parts => textRefs parts
  | .arr xs => tmplRefsList xs
  | .obj kvs => tmplRefsFields kvs
def tmplRefsList : List Tmpl → List Path
  | [] => []
  | t :: ts => tmplRefs t ++ tmplRefsList ts
def tmplRefsFields : List (String × Tmpl) → List Path
  | [] => []
  | (_, t) :: rest => tmplRefs t ++ tmplRefsFields rest
def textRefs : List TextPart → List Path
  | [] => []
  | .lit _ :: rest => textRefs rest
  | .ref p :: rest => p :: textRefs rest
end

def Tmpl.isNonemptyObj : Tmpl → Bool
  | .obj (_ :: _) => true
  | _ => false

def predRefs : Pred → List Path
  | .ask _ (some t) => tmplRefs t
  | _ => []

/-- `predicateShapeErrors` (the structural part). -/
def predErrors : Pred → List String
  | .isIn p vs => (if p.isEmpty then ["in needs a path"] else []) ++
      (if vs.isEmpty then ["in needs a non-empty values list"] else [])
  | .gte p _ | .lt p _ => if p.isEmpty then ["gte/lt needs a path"] else []
  | .ask (some g) _ => if 1 / 2 < g && g ≤ 1 then [] else ["ask.gte must be in (0.5, 1]"]
  | _ => []

mutual
/-- `containsReportNode` (does not look inside child workflows). -/
def containsReport : Node → Bool
  | .report .. | .artifact .. => true
  | .chain steps => containsReportList steps
  | .parallel _ branches => containsReportList branches
  | .map _ _ body _ _ | .loop _ body _ _ => containsReport body
  | .route _ _ branches _ _ _ => containsReportNamed branches
  | _ => false
def containsReportList : List Node → Bool
  | [] => false
  | n :: ns => containsReport n || containsReportList ns
def containsReportNamed : List (String × Node) → Bool
  | [] => false
  | (_, n) :: rest => containsReport n || containsReportNamed rest
end

mutual
/-- `countReports`. -/
def countReports : Node → Nat
  | .report .. | .artifact .. => 1
  | .chain steps => countReportsList steps
  | .parallel _ branches => countReportsList branches
  | .map _ _ body _ _ | .loop _ body _ _ => countReports body
  | .route _ _ branches _ _ _ => countReportsNamed branches
  | _ => 0
def countReportsList : List Node → Nat
  | [] => 0
  | n :: ns => countReports n + countReportsList ns
def countReportsNamed : List (String × Node) → Nat
  | [] => 0
  | (_, n) :: rest => countReports n + countReportsNamed rest
end

/-- The `as` field as `declaredWrites` reads it (`typeof as === "string" && as.trim()`). -/
def Node.declaredAs : Node → Option String
  | .code _ as => as
  | .gen _ _ _ as _ _ _ => as
  | .map _ _ _ as _ => some as
  | .judge _ _ _ as _ => some as
  | .pick _ _ _ _ _ as _ => some as
  | .sift _ _ _ _ _ _ as _ => some as
  | .route _ _ _ _ as _ => as
  | .call _ _ _ _ as _ _ => some as
  | .workflow _ _ _ _ _ as => some as
  | _ => none

mutual
/-- `declaredWrites` exactly as `workflow.ts` computes it: a report's `report_markdown`,
otherwise the node's `as`; no descent into map bodies or child workflows. It ignores
labels, `<as>$answers`, `<as>$verify` and code patches. -/
def declaredWrites : Node → List String
  | .report .. => ["report_markdown"]
  | .map _ _ _ as _ => if as.isEmpty then [] else [as]
  | .chain steps => declaredWritesList steps
  | .parallel _ branches => declaredWritesList branches
  | .loop _ body _ _ => declaredWrites body
  | .route _ _ branches _ as _ => (match as with
      | some k => if k.isEmpty then [] else [k]
      | none => []) ++ declaredWritesNamed branches
  | n => match n.declaredAs with
    | some k => if k.isEmpty then [] else [k]
    | none => []
def declaredWritesList : List Node → List String
  | [] => []
  | n :: ns => declaredWrites n ++ declaredWritesList ns
def declaredWritesNamed : List (String × Node) → List String
  | [] => []
  | (_, n) :: rest => declaredWrites n ++ declaredWritesNamed rest
end

/-- Pairwise disjointness of per-branch key lists. -/
def pairwiseDisjoint : List (List String) → Bool
  | [] => true
  | ks :: rest => rest.all (fun ks' => ks.all (fun k => !ks'.contains k)) && pairwiseDisjoint rest

/-- The validator's running state: `reachability` (`none` once unknowable) and the files
declared by earlier shell calls. -/
structure VEnv where
  avail : Option (List String)
  produced : List String
  schemas : List String

structure VOut where
  avail : Option (List String)
  produced : List String
  errors : List String := []
  /-- Ghost: nodes whose `requires` were checked against a knowable reachability. -/
  checked : List Addr := []
  mayEscalate : Bool := false

def headOf : Path → String
  | k :: _ => k
  | [] => ""

/-- `checkInterpolations` over the placeholders of a template. -/
def interpErrors (avail : Option (List String)) (refs : List Path) : List String :=
  match avail with
  | none => []
  | some A => refs.filterMap fun p =>
    match p with
    | "state" :: _ :: _ => if A.contains "state" then none else
        let h := headOf p.tail
        if A.contains h then none else some s!"interpolates a path with no upstream producer ({h})"
    | _ => let h := headOf p
        if A.contains h then none else some s!"interpolates a path with no upstream producer ({h})"

/-- `checkRequires`: heads only, and only while reachability is knowable. -/
def requiresErrors (avail : Option (List String)) (requires : List Path) : List String :=
  match avail with
  | none => []
  | some A => requires.filterMap fun p =>
    if A.contains (headOf p) then none else some s!"requires {headOf p} but no upstream node produces it"

def checkedAt (avail : Option (List String)) (addr : Addr) : List Addr :=
  if avail.isSome then [addr] else []

def addAvail (avail : Option (List String)) (ks : List String) : Option (List String) :=
  avail.map (· ++ ks)

def itemsErrors (avail : Option (List String)) (p : Path) : List String :=
  (if p.isEmpty then ["itemsPath required"] else []) ++
  match avail with
  | some A => if A.contains (headOf p) then [] else ["itemsPath has no upstream producer"]
  | none => []

/-- The reserved-key rules applied to every node. -/
def dollarErrors : Node → List String
  | .code label as | .gen _ label _ as _ _ _ =>
    match as with
    | some k => if startsWithDollar k then ["\"as\" must not name an engine-owned \"$\" state key"] else []
    | none => if startsWithDollar label then ["label must not begin with \"$\""] else []
  | n => match n.declaredAs with
    | some k => if startsWithDollar k then ["\"as\" must not name an engine-owned \"$\" state key"] else []
    | none => []

def workspaceRelative (f : String) : Bool :=
  !f.isEmpty && f.front != '/' && !(f.splitOn "/").contains ".."

/-- The produces lists of a child's top-level call steps. -/
def topProduces : Node → List String
  | .chain steps => steps.flatMap fun | .call _ _ _ _ _ produces _ => produces | _ => []
  | .call _ _ _ _ _ produces _ => produces
  | _ => []

def rootSteps : Node → List Node
  | .chain steps => steps
  | n => [n]

def Node.isTerminal : Node → Bool
  | .report .. | .artifact .. => true
  | _ => false

/-- The checks `validateWorkflow` makes after walking the graph. -/
def finishCore (h : Header) (root : Node) (r : VOut) : VOut :=
  let headerErrors := (if h.schemas.contains h.output then [] else ["workflow.output.schemaId must name a schema"]) ++
    (match h.input with
      | some id => if h.schemas.contains id then [] else ["workflow.input.schemaId must name a schema"]
      | none => [])
  let total := countReports root
  let terminalErrors :=
    if total > 1 then ["root: at most ONE terminal node (report or artifact)"]
    else if total = 1 then
      match (rootSteps root).getLast? with
      | some last => if last.isTerminal then [] else ["root: the terminal node must be the LAST step of the root chain"]
      | none => ["root: the terminal node must be the LAST step of the root chain"]
    else []
  let outputErrors := match r.avail, h.outputPath with
    | some A, some p => if r.mayEscalate || A.contains (headOf p) then [] else ["output: path has no input or upstream producer"]
    | _, _ => []
  { r with errors := headerErrors ++ r.errors ++ terminalErrors ++ outputErrors }

mutual
def walk : Node → Addr → VEnv → VOut
  | n@(.chain steps), addr, env =>
    let r := walkList steps 0 addr env
    { r with errors := dollarErrors n ++ (if steps.isEmpty then ["chain needs steps"] else []) ++ r.errors }
  | n@(.code _ _), _, env =>
    { avail := none, produced := env.produced, errors := dollarErrors n }
  | n@(.gen _ label out as requires st verify), addr, env =>
    let key := as.getD label
    { avail := addAvail env.avail ([key] ++ if verify.isSome then [key ++ "$verify"] else [])
      produced := env.produced
      errors := dollarErrors n ++ interpErrors env.avail ((st.map tmplRefs).getD []) ++
        (if env.schemas.contains out then [] else ["out schema not in workflow.schemas"]) ++
        (match verify with
          | some v => if env.schemas.contains v then [] else ["verify.out not in workflow.schemas"]
          | none => []) ++
        requiresErrors env.avail requires
      checked := checkedAt env.avail addr }
  | n@(.report _ requires st), addr, env =>
    { avail := addAvail env.avail ["report_markdown"], produced := env.produced
      errors := dollarErrors n ++ interpErrors env.avail ((st.map tmplRefs).getD []) ++
        requiresErrors env.avail requires
      checked := checkedAt env.avail addr }
  | n@(.artifact _ type path requires st), addr, env =>
    if artifactIsProse type then
      { avail := addAvail env.avail ["report_markdown"], produced := env.produced
        errors := dollarErrors n ++ interpErrors env.avail ((st.map tmplRefs).getD []) ++
          requiresErrors env.avail requires
        checked := checkedAt env.avail addr }
    else
      { avail := addAvail env.avail ["artifact"], produced := env.produced
        errors := dollarErrors n ++ (if type.isEmpty then ["artifact type must be a non-empty string"] else []) ++
          (if st.isSome then ["a file artifact has no model in the loop"] else []) ++
          (match path with
            | some f => if !workspaceRelative f then ["path must be a workspace-relative file"]
              else if env.avail.isSome && !env.produced.contains f then ["path is not produced by any earlier shell call"]
              else []
            | none => ["path must be a workspace-relative file"]) ++
          requiresErrors env.avail requires
        checked := checkedAt env.avail addr }
  | n@(.map _ itemsPath body as _), addr, env =>
    let r := walk body (addr ++ [.body]) { env with avail := none }
    { r with
      errors := dollarErrors n ++ itemsErrors env.avail itemsPath ++
        (if as.isEmpty then ["as required"] else []) ++
        (if containsReport body then ["a report node cannot live inside a map body"] else []) ++ r.errors
      avail := none }
  | n@(.parallel _ branches), addr, env =>
    let r := walkBranches branches 0 addr { env with avail := none }
    { r with
      errors := dollarErrors n ++ (if branches.length < 2 then ["parallel needs at least two branches"] else []) ++
        (if containsReport n then ["a report node cannot live inside a parallel branch"] else []) ++
        (if pairwiseDisjoint (branches.map declaredWrites) then [] else ["parallel branches must write disjoint keys"]) ++
        r.errors
      avail := none }
  | n@(.loop _ body u maxIters), addr, env =>
    let r := walk body (addr ++ [.body]) { env with avail := none }
    { r with
      errors := dollarErrors n ++ (if 1 ≤ maxIters && maxIters ≤ 20 then [] else ["maxIters must be 1..20"]) ++
        (if containsReport body then ["a report node cannot live inside a loop body"] else []) ++
        predErrors u ++ interpErrors env.avail (predRefs u) ++ r.errors
      avail := none }
  | n@(.escalate _ w kind stage summary), _, env =>
    { avail := env.avail, produced := env.produced, mayEscalate := true
      errors := dollarErrors n ++ predErrors w ++ interpErrors env.avail (predRefs w) ++
        (if kind.isEmpty || stage.isEmpty || summary.isEmpty then ["kind, stage, summary required"] else []) }
  | n@(.judge _ st out as requires), addr, env =>
    { avail := addAvail env.avail [as, as ++ "$answers"], produced := env.produced
      errors := dollarErrors n ++ (if st.isNonemptyObj then [] else ["state must be a non-empty object map"]) ++
        interpErrors env.avail (tmplRefs st) ++
        (if env.schemas.contains out then [] else ["out schema not in workflow.schemas"]) ++
        (if as.isEmpty then ["as required"] else []) ++ requiresErrors env.avail requires
      checked := checkedAt env.avail addr }
  | n@(.pick _ itemsPath _ _ st as requires), addr, env =>
    { avail := addAvail env.avail [as, as ++ "$answers"], produced := env.produced
      errors := dollarErrors n ++ itemsErrors env.avail itemsPath ++
        interpErrors env.avail ((st.map tmplRefs).getD []) ++
        (if as.isEmpty then ["as required"] else []) ++ requiresErrors env.avail requires
      checked := checkedAt env.avail addr }
  | n@(.sift _ itemsPath st out _ _ as requires), addr, env =>
    { avail := addAvail env.avail [as], produced := env.produced
      errors := dollarErrors n ++ itemsErrors env.avail itemsPath ++
        interpErrors env.avail ((st.map tmplRefs).getD []) ++
        (if env.schemas.contains out then [] else ["out schema not in workflow.schemas"]) ++
        (if as.isEmpty then ["as required"] else []) ++ requiresErrors env.avail requires
      checked := checkedAt env.avail addr }
  | n@(.route _ st branches unsure as requires), addr, env =>
    let names := branchNames branches
    let r := walkNamed branches addr { env with avail := none }
    { r with
      errors := dollarErrors n ++ (if st.isNonemptyObj then [] else ["state must be a non-empty object map"]) ++
        interpErrors env.avail (tmplRefs st) ++
        (if names.length < 2 then ["route needs at least two named branches"] else []) ++
        -- JSON object keys are unique; the list representation must say so explicitly.
        (if names.Nodup then [] else ["route branch names must be distinct"]) ++
        (if names.length > 240 then ["route takes at most 240 branches"] else []) ++
        (match unsure with
          | some (b, g) => (if names.contains b then [] else ["unsure.branch must name one of the branches"]) ++
              (if 0 < g && g ≤ 1 then [] else ["unsure.gte must be in (0, 1]"])
          | none => []) ++
        (if containsReport n then ["a report node cannot live inside a route branch"] else []) ++
        (match as with
          | some k => if k.isEmpty then ["as must be a state key when present"] else []
          | none => []) ++
        requiresErrors env.avail requires ++ r.errors
      checked := checkedAt env.avail addr ++ r.checked
      avail := none }
  | n@(.call _ via input out as produces requires), addr, env =>
    { avail := addAvail env.avail [as], produced := env.produced ++ produces
      errors := dollarErrors n ++
        (match via, out with
          | .shell, some _ => ["a shell call's result is the fixed shell shape; drop out"]
          | .shell, none => []
          | _, some o => if env.schemas.contains o then [] else ["out schema not in workflow.schemas"]
          | _, none => ["out schema required"]) ++
        (if via != .shell && !produces.isEmpty then ["only a via shell call may declare produces"] else []) ++
        (if produces.all workspaceRelative then [] else ["produces must be non-empty workspace-relative paths"]) ++
        (if as.isEmpty then ["as required"] else []) ++
        requiresErrors env.avail requires ++ interpErrors env.avail (tmplRefs input)
      checked := checkedAt env.avail addr }
  | n@(.workflow label child root input out as), addr, env =>
    let c := finishCore child root (walk root (addr ++ [.child]) ⟨some (input.map (·.1)), [], child.schemas⟩)
    { avail := addAvail env.avail [as], produced := env.produced ++ topProduces root
      errors := dollarErrors n ++ (if label.isEmpty || as.isEmpty then ["a workflow invocation requires label and as"] else []) ++
        (if env.schemas.contains out then [] else ["out schema not in workflow.schemas"]) ++
        (if input.any (fun field => field.1 == "$host") then ["input must not contain the reserved $host key"] else []) ++
        (if containsReport root then ["a child cannot render a report or deliver an artifact"] else []) ++
        (match child.input with
          | some id => if child.schemas.contains id then [] else ["the child must declare input.schemaId"]
          | none => ["the child must declare input.schemaId"]) ++
        c.errors ++ interpErrors env.avail (tmplRefsFields input)
      checked := c.checked }

def walkList : List Node → Nat → Addr → VEnv → VOut
  | [], _, _, env => { avail := env.avail, produced := env.produced }
  | n :: ns, i, addr, env =>
    let r := walk n (addr ++ [.step i]) env
    let r' := walkList ns (i + 1) addr { env with avail := r.avail, produced := r.produced }
    { r' with errors := r.errors ++ r'.errors, checked := r.checked ++ r'.checked
              mayEscalate := r.mayEscalate || r'.mayEscalate }

def walkBranches : List Node → Nat → Addr → VEnv → VOut
  | [], _, _, env => { avail := env.avail, produced := env.produced }
  | n :: ns, i, addr, env =>
    let r := walk n (addr ++ [.branch i]) env
    let r' := walkBranches ns (i + 1) addr { env with avail := r.avail, produced := r.produced }
    { r' with errors := r.errors ++ r'.errors, checked := r.checked ++ r'.checked
              mayEscalate := r.mayEscalate || r'.mayEscalate }

def walkNamed : List (String × Node) → Addr → VEnv → VOut
  | [], _, env => { avail := env.avail, produced := env.produced }
  | (name, n) :: rest, addr, env =>
    let r := walk n (addr ++ [.named name]) env
    let r' := walkNamed rest addr { env with avail := r.avail, produced := r.produced }
    { r' with errors := r.errors ++ r'.errors, checked := r.checked ++ r'.checked
              mayEscalate := r.mayEscalate || r'.mayEscalate }

end

/-- One `validateWorkflow` call on an already-desugared workflow. -/
def validateCore (h : Header) (root : Node) (inputKeys : Option (List String)) (addr : Addr) : VOut :=
  finishCore h root (walk root addr ⟨inputKeys, [], h.schemas⟩)

/-- `validateWorkflow(workflow, { inputKeys })`: desugar, then check. -/
def validate (wf : Workflow) (inputKeys : Option (List String)) : VOut :=
  validateCore wf.header (desugar wf.root) inputKeys []

def VOut.ok (r : VOut) : Bool := r.errors.isEmpty

end AgentRun
