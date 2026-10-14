# A saved site as a tool

`use_website` lets a pi agent hand a task to another agent that works one website in its own browser. The parent sees only the child's report, never its browser or transcript.

```sh
npm ci && npm run build -w @parcha/pi-browser
OPENAI_API_KEY=... node packages/pi-browser/examples/use-website/ask-site.mjs https://example.com "What is this page about?"
```

`ask-site.mjs` gives one agent one site through `localSites()`. The agent calls `use_website`; `localSites()` starts a child pi session that has the browser tools and no `use_website`, so a child cannot start children. The child's browser is released when it reports.

`test/use_website_real_chrome.test.mjs` runs `askSite()` against a local test page in real Chrome, with a scripted model.
