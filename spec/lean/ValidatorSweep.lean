import AgentRunSemantics.Json

/-!
# Validator sweep

`lake exe validator-sweep corpus.json` reads the corpus built by `sweep/collect.mjs` and
checks the direction every theorem depends on: the Lean validator accepts each workflow
the TypeScript validator accepts, with the same input keys. A rule that lands in the Lean
mirror but not in `validateWorkflow`, or a TypeScript rule that is relaxed without the
mirror following, fails here.
-/

open Lean AgentRun AgentRun.JsonIn

def main (args : List String) : IO UInt32 := do
  let path : System.FilePath := args.headD ".lake/validator-corpus.json"
  let corpus ← match Json.parse (← IO.FS.readFile path) with
    | .ok (.arr xs) => pure xs.toList
    | _ => do IO.eprintln s!"{path}: not a JSON array"; return 1
  let mut accepted := 0
  let mut failures := 0
  let mut bothReject := 0
  let mut onlyLeanRejects := 0
  for entry in corpus do
    let tsAccepts := match get? entry "tsAccepts" with | some (.bool b) => b | _ => false
    let keys : Option (List String) := match get? entry "inputKeys" with
      | some (.arr ks) => some (ks.toList.filterMap fun | .str k => some k | _ => none)
      | _ => none
    let source := strD entry "source"
    match workflow ((get? entry "workflow").getD .null) with
    | .error e =>
      if tsAccepts then
        failures := failures + 1
        IO.eprintln s!"FAIL {source}: the TypeScript validator accepts a workflow the model cannot read: {e}"
      else bothReject := bothReject + 1
    | .ok wf =>
      let r := validate wf keys
      if tsAccepts then
        accepted := accepted + 1
        if !r.ok then
          failures := failures + 1
          onlyLeanRejects := onlyLeanRejects + 1
          IO.eprintln s!"FAIL {source} (input keys {keys}): accepted by TypeScript, rejected by the model: {r.errors}"
      else if !r.ok then bothReject := bothReject + 1
  IO.println s!"{corpus.length} validations; {accepted} accepted by TypeScript; {failures} rejected by the model; {bothReject} rejected by both"
  return (if failures == 0 && accepted > 0 then 0 else 1)
