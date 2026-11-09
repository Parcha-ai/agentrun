---
packages: @parcha/agentrun-serve
kind: fix
---
The PDF tools' helper programs (pdfinfo, pdftoppm, pdftotext, ffmpeg) start with a minimal environment: no server secret reaches them. They get PATH, the locale and the temp directory only, where they used to inherit the server's whole environment (model and tool keys, its token), readable by any process of the same user while they parsed a document. Upgrading: nothing to do.
