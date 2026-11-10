---
packages: @parcha/agentrun-serve
kind: fix
---
On a server whose only model key is OpenRouter's, a learning run graded on a named Anthropic grade model (`--grade-model anthropic/...`, `AGENTRUN_SERVE_GRADE_MODEL`) is graded again: the runner sends the grade to OpenRouter's Messages endpoint on the model's Anthropic id with OpenRouter's key as its one credential, and books it at OpenRouter's price for the model. Before, the runner refused the model for want of an Anthropic key and every such learning run ended `grade_failed`. A named OpenAI grade model goes to the same model on OpenRouter. Upgrading: nothing to do.
