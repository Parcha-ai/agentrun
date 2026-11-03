---
packages: @parcha/agentrun-serve
kind: fix
---
`pdf_pages` draws each document under a page directory of its own. Before, the directory was named by the document's file name alone, so `company-a/certificate.pdf` and `company-b/certificate.pdf` drawn in one run both answered `pages/certificate/<dpi>/1.png`, and the second draw replaced the first: a judge about company A could be shown company B's page. The directory is now the document's path below `--documents` (or the run's `work/`) made one path-safe name and ended with 12 hex characters of its hash, such as `pages/company-a_certificate-56c2fc556c26/110/1.png`; the layout `work/pages/<stem>/<dpi>/<n>.png` is unchanged, and the same file always draws under the same name. Pages a run drew before keep their old `pages/<name>/` directories, and refs to them still load; a new draw goes under the new name.
