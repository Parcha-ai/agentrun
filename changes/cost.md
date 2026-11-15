---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-client
kind: fix
---
A run whose every model request went to a free model (one whose known price is $0 for every token, such as an OpenRouter `:free` model) now costs a known $0 and says why: its usage row reads "Cost: $0 · free model over N model requests", its `cost` and the usage row carry `free: true` (`x-agentrun-serve: "freemodel/1"`), and the console shows "$0 · free model". A request on such a model that failed once it left, was retried or was cut is booked at $0, where it used to make the run's cost unknown ("not priced"). The booking decides it from the model's known price, so a model with no known price still reads unknown and a paid model is unchanged. OpenRouter's routers (`openrouter/auto` and its kin), which its catalog lists at $0 but which bill the routed model, are never free.
