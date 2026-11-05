---
packages: repo
kind: feature
---
Console: the file viewer shows a file Rendered or Raw, with a toggle in its header. Rendered is the Markdown rendering it showed before; Raw is the file's exact text, each line on its own line, in monospace. A Markdown file opens Rendered and any other text file Raw, so `Hello, world!` and `Goodbye, world!` on two lines of a `.txt` read as two lines, and a `.md`'s are one click from it. A file the viewer doesn't show (an image, a binary) is still offered as a download, with no toggle.
