---
packages: @parcha/agentrun-serve
kind: fix
---
The `code-review` template now makes its own GitHub trigger: each pull request opened, reopened, updated or marked ready on the repository it was applied to starts a review, and only that repository's (the server's GitHub App takes events from every repository it is installed on). Before, Apply made no trigger and code review never ran on a fresh install. Applied where GitHub is not connected, the agent is still made and the trigger is skipped with a warning.
