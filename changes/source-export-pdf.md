---
packages: repo
kind: ci
---
The source export carries a PDF only when one line of `ASSETS.md` names the file, in backticks, together with its SHA-256. Any other PDF stops the export with "Unreviewed PDF: <path> is not in ASSETS.md with its SHA-256 <sha>", so every binary in the source archive is still one someone reviewed. `.pdf` joins the binary types the export knows; the other binary types are unchanged.
