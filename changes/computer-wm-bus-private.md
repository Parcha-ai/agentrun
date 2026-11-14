---
packages: @parcha/agentrun-computer
kind: fix
---
E2B's and Agent37's desktops: a program of the computer's user reaches no D-Bus session bus. xfwm4's bus runs in a user and network namespace of its own, on an abstract name, so Agent37's `/tmp/dbus-*` socket is gone. init's seccomp filter now refuses `setns` to every program as well as vsock and io_uring, so no program joins that namespace. Apps that `apps.launch` opens get no session bus (`DBUS_SESSION_BUS_ADDRESS=disabled:`), so on E2B no app starts one, and none starts gnome-keyring's socket under `/work/.cache`. `isolation.vendor-agent` now also tries the abstract unix socket names of the user's network namespace (`computerd probe --sockets` lists them as `@...`, names with spaces whole, and says so when it cannot read `/proc/net/unix`). The display's own abstract name counts as the computer's.
