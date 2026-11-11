---
packages: @parcha/agentrun-serve
kind: feature
---
A run on OpenRouter's `particle-ai/particle-1` reads most of its input from the provider's prompt cache, so a tool-using run such as a code review costs about a sixth of what it did. Particle AI, its one provider, caches no prefix of a request that carries a `tools` parameter (measured: 0-30% of a review's input cached); serve now sends particle-1 its tools as text, and 76-92% of the input is read at the cached price:
- A model's catalog entry says how it takes its tools (`toolsAs` in `local-models.ts`, beside the prices serve sets): `"text"` for particle-1, native for every other model. On the runner's translated route the tools go in the system prompt in DeepSeek's call format, every earlier call and result in the history as text, rebuilt the same way each turn so each request's prefix is the last one's, and the calls in the model's reply come back as Messages `tool_use` blocks. A reply that opens a call block with no call readable in it is asked for again, at most three times in all, its usage summed. Anthropic models, Responses models and every other translated model are unchanged.
- A text-tools reply is sent once it ends, whole, not streamed token by token.
- A long `get_diff` answer filed in the run's files is indexed in its note: each file past the cut, the line it starts at in the filed copy and how many lines it runs (`; files past the cut, from the line each starts at (its lines): src/a.ts 908 (120), ...`), so the model reads the files it needs by range and passes a generated one by.
