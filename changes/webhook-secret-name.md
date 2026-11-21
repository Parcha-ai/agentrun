---
packages: @parcha/agentrun-serve
kind: fix
---
In the console, a webhook trigger's once-shown signing secret after a template apply that skipped a trigger (a feed given no feeds, a GitHub or Composio trigger not set up here) is labelled with its own trigger's name, and its warning opens that trigger. Before, the console matched the package's trigger index against the answer's list, which a skipped trigger shifts: the secret carried the skipped trigger's name, and the warning's "Open … (Rotate)" link went to another trigger or to none. The console now finds each trigger by its name.
