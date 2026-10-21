---
packages: @parcha/pi-durable-agent
kind: fix
---
`readPack` and `importPack` fix two defects in reading a pack.
- A pack member under `runs/<id>/` is refused when the pack's index does not list the run, even when the id is named like an `Object` property (`constructor`, `toString`, `valueOf`): such a member used to pass the check, and `importPack` extracted it into the home.
- The pack file is closed when its scratch directory cannot be made (a full or unwritable temporary directory), where it used to stay open.
