---
packages: repo
kind: fix
---
**`scripts/recording/validate.mjs`: an inline image is found by its structure, never by the length of a string**
- An image block that holds its `data`, and a `data:image/` URL, are still refused: an image belongs in `blobs/`. A run
  of 4000 or more base64 characters anywhere else (a store's chunk, a checkpoint) is data and is accepted, so a writer no
  longer cuts it up to pass. Before, any such string was refused as an image.
