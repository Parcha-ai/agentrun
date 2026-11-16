---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A harness is one entry in serve's harness table: capabilities, a revision's save check, the runner and the console all read the table. An owner can add harnesses with a harness module. Start the server (and any separate runner) with `--harness-module MODULE` (repeatable) or `AGENTRUN_SERVE_HARNESS_MODULES` (comma-separated). MODULE is a path, or a package installed with `npm install --prefix <data>/harnesses <package>`, that exports the `entries(builtins)` shape test tables already use.

A module adds whole entries of new ids. A module that names a built-in harness (pi, claude-agent, codex, opencode), names an id another module adds, or leaves out a member refuses the start, naming the module and the id.

Capabilities' `harnesses` now carry each harness's `label` and `promises`: `resume` (`exact`, `load`, `restart`), `tool_gate` (`every_call`, `permission`, `config`) and `billing` (`proxy`, `plan`). The built-in harnesses promise exact resume, every call gated, and proxy billing. A harness id in the API is now a string (pattern `^[a-z][a-z0-9-]{0,39}$`), not an enum of the four built-in ones. The console offers a harness the server adds after the built-in ones, under the label the server gives it.
