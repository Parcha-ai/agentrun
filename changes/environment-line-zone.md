---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude
kind: fix
---
A run's environment line now tells the date in the run's time zone, by weekday, day, month and year, and names the zone (`Today is Sunday 15 November 2026 (America/Los_Angeles).`), where it told the UTC date, a day ahead of the person's in an evening west of UTC. A run a schedule trigger started takes that trigger's zone; every other run takes the server's zone (`TZ`), and a zone the server does not know reads as UTC. The line carries no hour, so it changes once a day and the prompt cache holds within the day. A template eval's clock line to its graders says its date the same way.
