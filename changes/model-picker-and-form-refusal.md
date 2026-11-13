---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
The console's Model field is a picker of the models the server offers for the agent's harness, with Custom... for any other. Each harness's list is served in capabilities as `harnesses[].models` (new, required): the current Claude 5 and GPT-6 models in the exact form that harness takes here (`anthropic/claude-sonnet-5-5` on a provider's own key, `openrouter/anthropic/claude-sonnet-5.5` when OpenRouter's is the only key, the host's own ids behind a gateway), only those the harness runs, empty for a harness that does not run here.
A model named in a form its harness does not take is refused at save in words that name the form: `On pi, a model is <provider>/<model id>, like anthropic/claude-sonnet-5-5 or openrouter/anthropic/claude-sonnet-5.5: anthropic/claude-sonnet-5.5 is not a model pi runs here. Did you mean anthropic/claude-sonnet-5-5?` The examples are the forms this server's keys run, and the likely id is named when a dot for a dash, a missing provider or a short name ("Sonnet 5.5") makes it obvious. The catalog's own refusal text no longer reaches a person.
