---
packages: @parcha/agentrun-serve
kind: fix
---
An OpenRouter model whose reasoning is mandatory (`openrouter/baidu/ernie-5.5-flash-preview:free`) no longer gets reasoning effort `none` with thinking off, which OpenRouter refused on every request ("Reasoning is mandatory"). With thinking off it now reasons at its default.
