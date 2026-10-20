---
packages: @parcha/agentrun-harness
kind: fix
---
**The recording scan passes a root workflow node's and a root loop's pointers, and takes each pointer name whole**
- A run whose root is a `workflow` node records `/root/workflow/root/...`, and one whose root is a loop records `/root/iterations/<n>` and `/root/iterations/<n>/body/...`. The scan (`credentialIn`, the recorder, the validator and the gallery gate) read both as root's home and refused the recording as "machine path"; it now passes them, and only these shapes: `/root/workflow/notes.txt` and `/root/iterations/x` are still root's home.
- Stricter: a folder in root's home whose name starts with a pointer name and goes on with `.` or `-` passed before and is now refused as "machine path", for example `/root/steps.bak`, `/root/body-old` and `/root/default.cfg`.
