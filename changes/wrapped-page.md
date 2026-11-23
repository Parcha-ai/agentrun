---
packages: repo
kind: feature
---
The console has a Wrapped page, `#/wrapped` (`#/wrapped?year=2025` for another year, "Your year" on Mission Control): a year of the work under the machine the server runs on, from `GET /v2/wrapped`, in four plain sections: tokens and cost by month, harnesses and models, when you work (hours of the day, weekdays, time at work) and what is imported, with a link per source to its imported runs. A server that is not this machine's says why it cannot read the year. Chart counts are also text for a screen reader, a model's cost says it counts priced requests only when some requests have no known price, Imported lists a source that is only imported, and demo mode (no `/wrapped` answer) has no "Your year" link. A year with unreadable session files says so, beside the totals and in an empty year.
