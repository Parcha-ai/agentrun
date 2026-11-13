"""Explicit Linux user-service installation; never enabled by discovery."""

import os
from pathlib import Path
import subprocess
import sys


def configure(state, action):
    enabled = state.data.get("startup_enabled", False)
    if action == "status":
        return {"enabled": enabled, "supported": sys.platform == "linux", "manager": "systemd-user"}
    if sys.platform != "linux":
        raise ValueError("startup_unsupported")
    if action not in {"enable", "disable"} or not state.data.get("connector_id"):
        raise ValueError("not_connected")
    directory = Path.home() / ".config" / "systemd" / "user"
    directory.mkdir(parents=True, exist_ok=True)
    if directory.resolve() != directory.absolute():
        raise ValueError("unsafe_state")
    unit_name = "agentrun-" + state.data["installation_id"] + ".service"
    file = directory / unit_name

    def systemctl(*args):
        result = subprocess.run(["systemctl", "--user", *args], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=10)
        if result.returncode:
            raise ValueError("startup_failed")

    if action == "enable":
        def quote(value):
            if any(character in value for character in ["\n", "\r", "\0"]):
                raise ValueError("unsafe_state")
            return '"' + value.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'
        content = ("[Unit]\nDescription=AgentRun observation connector\nAfter=network-online.target\n\n[Service]\n"
                   "Type=simple\nExecStart=" + quote(sys.executable) + " -I -m agentrun_cli daemon start --foreground --state-dir " +
                   quote(str(state.directory)) + "\nEnvironment=" + quote("PATH=" + os.environ.get("PATH", "")) +
                   "\nRestart=on-failure\nRestartSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n")
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
        systemctl("daemon-reload")
        systemctl("enable", unit_name)
    else:
        systemctl("disable", unit_name)
        file.unlink(missing_ok=True)
        systemctl("daemon-reload")
    state.data["startup_enabled"] = action == "enable"
    state.save()
    return {"enabled": action == "enable", "manager": "systemd-user"}
