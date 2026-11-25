---
packages: @parcha/agentrun-computer
kind: fix
---
The phone provider's adb, and the adb server it starts, now start with only the names adb reads (`ADB_ENV_NAMES`: PATH, HOME, TMPDIR, the locale, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_USER_HOME`, `ANDROID_SDK_HOME`). Before, a provider built by serve ran every adb with the server's whole environment. The phone descriptor names the list in `hostEnv`, so serve passes its own values of these names and nothing else.

A Docker computer, and its egress proxy, no longer hold the host's docker proxy. The docker CLI fills in each proxy variable a `docker run` does not set itself from config.json's `proxies` (`DOCKER_CONFIG`, else HOME's `.docker`), a credential in its URL included. Both runs now set `HTTP_PROXY`, `HTTPS_PROXY`, `FTP_PROXY`, `NO_PROXY` and `ALL_PROXY`, upper and lower case, empty. A fenced computer's programs still get the proxy from the computer's own relay.
