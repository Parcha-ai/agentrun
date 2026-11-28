---
packages: @parcha/agentrun-serve
kind: fix
---
The console's setup page no longer reads the session import offer while the password is being set. A read sent then could reach the server after the owner was set, and the server answers a browser that is not signed in yet with a 404, which the browser logged as an error on a setup that worked.
