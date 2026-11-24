---
packages: @parcha/agentrun-serve
kind: fix
---
A trigger firing that the launch hook's host starts through the API is no longer settled again by the server once that start has started it. Before, a retry that came due around the host's start could still write over the started firing: it read `skipped` if the agent was archived meanwhile, or `sent` if the trigger was moved to a `message_run` target meanwhile, while its run went ahead. The timer now leaves a firing to a host start that is still writing its run, and a retry already under way writes nothing once the firing is no longer due.
