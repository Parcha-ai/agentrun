---
packages: @parcha/agentrun-serve
kind: feature
---
The console's agent editor grants monid endpoints. The Tools step has a monid row: type `monid:<provider>/<endpoint>` for one endpoint, or `monid:<provider>/*` for every endpoint of a provider, and Grant. The row checks the name's shape as the server does and says what is wrong before a save; the save still reads monid's listing and prices and is the judge of the rest.
- An agent's monid grants show on the row, each as a card. Untick one to take it away; it stays on the row to tick again. An edit that does not touch them keeps them.
- After a save, what the server said of a grant (each endpoint monid prices by usage) shows on the row and above the form, in the server's words. These no longer read as things that keep the revision from running.
- A save refused at a grant (an endpoint or provider monid does not list, no monid key on the server) shows the server's reason on the row, beside the grant.
- The agent's page that opens after a create shows the create's warnings in the server's words.
