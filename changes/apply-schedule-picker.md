---
packages: repo
kind: feature
---
A template's Apply form reads a schedule as a schedule. When a template's schedule trigger takes its cron line and time zone from parameters (market-monitor's `cron` and `timezone`), the form shows the cron line with its words under it ("0 8 * * 1" reads "At 08:00, only on Monday") and the time zone as a list of zones, starting at the browser's. The Triggers page's schedule form uses the same two inputs, so its cron line reads in words too (#2234).
Upgrading: nothing to do.
