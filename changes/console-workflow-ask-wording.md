---
packages: repo
kind: fix
---
A workflow agent's Tool settings in the console say what ask means for it: a call node can't wait for an approval, so a tool set to ask stops the run from starting, and the fix is to set it to allow. The line had said a tool on ask makes the run wait for your approval at each call, which holds for an agentic run only, and still says so there.
