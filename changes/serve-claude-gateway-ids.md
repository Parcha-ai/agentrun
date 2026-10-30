---
packages: @parcha/agentrun-serve
kind: fix
---
claude-agent runs on a model named the way OpenRouter names it. A revision naming `anthropic/claude-sonnet-5.5` sent Anthropic the bare dotted `claude-sonnet-5.5`, an id neither Anthropic nor OpenRouter knows, and its runs failed. claude-agent now sends Anthropic's own id, the model id with its dots as dashes (`claude-sonnet-5-5`), which Anthropic takes and OpenRouter takes too, and prices the run by the same id, so its cost is the catalog's estimate rather than unknown. The doubled `anthropic/anthropic/claude-sonnet-5.5`, once the workaround, is now refused with `422` on `definition.model`, naming the form to use: `anthropic/claude-sonnet-5.5`. The `LOOPBACK` allow-list carries the key gate's loopback marker.
