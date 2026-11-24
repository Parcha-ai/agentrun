---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: fix
---
Each saved harness key is bound to the recipe file it was saved for (its sha256) and to the seal key it was sealed under. A later recipe file that takes the same id never opens it. That holds even for a claim that read the first file's binding while a save for the later one landed: the binding holds the digest of the sealed bytes it was written with. It also holds for a run's process that loaded a recipe file swapped since its runner started, because the process asks for the keys bound to the file it loaded itself. The Harness keys page lists such a key to paste again and says why (`reenter`: `recipe_changed`, `seal_key_changed` or `file_unreadable`).

A recipe the server is no longer started with keeps its keys, sealed and cut, and nothing runs them. The page lists them under the recipe's id (`named: false`, `kept`), and `DELETE` removes each one. It also removes a key that no recipe runs on any more, or one that no longer opens. Capabilities name each such id (`features.harness_keys.kept`) to the owner's session or a token holder, and to no other caller, so the console keeps offering the page until those keys are removed.
