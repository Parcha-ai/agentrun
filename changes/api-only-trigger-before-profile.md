---
packages: @parcha/agentrun-serve
kind: docs
---
API-only server (`AGENTRUN_API_ONLY=1`): the README no longer says every run there starts through the backend on its keys and budget, which 0.1.0-beta.53's notes also said. With the launch hook set, every firing that starts a run goes to the backend, including one of a trigger the agent had before the profile. Without the hook, the apply makes no schedule or feed trigger, but one the agent already had stays as it was: an enabled one still fires on the server and starts its runs on the server's keys. Archive the agent to turn it off.
