---
packages: @parcha/agentrun-computer-bench
kind: fix
---
On `--backend serve`, a code-mode agent's computer calls now count as its steps. serve writes each computer call a codemode script makes as a nested call with its own Timeline rows under the script's call, and the bench used to skip every row with a parent as a subagent's. So the report's "median computer steps" read 0 for every code-mode arm, the routes and "passes that ran a program" tables saw none of those calls, and the step budget never stopped a script that went past it. The bench now reads a script's nested calls as steps of the script's turn (never as extra model turns), and still leaves out a subagent's rows, which are in a conversation of their own. Each step's time now comes from serve's `started_at`.
