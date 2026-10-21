---
packages: @parcha/pi-durable-disk
kind: fix
---
**SECURITY: `localHost` and `archilEnv` refuse to run the agent as root.** The docs say instances and the agent's tools never run as root, and `--run-as`, `daytonaHost` and the in-box launcher already refused uid 0. `localHost` only required a `user` when the supervisor runs as root, so `user: "root"`, `"0"` or `0` started the unit with `User=0`, and child mode in a root process ran the instance as root; `archilEnv` accepted `runAs: { uid: 0 }`. Now `localHost.start` throws `INVALID_ARGUMENT` for a user that is uid 0 (a name is looked up in `/etc/passwd`) and for child mode in a root process, and `archilEnv` throws `INVALID_RUN_AS` for a `runAs` uid of 0, each before anything runs. A driver is constructed as before, so the `status` command's read-only driver is unaffected.
