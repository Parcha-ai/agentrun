---
packages: @parcha/pi-durable-agent
kind: feature
---
The store page's Markdown renders pipe tables (a header row, its `---` rule, then rows; `\|` is a pipe inside a cell), each cell's text with inline Markdown and markup as text, in a box that scrolls sideways on a narrow screen. The agent page's runs table shows each run's summary as Markdown, clipped to a few lines, where it showed raw text cut at 160 characters. A read that fails says the server's words without the HTTP status. The host hook takes `run(run, data)`, what a host adds to a stored run's head.
