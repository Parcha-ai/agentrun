---
packages: @parcha/agentrun-serve
kind: breaking
---
A run's spend cap now counts every request's input on every harness, with one bound: a token per UTF-8 byte of what is sent, plus what the provider adds server-side. That bound is at the dearer of the model's input and cache-write prices, plus the request's output ceiling. What the provider adds is documented for Anthropic and OpenAI (their tool-use prompt and per-image maximum). For every other API kind it is assumed: 2,048 tokens for a request with tools, and the largest per-image maximum for each image. So the bound never undercounts as documented for Anthropic and OpenAI, and as an assumed bound elsewhere.
- codex and claude-agent: before, the cap priced only the output ceiling, so a request with a large input could pass a cap it should not. Each request still in flight now holds its own input bound too, so requests sent side by side cannot pass the cap together. A request whose input could not be measured is refused under a cap.
- pi: the input was pi's estimate, about 3.5 characters a token. It is now the byte bound, which is stricter, so **a capped pi run can now be refused a request it used to be allowed**, most of all for dense text such as non-Latin scripts and emoji.
- A model serve has no price for, a gateway model the catalog does not list and no price is set for, is refused under a cap. Before, it read $0 and never reached one. A model the catalog lists at $0 is a known $0 and passes, and with no cap nothing is refused.
- No API kind is refused for being one: a capped run on Gemini, Bedrock, Mistral or a Chat Completions gateway is priced as above.
