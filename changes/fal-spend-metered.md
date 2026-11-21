---
packages: @parcha/agentrun-serve
kind: feature
---
A run counts fal's jobs: `run_model`, `submit_job` and `submit_jobs` on a fal MCP server (toolkit `fal`, or `mcp.fal.ai`) are priced before they are sent, at fal's `get_pricing` unit price times the units the job's input states (images, megapixels, characters, seconds, or the length of its input media), held under the run's spend cap and booked as tool cost. A job the cap can't take is refused unsent, as is one whose price can't be known beforehand; with no cap that one runs, booked as an unknown charge. The figure is an estimate at fal's list price. Agents saved before this are metered when their server is at `mcp.fal.ai`; save an agent again to pin a fal server at another address as metered.
