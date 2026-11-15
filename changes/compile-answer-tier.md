---
packages: @parcha/agentrun-serve
kind: feature
---
A compiled workflow's answering step now runs on the agent's own model.
- The learning checks refuse a workflow draft whose answering step (the model node that writes the key its `output.path` reads, or a composed workflow's own answering step) names tier `fast`, in words the compile turn's retry acts on: drop its tier. Legwork steps may stay on `fast`, an answer on `strong` passes, and decision nodes (judge, pick, sift) are not read. The compile prompt and its worked example say the same.
