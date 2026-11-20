---
packages: @parcha/agentrun-serve
kind: fix
---
An agent whose `input_schema` has fields of its own, all optional, takes a run that gives one of them and no `content`: a template's `pr_number` run by hand (`{"pr_number": 3318}`) starts, where it was refused 422 `input.content is required`, though the schema left `content` out and closed the object. A run still has to say something: an input with neither `content` nor any of those fields is refused at `input.content`, naming the fields that would do instead. A schema with no field of its own, or with one required, is unchanged.
