---
packages: @parcha/agentrun-serve
kind: fix
---
The kyb template's report uses one set of names for its subject: `subject.input` is the run's typed input as the run received it.
- `subject.input` holds `company`, `website`, `country`, `registration_number` and `reason`, the names of kyb's inputs, with their values as given; a field the run did not get is left out. It held `name` and `domain`, with nulls and a `reason` of `unspecified` filled in by the skill.
- The kyb skill copies the input block whole; its field-by-field mapping is gone. An agent applied from the earlier kyb keeps the output schema it was applied with.
