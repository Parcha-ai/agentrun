---
packages: @parcha/agentrun-serve
kind: feature
---
The kyb template can screen a name against each sanctions list's own published file. With a shell it saves the file with `web_save` and greps every row, and its answer names the method `full_list_grep` with the list's version, read from the saved file. Without a shell it screens through the list owners' indexes and records, as before.
