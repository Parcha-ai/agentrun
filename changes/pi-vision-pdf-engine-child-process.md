---
packages: @parcha/pi-vision
kind: fix
---
The PDF engines (pdf.js for text, PDFium for pages) now run in a child process of their own, with the same time, heap and pixel caps, no environment variables and no output. A file that made an engine run out of heap past the point where V8 can still stop a worker thread used to abort the whole host process; it now ends the child, and the call is an `over_budget` miss. A host that cannot start a child process gets a `needs` miss for the PDF engines.
