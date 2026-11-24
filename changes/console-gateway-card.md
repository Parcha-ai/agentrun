---
packages: @parcha/agentrun-serve
kind: fix
---
On a server that sends its models to a gateway, the first screen's card no longer offers the ChatGPT sign-in or a provider key where neither runs an agent: with no gateway model named it says to name one (AGENT_MODEL, or Settings → Model keys → Use a model gateway), and with a gateway address AgentRun refuses it says why, in the server's words. Where the gateway server's own default is a plan model (`AGENT_MODEL=chatgpt/…`), the card offers the ChatGPT sign-in, which runs it. A plan model a gateway names under its prefix (`agent-model/chatgpt/…`) reads as the plan's ("… · on your ChatGPT plan") wherever a model is labelled.
