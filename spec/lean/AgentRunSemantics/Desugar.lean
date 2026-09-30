import AgentRunSemantics.Syntax

/-!
# Desugaring (`desugarWorkflow`)

The only sugar: an `artifact` whose type is `markdown` or `report` is the report writer.
`desugarWorkflow` rewrites it to a `report` node (dropping `type` and `path`) and recurses
into every container, including child workflows.
-/

namespace AgentRun

mutual
def desugar : Node → Node
  | .artifact label type path requires st =>
    if artifactIsProse type then .report label requires st else .artifact label type path requires st
  | .chain steps => .chain (desugarList steps)
  | .parallel label branches => .parallel label (desugarList branches)
  | .map label itemsPath body as resultPath => .map label itemsPath (desugar body) as resultPath
  | .loop label body u n => .loop label (desugar body) u n
  | .dispatch label vp branches otherwise as requires => .dispatch label vp (desugarNamed branches) otherwise as requires
  | .route label st branches unsure as requires => .route label st (desugarNamed branches) unsure as requires
  | .workflow label child root input out as => .workflow label child (desugar root) input out as
  | n => n
def desugarList : List Node → List Node
  | [] => []
  | n :: ns => desugar n :: desugarList ns
def desugarNamed : List (String × Node) → List (String × Node)
  | [] => []
  | (name, n) :: rest => (name, desugar n) :: desugarNamed rest
end

def Workflow.desugar (wf : Workflow) : Workflow := { wf with root := AgentRun.desugar wf.root }

end AgentRun
