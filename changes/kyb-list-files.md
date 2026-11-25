---
packages: @parcha/agentrun-serve
kind: feature
---
The kyb template can screen a name against each sanctions list's own published file. With a shell it saves the file with `web_save` and greps every row, and its answer names the method `full_list_grep` with the list's version where the file or its URL gives one (`unknown` otherwise). Before it reports `no_hit` it has searched each identifier it holds, a short name such as `ADF Ltd` whole as a word, and, where a common name needs narrowing, whole UN records rather than lines, since the UN file keeps each part of a person's name on its own line. It reads a name with another in brackets, such as `ADF (Allied Democratic Forces)`, as both names, so a short name is not passed over as one word inside a longer name. Without a shell it screens through the list owners' indexes and records, as before.
