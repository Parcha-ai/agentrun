---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-acp
kind: fix
---
A harness recipe's install is checked by one rule, its tree, in harness-check, harness sign-in, a server's harness entry and each start. The tree digest covers every file, the binary among them, so an install no longer writes a separate first-seen binary record: it records its first tree alone, and a recipe's own binarySha256 is still checked at install. An install with no tree record is refused with the line that installs it again, and an executable whose path leaves the install folder through a link (which the tree digest holds by name, not by its bytes) is refused at the install and at every check. The check note keeps the recipe, the tree and the platform. A recipe's keyMethod is checked by the ACP package's AUTH_METHOD, the adapter's own definition.
