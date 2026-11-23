---
packages: @parcha/agentrun-ui
kind: feature
---
The console has a Wrapped page, `#/wrapped` (`#/wrapped?year=2025` for another year, "Your year" on Mission Control): a year of the work under the machine the server runs on, from `GET /v2/wrapped`, in four plain sections: tokens and cost by month, harnesses and models, when you work (hours of the day, weekdays, time at work) and what is imported, with a link per source to its imported runs. A server that is not this machine's says why it cannot read the year.
