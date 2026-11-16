---
packages: @parcha/agentrun-serve
kind: fix
---
A web_fetch or web_search answer now keeps its `links` and still parses after the run's redactor cuts it. The redactor treats any stretch of more than 8,192 characters with no whitespace as `[redacted]`, and it used to run over the answer's whole JSON line. Escaped newlines in that line are not whitespace, so the end of the page text and the whole links array formed one such stretch, and redacting it broke the line's JSON. The grader's link check then found no links in the stored answer and read a cited link from it (a release from a feed) as "no matching call". This happened on both the pi and the CLI harnesses. Each string inside a web call's JSON is now redacted on its own, along with the lines after the JSON, so a held value is still cut. Any other tool's answer is redacted as one text, as before.
