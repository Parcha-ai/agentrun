---
packages: @parcha/agentrun-serve
kind: fix
---
A run that parks at its cap sends nothing more on that claim: once a refusal parks it, every later request (another conversation's of the run, such as a subagent's) is refused in the same words until a raise resumes the run on its next claim. Before, a request of another conversation could still be admitted after the run read `input_required`.
