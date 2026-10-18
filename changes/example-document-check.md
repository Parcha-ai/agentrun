---
packages: repo
kind: feature
---
Example `document-check` (`npm run demo:document-check`): one agent checks a Delaware certified copy, pages of a public SEC EDGAR exhibit committed under `examples/document-check/sample`, against a checklist file of the marks Delaware law gives it (the Secretary of State's seal and signature, the file and SR numbers, the authentication number, the FILED stamp, the file numbers agreeing), by running pi-vision's verify skill in code mode. Each mark is yes or no, and each one there is boxed on its page in an `agentrun.cited/1` result that keeps the PDF as a blob (`#page=N&xywh=percent:...` of the page's crop box). A TEST COPY with the marks painted white comes back with every mark no (`--input test-copy`). On fakes it costs $0 with no key; `--live` needs a Jev key and a lead model key. The reference entry's code mode now hands the agent `vision.judge` beside `vision.see`.
