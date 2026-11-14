---
packages: @parcha/agentrun-computer-bench
kind: breaking
---
computer-bench: `report.json` states one arm summary for the whole run and for each platform (`platforms[].arms` carries every field of `arms`): the paired difference is each arm's `difference` (`paired` is gone), steps, turns and wall are medians (`steps_median`, `tool_calls_median`, `wall_s_median`; the means and `usd_mean` are gone), $ per pass is `usd_per_pass` (`usd_per_success` is gone), passed / scored is `passed` / `success.runs`, and the global `tasks` table is gone (each platform lists its tasks). A program reading an older `report.json` reads the new names.
