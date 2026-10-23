---
packages: @parcha/agentrun-dsl
kind: feature
---
New subpath `@parcha/agentrun-dsl/author-references`: the author skill's five documents (`SKILL.md`, `language.md`, `workflow-format.md`, `jev-decisions.md`, `sdk-authoring.md`) as static strings in `AUTHOR_REFERENCES`. It imports nothing, so a browser or a Worker can carry the references without reading files or loading Node's builtins.
