---
packages: @parcha/agentrun-serve
kind: fix
---
An OpenCode tool call leaves nothing behind once its client is gone and the run's MCP server has closed. Its progress timer stops, and nothing more is written to its response, the moment its client goes away; the call itself still counts as running until it settles, so a drive's end still waits for its real outcome. When the server closes, a call that is still running after its 5 s window is let go: its timer is stopped, it no longer counts as running, and its answer, if it ever comes, is written nowhere. Before, a host tool that never settled kept a live timer writing progress to a closed response, and stayed counted as running, for as long as the server process lived.
