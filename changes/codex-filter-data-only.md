---
packages: @parcha/agentrun-harness-codex
kind: fix
---
On codex, a content-filter stop whose final Responses event is longer than the model proxy keeps of it now ends the turn
through a gateway that sends each event as its data alone (LiteLLM sends no `event:` lines). Before, only a stream that
named its events was read, and Codex asked for the refused answer again until its turn limit. The policy reads the
event's type from its data, whatever the JSON's spacing.
