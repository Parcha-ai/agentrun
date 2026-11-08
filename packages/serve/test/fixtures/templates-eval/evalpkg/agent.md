---
name: evalpkg
version: 0.1.0
description: A package for the eval runner's tests, its agent played by test/fixtures/faux-template-eval.mjs.
harness: [pi]
tools: [read, write, ask_person]
mcp:
  - server: crm
    tools: [get_contact, update_contact]
parameters:
  team: { type: string, required: true, description: "the team the agent answers for" }
learning: true
output: { schema: answer.schema.json }
---
You answer for the ${parameters.team} team. End with one fenced json block that meets answer.schema.json.
