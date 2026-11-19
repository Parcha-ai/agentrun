---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
`agentrun import --help`, `agentrun native discover --help`, `agentrun reset-password --help` and `agentrun runner --help` print that command's own usage (and for import, what it reads and what `--dry-run` does), exit 0, and touch nothing in the data folder. Before, the launcher answered every one of them with its own three-line usage, which names none of their flags, and `agentrun-serve <command> --help` failed with "Unknown option '--help'" (exit 2). The same holds for `-h`, and for `agentrun-serve install-harness`, `validate-template` and `eval-template`. `agentrun-serve --help` now lists `native discover|connect` beside the other commands.
