---
packages: repo
kind: fix
---
**The chat view draws a conversation a call made under that call, and never draws its maker's words as "You"**
- A conversation whose record (`pi.conversation`, draft 54) has a `parent` is drawn in its parent conversation at the entry it was forked at (`parent.at`): under the call's card when its owner's task names a tool call, else right after that entry's item, as a fold. A fork is named by its own `reference.label`, else by its parent's label and its place among the parent's conversations (`threads · 1`). It is no longer a top-level "conversation N" row, and a call that made conversations is never folded into the commands line.
- In a conversation that has an owner, a user entry is its maker's message, drawn with the tool's name (`fork_threads`), never as "You". The one exception is an input a person submitted: a recording that keeps submissions (`manifest.recorded.submissions`, draft 45) names it with a `pi.submission` whose request is not the node runner's.
- The header names the agent by its own label, never a fork's.
- A fold inside an open fold keeps its own arrow and preview: the open rule applies to its own summary only.
