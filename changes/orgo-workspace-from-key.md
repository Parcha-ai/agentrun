---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
Orgo finds its workspace from the saved key: `ORGO_WORKSPACE_ID` is no longer required. With it unset, an Orgo provider reads the key's account's workspaces (`GET /workspaces`, deleted ones skipped) and uses the one there is; with several it refuses in words naming them, and with none it says to make one at orgo.ai. Settings → Computers offers the Orgo workspace as a picker by name once `ORGO_API_KEY` is saved, and saving a pick stores its id under `ORGO_WORKSPACE_ID`, read through the new `GET /v2/computers/{provider}/choices` (`listComputerChoices`). A provider view lists such keys under `picked`.
Breaking: Orgo's `workspaceId` option is optional (`COMPUTER_ORGO_WORKSPACE` too, for the conformance run), and a server whose Orgo account has several workspaces and no `ORGO_WORKSPACE_ID` saved now has its Orgo runs refused until one is picked in Settings → Computers.
