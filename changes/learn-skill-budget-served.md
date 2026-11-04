---
packages: @parcha/agentrun-serve
kind: fix
---
A learned skill's size is counted as the run is given it. The run gets each learned SKILL.md with its front matter rebuilt (name and description alone, the description quoted where YAML needs it), which can be a few bytes longer than the file on main; the budget counted main's bytes, so a set of skills that fit the adapters' 1 MiB cap by those bytes went over it, and every skill went inline into claude-agent's prompt instead of loading through its Skill tool. The budget now counts what is laid. A quoted description in a SKILL.md is read as the text it quotes (its escapes decoded), so serving a skill twice writes the same bytes, and a description with `\"` in it is no longer laid with its backslashes doubled.
