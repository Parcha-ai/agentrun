import AgentRunSemantics.Value

/-!
# Syntax

The workflow AST. Constructor and field names follow `WorkflowNode` in
`packages/dsl/src/workflow.ts`. Content the semantics never inspects (instructions, SOP
sections, tools, effort, schema bodies, code text) is omitted: it only reaches the
oracles, which the theorems quantify over.
-/

namespace AgentRun

/-- A scalar literal in `field_equals` / `in`. -/
inductive Scalar where
  | str (s : String)
  | num (n : Rat)
  | bool (b : Bool)
  deriving Repr, Inhabited

/-- A fragment of an inline-interpolated string. -/
inductive TextPart where
  | lit (s : String)
  | ref (p : Path)
  deriving Repr, Inhabited

/-- An interpolated value (`interpolateValue`): a whole-string placeholder `"{p}"` keeps
the value's type; placeholders inside a longer string render as text. -/
inductive Tmpl where
  | lit (v : Value)
  | ref (p : Path)
  | text (parts : List TextPart)
  | arr (xs : List Tmpl)
  | obj (kvs : List (String × Tmpl))
  deriving Repr, Inhabited

/-- Predicates (`predicates.ts` plus `ask`). -/
inductive Pred where
  | noNewItems (key : Path)
  | fieldTrue (path : Path)
  | countGte (path : Path) (n : Rat)
  | empty (path : Path)
  | gte (path : Path) (n : Rat)
  | lt (path : Path) (n : Rat)
  | fieldEquals (path : Path) (value : Scalar)
  | isIn (path : Path) (values : List Scalar)
  /-- `{predicate: "ask"}`: a yes/no question answered by `runJudge`; holds when
  `p_yes ≥ gte` (default 0.6). -/
  | ask (gte : Option Rat) (state : Option Tmpl)
  deriving Repr, Inhabited

inductive GenKind where
  | agent
  | decide
  | extract
  deriving Repr, Inhabited, DecidableEq

inductive Via where
  | tool
  | executor
  | shell
  deriving Repr, Inhabited, DecidableEq

/-- What a workflow declares about itself (the non-recursive part of `Workflow`). -/
structure Header where
  name : String
  /-- Schema ids in `workflow.schemas`. Schema bodies are out of scope. -/
  schemas : List String
  input : Option String
  output : String
  outputPath : Option Path
  deriving Repr, Inhabited

inductive Node where
  | chain (steps : List Node)
  | code (label : String) (as : Option String)
  /-- `agent`, `decide`, `extract`: `verify` is the verify clause's question schema id. -/
  | gen (kind : GenKind) (label : String) (out : String) (as : Option String)
      (requires : List Path) (state : Option Tmpl) (verify : Option String)
  | report (label : String) (requires : List Path) (state : Option Tmpl)
  /-- A prose artifact (`type` "markdown" or "report") is sugar for `report`. -/
  | artifact (label : String) (type : String) (path : Option String)
      (requires : List Path) (state : Option Tmpl)
  | map (label : String) (itemsPath : Path) (body : Node) (as : String)
      (resultPath : Option Path)
  | parallel (label : String) (branches : List Node)
  | loop (label : String) (body : Node) («until» : Pred) (maxIters : Nat)
  | escalate (label : String) (when : Pred) (kind stage summary : String)
  | judge (label : String) (state : Tmpl) (out : String) (as : String) (requires : List Path)
  | pick (label : String) (itemsPath : Path) (describe : String) (allowNone : Bool)
      (state : Option Tmpl) (as : String) (requires : List Path)
  /-- `questions` is the number of questions in `out` (for the per-request question guard). -/
  | sift (label : String) (itemsPath : Path) (state : Option Tmpl) (out : String)
      (questions : Nat) (keep : Bool) (as : String) (requires : List Path)
  | dispatch (label : String) (valuePath : Path) (branches : List (String × Node))
      (otherwise : Option String) (as : Option String) (requires : List Path)
  | route (label : String) (state : Tmpl) (branches : List (String × Node))
      (unsure : Option (String × Rat)) (as : Option String) (requires : List Path)
  | call (label : String) (via : Via) (input : Tmpl) (out : Option String) (as : String)
      (produces : List String) (requires : List Path)
  /-- A child workflow invocation: the child's header and root are embedded. -/
  | workflow (label : String) (child : Header) (root : Node)
      (input : List (String × Tmpl)) (out : String) (as : String)
  deriving Repr, Inhabited

structure Workflow where
  header : Header
  root : Node
  deriving Repr, Inhabited

def artifactIsProse (type : String) : Bool := type == "markdown" || type == "report"

/-- The key a node's result lands under when read by `map` (`(node.body as any).as`). -/
def Node.asField : Node → Option String
  | .code _ as => as
  | .gen _ _ _ as _ _ _ => as
  | .map _ _ _ as _ => some as
  | .judge _ _ _ as _ => some as
  | .pick _ _ _ _ _ as _ => some as
  | .sift _ _ _ _ _ _ as _ => some as
  | .route _ _ _ _ as _ | .dispatch _ _ _ _ as _ => as
  | .call _ _ _ _ as _ _ => some as
  | .workflow _ _ _ _ _ as => some as
  | _ => none

end AgentRun
