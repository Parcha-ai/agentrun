---
packages: repo
kind: fix
---
The vision agent example (`examples/vision-agent`) with a gateway set (`VIDEO_MODEL_BASE_URL`) now reaches an Anthropic lead or eyes model over Anthropic's own Messages API at the gateway's root (`/v1/messages`), under the gateway's key, instead of over chat completions. Through chat completions the gateway answered with thinking off (0 reasoning tokens, no reasoning field); over the Messages API the agent node's `thinking` level (medium) is Anthropic's adaptive thinking at that effort, and the model's thinking comes back as thinking blocks when it thinks (adaptive thinking is the model's choice at that effort: on a live probe Sonnet 5.5 returned a thinking block at `high` and none at `medium`). A gateway that serves an Anthropic model only on its OpenAI-compatible endpoints must also serve `/v1/messages` for it. OpenAI and Google models, and runs on a provider's own key, are unchanged.
