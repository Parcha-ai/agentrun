---
packages: @parcha/agentrun-serve
kind: fix
---
The agent editor's Computer step keeps image, persistent, GPU, surface, exec and record across a switch of kind or provider where the new pick can take them; the kind's card names each one it drops. Before, any switch dropped all of them but record.
