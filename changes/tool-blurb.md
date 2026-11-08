---
packages: @parcha/agentrun-serve
kind: feature
---
Each tool has a `blurb`: one short line for people, such as web_fetch's "Read a public web page" or ask_person's "Ask you a question mid-run". It is served beside the model-facing `summary` in `capabilities.tools[]` and in `GET /v2/agents/{id}`'s `tools`, from one source, so both agree, and the model never sees it. An MCP server's tool has none. It is optional in the schema, so a console falls back to the summary on an older server.
