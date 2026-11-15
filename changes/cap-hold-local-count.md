---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: fix
---
A capped run on a model whose tokenizer is o200k_base, reached over Messages without Anthropic's count (pi on GPT-6.1 Sol through OpenRouter, sent through serve's translation), bounds each request's input by a local count with its stated margin, as a Responses request to a gateway already does. Before, its bytes were the bound: after a few long pages the body passed 272,000 bytes, every rate was priced at Sol's long-context tier, and a $1.50 run stopped at $0.10-0.27 because the cap refused to send a step it could pay for. A Claude model, a body with a document, or one that offers the hosted search keeps the provider count or the byte bound.
When a run's cap is below what its model needs for one more step and an answer, the wrap-up's words now say so with both amounts ("This run's cap of $0.25 is below what gpt-6.1-sol needs for one more step and an answer, about $0.32."), so a run that stopped its tools at its first call shows the cap was the cause. The rule that decides when a run wraps up has not changed.
