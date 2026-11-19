---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run's Graph names a map's item by the head of its label when the label is text. Before, a label with a slash in it showed only what came after its last slash: a release note that ended "Send event queries to /v2/events instead." read "events instead.". A file's path or a page's URL still shows as its name alone (`invoices/2026/acme-march.pdf` reads `acme-march`), and the cell's hover still gives the whole label.
