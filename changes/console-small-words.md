---
packages: @parcha/agentrun-serve
kind: fix
---
Three small wording and rendering fixes. An opened Answer row on a run's Timeline renders its Markdown as the Report does (links clickable, code fences as code blocks, no raw HTML) in place of raw fences and `[text](url)`; the New agent Computer step says "This computer adds these tools: ..." in plain text in place of an uppercase "THE LOOP GETS"; market-monitor's `lookback_days` help says what the number does (how many days back a run looks, kept equal to the gap between runs) instead of "when you change cron".
