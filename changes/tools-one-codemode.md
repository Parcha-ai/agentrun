---
packages: @parcha/agentrun-serve
kind: feature
---
A pi run with a desktop or a phone has the host's one `codemode`, as every other run and harness has. A script calls the computer's actions as ordinary tools (`await tools.computer_observe({app})`, `tools.computer_act({app, steps})`), and each is a call of its own: held to the kind's setting, with its own timeline row and its own `computer_calls`. pi's own computer code mode, with its `computer` global, is gone.
- A script on the host's `codemode` has no `computer` global. The only state that handle kept was the last observed state, and `computer_act` already defaults to it. `computer_script` still binds `computer` for a multi-step script on the computer, on every harness.
- pi on a desktop or phone whose `surface` is `code` is now offered `computer_script` beside the hand-over, as claude-agent, codex and opencode are. Before, pi's own code mode stood in for it. With `surface` unset or `tools`, pi is offered the same names as before.
- A deny on `desktop` or `phone` now refuses the computer call a script meets and ends the script there; the calls before it ran. Before, it refused pi's whole script before anything ran.
- A template eval grades a `codemode` script's call as `codemode` on every harness, beside the calls the script made. Before, it was graded as `desktop`.
- When a script stops at a call that is waiting, its answer lists each earlier result as the script read it: a JSON object or array as itself, not as an escaped string, and a string value as that string.
- A tool's image reaches a `codemode` script with its pixels. `image(shot)` shows a screenshot to the model, and a screenshot the script returns is its answer's image. Before, the script got the screenshot without its data, so neither could show the screen. The answer's text never carries the data.
- A pi desktop run's first request is offered `codemode` beside the computer's tools. Through a gateway its byte bound grows to 11,496 tokens ($0.058 at the cache-write price, was $0.054). The documented minimums stay at $0.12 through a gateway and $0.09 straight to Anthropic. In `strict` mode, a run a cent under the gateway minimum now parks before its last step, as it does straight to Anthropic, instead of being told to answer without its last screenshot.
