---
packages: repo
kind: feature
---
`apps/console` is the start of AgentRun Server's console: a React app that builds to static files, with the shell and the run page (status, live timeline, input required, stop versus cancel, files and the file viewer, typed errors) and a Storybook of every component on responses recorded from the server. It offers a message only in a mode the server's `features.messages` takes. The source export now reviews `.tsx` files, and CI's `verify` needs the console's typecheck, tests and builds.
