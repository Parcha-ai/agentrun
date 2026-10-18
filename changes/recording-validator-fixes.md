---
packages: repo
kind: fix
---
**`scripts/recording/validate.mjs` and `apps/viewer`: two recordings that follow the format are no longer refused**
- An inline image is found by its structure, never by the length of a string. An image block that holds its `data`,
  and a `data:image/` URL, are still refused: an image belongs in `blobs/`. A run of 4000 or more base64 characters
  anywhere else (a store's chunk, a checkpoint) is data and is accepted, so a writer no longer cuts it up to pass.
- A restore whose pi committed once at open is accepted (RECORDING.md draft 37). Its process may start at `head + 1`
  when its own snapshot is at commit `head`, since pi commits once at open when a generation was running and that
  commit's state is in the snapshot. Both the viewer's check ("the restore's head is not the process's first new
  commit") and the validator's continuity check refused it. A first new commit above `head + 1`, `head + 1` without
  the snapshot at `head`, and every move fail as before.
