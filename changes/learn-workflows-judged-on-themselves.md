---
packages: @parcha/pi-agent-learn
kind: breaking
---
A workflow a run saved is judged on itself, never on the agent's note. A run that read untrusted content puts none of its own words into a later prompt this way, and a workflow the agent wrote for its job is no longer held because its note sounds like an instruction.
- `curate` asks no question of a `learn` call of type `workflow` and writes its text nowhere. It reads the run's records through the DSL's store and asks one new question of the document, `workflowCase` (does it name or single out a case, carry a fixed answer, or carry an instruction beyond the job `rules` describe; yes at 0.5 refuses, 0.2 or below passes, between holds), then hands the records to `admitWorkflow` with no description. A host whose scripted judge answers questions by name must answer `workflowCase`. Records the store refuses, and workflows that run code, go straight to the admitter as before.
- `workflowAdmitter({ describe })` writes the skill's description from the revision's document; the default, `schemaDescription`, names the fields of its input and output by name and type, with no text the agent wrote. A caller that hands over a `description` still gets it; curate never does. `admitInDir`'s `description` may be a function of the document.
- `proposeLearning({ read })` takes the untrusted text the run read (the pages its tools fetched). A saved workflow 40 or more characters of whose strings (case and whitespace folded) appear in one is withheld from the proposal and named in the result's `withheld`; the rest is proposed. `copiesRead` and `COPIED_TEXT` are the check.
- The other questions and every threshold are unchanged; lessons, facts and corrections are judged as before.
