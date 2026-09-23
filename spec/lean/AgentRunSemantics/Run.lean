import AgentRunSemantics.Validate

/-!
# `runWorkflow`

The entry point: validate with the input's keys, check the input, run the desugared root,
project and check the output. Recovery, checkpoints, cancellation and adapter admission
(`assertWorkflowCapabilities`) are out of scope.
-/

namespace AgentRun

structure RunResult where
  outcome : Outcome
  events : List Event
  output : Option Value := none
  deriving Repr

/-- The output projection: `output.path`, or the whole state without `$host`. -/
def projectOutput (h : Header) (s : State) : Option Value :=
  match h.outputPath with
  | some p => getPathS s p
  | none => some (.obj (s.erase hostKey))

def runWorkflow (O : Oracle) (wf : Workflow) (input : State) : RunResult :=
  if !(validate wf (some input.keys)).ok then ⟨.failed .invalid, [], none⟩
  else if !(match wf.header.input with
      | some id => O.schemaOk id (some (.obj input))
      | none => true) then ⟨.failed (.inputInvalid wf.header.name), [], none⟩
  else if input.has hostKey then ⟨.failed (.inputInvalid wf.header.name), [], none⟩
  else
    match eval O (desugar wf.root) ["root"] [] "" input with
    | (.ok s, ev) =>
      let output := projectOutput wf.header s
      if O.schemaOk wf.header.output output then ⟨.ok s, ev, output⟩
      else ⟨.failed (.outputInvalid wf.header.name), ev, none⟩
    | (o, ev) => ⟨o, ev, none⟩

end AgentRun
