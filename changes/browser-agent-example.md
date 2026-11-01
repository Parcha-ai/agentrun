---
packages: repo
kind: feature
---
`examples/browser-agent` (`npm run demo:browser -- examples/<folder>`): one browser agent for a task in one line of plain words, on `@parcha/agentrun-reference`. It reads each page before and after it acts, hands the browser to the person with `browser_request_handoff` for a step that is theirs when the host can reach one, and answers from what the pages showed; gemini-3.8-flash thinking at medium. A live run drives Browserbase, or with `--local-chrome` a Chrome on your machine. `examples/dropdown-handoff` is its first example, a task on a public practice site.
