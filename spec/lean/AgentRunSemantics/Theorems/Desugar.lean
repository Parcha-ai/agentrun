import AgentRunSemantics.Lemmas

/-!
# T4: desugaring preserves meaning

`desugarWorkflow` rewrites a prose `artifact` into a `report` and recurses into every
container. The model gives prose artifacts their documented meaning directly (the report
writer), so these theorems say: running the desugared node is running the node, for any
oracle; desugaring is idempotent; and validation and `runWorkflow` cannot tell a workflow
from its desugaring.
-/

namespace AgentRun

theorem asField_desugar (n : Node) : (desugar n).asField = n.asField := by
  cases n with
  | artifact l t p r st => by_cases h : artifactIsProse t <;> simp [desugar, Node.asField, h]
  | _ => rfl

mutual
theorem eval_desugar (O : Oracle) : ∀ (n : Node) (path : ExecPath) (addr : Addr) (lp : String) (s : State),
    eval O (desugar n) path addr lp s = eval O n path addr lp s
  | .chain steps, path, addr, lp, s => by
    simp only [desugar, eval]; exact evalChain_desugar O steps 0 path addr lp s
  | .code .., _, _, _, _ => rfl
  | .gen .., _, _, _, _ => rfl
  | .report .., _, _, _, _ => rfl
  | .artifact label type fpath requires st, path, addr, lp, s => by
    simp only [desugar]; split <;> simp_all [eval]
  | .map label itemsPath body as resultPath, path, addr, lp, s => by
    simp only [desugar, eval, asField_desugar, eval_desugar O body]
  | .parallel label branches, path, addr, lp, s => by
    simp only [desugar, eval, evalBranches_desugar O branches 0 path addr lp s]
  | .loop label body u n, path, addr, lp, s => by
    simp only [desugar, eval, eval_desugar O body]
  | .escalate .., _, _, _, _ => rfl
  | .judge .., _, _, _, _ => rfl
  | .pick .., _, _, _, _ => rfl
  | .sift .., _, _, _, _ => rfl
  | .dispatch label st branches unsure as requires, path, addr, lp, s => by
    simp only [desugar, eval]
    have hn : branchNames (desugarNamed branches) = branchNames branches := names_desugarNamed branches
    simp only [hn, evalNamed_desugar O branches]
  | .route label st branches unsure as requires, path, addr, lp, s => by
    simp only [desugar, eval]
    have hn : branchNames (desugarNamed branches) = branchNames branches := names_desugarNamed branches
    simp only [hn, evalNamed_desugar O branches]
  | .call .., _, _, _, _ => rfl
  | .workflow label child root input out as, path, addr, lp, s => by
    simp only [desugar, eval, eval_desugar O root]

theorem evalChain_desugar (O : Oracle) : ∀ (steps : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (s : State),
    evalChain O (desugarList steps) i path addr lp s = evalChain O steps i path addr lp s
  | [], _, _, _, _, _ => rfl
  | n :: ns, i, path, addr, lp, s => by
    simp only [desugarList, evalChain, eval_desugar O n, evalChain_desugar O ns]

theorem evalBranches_desugar (O : Oracle) : ∀ (bs : List Node) (i : Nat) (path : ExecPath) (addr : Addr) (lp : String) (s : State),
    evalBranches O (desugarList bs) i path addr lp s = evalBranches O bs i path addr lp s
  | [], _, _, _, _, _ => rfl
  | b :: bs, i, path, addr, lp, s => by
    simp only [desugarList, evalBranches, eval_desugar O b, evalBranches_desugar O bs]

theorem evalNamed_desugar (O : Oracle) : ∀ (bs : List (String × Node)) (taken : String) (path : ExecPath) (addr : Addr) (lp : String) (s : State),
    evalNamed O (desugarNamed bs) taken path addr lp s = evalNamed O bs taken path addr lp s
  | [], _, _, _, _, _ => rfl
  | (name, b) :: rest, taken, path, addr, lp, s => by
    simp only [desugarNamed, evalNamed, eval_desugar O b, evalNamed_desugar O rest]

theorem names_desugarNamed : ∀ (bs : List (String × Node)), branchNames (desugarNamed bs) = branchNames bs
  | [] => rfl
  | (name, _) :: rest => by
    have ih := names_desugarNamed rest
    simp only [branchNames] at ih ⊢
    simp only [desugarNamed, List.map_cons, ih]
end

mutual
theorem desugar_idem : ∀ n : Node, desugar (desugar n) = desugar n
  | .chain steps => by simp only [desugar, desugarList_idem steps]
  | .code .. => rfl
  | .gen .. => rfl
  | .report .. => rfl
  | .artifact label type fpath requires st => by
    simp only [desugar]; split <;> simp_all [desugar]
  | .map _ _ body _ _ => by simp only [desugar, desugar_idem body]
  | .parallel _ bs => by simp only [desugar, desugarList_idem bs]
  | .loop _ body _ _ => by simp only [desugar, desugar_idem body]
  | .escalate .. => rfl
  | .judge .. => rfl
  | .pick .. => rfl
  | .sift .. => rfl
  | .route _ _ bs _ _ _ | .dispatch _ _ bs _ _ _ => by simp only [desugar, desugarNamed_idem bs]
  | .call .. => rfl
  | .workflow _ _ root _ _ _ => by simp only [desugar, desugar_idem root]
theorem desugarList_idem : ∀ ns : List Node, desugarList (desugarList ns) = desugarList ns
  | [] => rfl
  | n :: ns => by simp only [desugarList, desugar_idem n, desugarList_idem ns]
theorem desugarNamed_idem : ∀ bs : List (String × Node), desugarNamed (desugarNamed bs) = desugarNamed bs
  | [] => rfl
  | (name, n) :: rest => by simp only [desugarNamed, desugar_idem n, desugarNamed_idem rest]
end

/-- **T4a.** Running the desugared node is running the node, for every oracle. -/
theorem T4_eval_desugar (O : Oracle) (n : Node) (path : ExecPath) (addr : Addr) (lp : String) (s : State) :
    eval O (desugar n) path addr lp s = eval O n path addr lp s :=
  eval_desugar O n path addr lp s

/-- **T4b.** Validation cannot tell a workflow from its desugaring. -/
theorem T4_validate_desugar (wf : Workflow) (keys : Option (List String)) :
    validate wf.desugar keys = validate wf keys := by
  simp only [validate, Workflow.desugar, desugar_idem]

/-- **T4c.** Neither can `runWorkflow`, for every oracle and input. -/
theorem T4_runWorkflow_desugar (O : Oracle) (wf : Workflow) (input : State) :
    runWorkflow O wf.desugar input = runWorkflow O wf input := by
  have hv := T4_validate_desugar wf (some input.keys)
  simp only [runWorkflow, hv]
  simp only [Workflow.desugar, desugar_idem]
  rfl

end AgentRun
