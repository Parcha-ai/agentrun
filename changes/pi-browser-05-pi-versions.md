---
packages: @parcha/pi-browser
kind: feature
---
pi versions: the pi-durable adapter runs on pi-durable 1.1 and 1.2. pi-durable 1.2 reads a tool result's `output` and treats a result with only `content` as empty, so every durable tool result (browser, web and site tools) carries the model's text under both keys; the pi coding agent's results are `content` in every version and are unchanged. Peer ranges: `@earendil-works/pi-durable` and `chord` `>=1.1.0 <1.3.0` (1.0.4 cannot build the adapter: `use_website` reads a child's last report by scanning entries in descending order, which 1.1 added); `@earendil-works/pi-coding-agent` stays `*`, as pi's package guidance asks. A test on pi 1.2 checks that no tool result reaches the model without its text.
