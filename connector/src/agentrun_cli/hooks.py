"""Fail-open Claude lifecycle bridge to a private loopback Collector."""

import json
import sys
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from .network import NoRedirect


def emit(endpoint):
    try:
        parsed = urlsplit(endpoint)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
                or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != "/v1/logs"):
            return
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            return
        event = json.loads(raw)
        if not isinstance(event, dict):
            return
        session = event.get("session_id")
        if not isinstance(session, str) or not session or len(session) > 512:
            return
        activity = {"UserPromptSubmit": "working", "Stop": "idle", "SessionEnd": "stopped"}.get(event.get("hook_event_name"))
        if event.get("hook_event_name") == "Notification" and event.get("notification_type") in {"permission_prompt", "elicitation_dialog"}:
            activity = "waiting_input"
        if not activity:
            return
        record = {"timeUnixNano": str(time.time_ns()), "attributes": [
            {"key": "session.id", "value": {"stringValue": session}},
            {"key": "event.name", "value": {"stringValue": "agentrun.session." + activity}},
        ]}
        data = json.dumps({"resourceLogs": [{"scopeLogs": [{"logRecords": [record]}]}]}).encode()
        request = Request(endpoint, data=data, method="POST", headers={"Content-Type": "application/json"})
        with build_opener(ProxyHandler({}), NoRedirect).open(request, timeout=0.5):
            pass
    except (OSError, ValueError, TypeError, RecursionError):
        pass
