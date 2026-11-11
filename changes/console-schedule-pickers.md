---
packages: repo
kind: feature
---
The console asks for a schedule in words. A schedule on the Triggers page, and a template parameter marked `format: cron` on its Apply screen (`market-monitor`'s), pick every hour, every day, every weekday, a day of the week or a day of the month, then a time; the console writes the cron line. "Custom cron line" still takes a line typed out, and says it back in words, and a schedule whose line has none of those shapes opens as one, unchanged until it is edited. A time zone (the Triggers form's, and a `format: timezone` parameter's) is a choice of the browser's IANA zones, starting at the browser's own zone. After Apply makes a schedule, the screen says when it runs, in words, and its next run time, as the Triggers page does, with a link to it, before you open the agent.
