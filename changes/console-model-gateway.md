---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
A model gateway can be saved in the console: Settings → Model keys → **Use a model gateway** takes the address of a LiteLLM or other OpenAI-compatible proxy you already run, its key (optional), how it takes model ids, and the default model of each tier, and **Test** lists the models the gateway serves to pick from. It takes effect at once, with no restart, and removing it puts the provider keys back in force.
- The API: `GET`, `PUT` and `DELETE /v2/settings/model-gateway`, and `POST /v2/settings/model-gateway/test`. Saving, removing and testing take the owner's signed-in session; the API token gets 403, with `details.console_url` linking to Settings → Model keys.
- The address follows the rule `AGENT_MODEL_BASE_URL` does (https, or http on this machine; no user, query, fragment or dot segment), and the test follows no redirect.
- The key is sealed under the seal key, never shown again, kept off every run's tool environment, and goes only to the origin it was saved for: it is sealed with that origin, a new origin asks for the key again, and a key read beside an address of another origin (a change caught between its two writes) is not sent. The test leaves out a model id that holds the key, and `api_key: null` tests with no key.
- `AGENT_MODEL_BASE_URL` set where AgentRun starts still wins, whole: the saved gateway is not used, and its save and removal answer 409 `key_set_by_server`. `AGENT_MODEL`, `AGENT_MODEL_FAST`, `AGENT_MODEL_STRONG` and `AGENT_MODEL_GATEWAY_IDS` set there win over the saved fields; an `AGENT_MODEL_API_KEY` set without a base URL is never sent to the saved gateway.
- The clients and the CLI treat the save and the test as secret writes: the CLI takes their body from stdin or a file only, and the SDKs cut the body's key from what they show.
