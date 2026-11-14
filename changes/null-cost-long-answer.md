---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: fix
---
A long answer through an OpenAI Responses gateway that writes its JSON with spaces is priced, and a run whose spend is unknown never reads as a full cap to its learning.
- Before, the model proxy read a long answer's usage (its terminal event longer than the 64 KiB it keeps) only when the gateway wrote `"usage":{` with no space. A Python gateway (LiteLLM's `json.dumps`) writes `"usage": {`, so such a request was booked at an unknown cost though the harness counted its tokens: the run's cost read unknown with nothing unmetered. pi on the gateway, Codex and OpenCode read the usage the same way and are all fixed. Kernel: `lastObjectOf(text, key)` reads the last `"<key>": {...}` object of a cut answer, whatever its spacing.
- Before, a capped run whose shown cost was unknown gave its learning grade a cap of $0 ("Not graded: no room under the cap.") and its look-back a reached cap. The grade's cap and the look-back now read the run's spend as its own cap gates read it: an answer with no price counts at the figure the cap held for it, never $0 and never the whole cap. Only when that figure is unknown too, the grade is not queued and says why: "Not graded: this run's spend is unknown, so its budget can't cover the grade."
