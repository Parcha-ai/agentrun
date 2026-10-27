---
packages: @parcha/pi-browser
kind: feature
---
`@parcha/pi-browser`: `web_search` now returns a short redacted snippet on each hit when the search has one (an excerpt of the page, clipped and redacted with the rest of the answer), and both `web_search` and `web_fetch` try a host's configured sources in order before the provider's own, so a search or fetch still answers when the first source is unavailable.
