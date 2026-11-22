---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
A template package can be read on its own: `GET /v2/templates/{template}` answers one package, bundled or imported, as `GET /v2/templates` lists it, with its instructions and every skill file in full (placeholders unfilled), and its console apply page as `console_url`. Before, that path took only `DELETE` and a `GET` of it was `405 method_not_allowed`, and a bundled package's instructions and skills could not be read through the API at all before applying it. An unknown id is `404 not_found`; an imported id is URL-encoded (`github%3Aacme%2Fagents%2Fkyb`). The CLI has it as `agentrun template get TEMPLATE`, and the TypeScript and Python clients as `client.template.get(id)`. The console's "set up with a coding agent" prompt for a template now points the agent at that package's own URL instead of the whole list.
