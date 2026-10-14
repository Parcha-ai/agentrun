---
packages: @parcha/pi-browser
kind: feature
---
`use_website` (listed when the host passes `sites`): a model hands a task to an agent that works one granted website in its own browser, through a `SiteRunPort`. Only the declared answer, a started run or a report, reaches the model. `localSites()` runs each task as a child agent: a pi session in the coding agent, a task-owned conversation in pi-durable, with the browser tools and never `use_website`, and its browser released when it reports. `examples/use-website` is a runnable demo.
