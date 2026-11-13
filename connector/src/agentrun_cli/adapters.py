"""Read-only harness boundaries; raw harness output stays inside this module."""

import json
import os
from pathlib import Path
import selectors
import re
import subprocess
import time
from typing import Literal

from pydantic import BaseModel
from websockets.sync.client import unix_connect
from websockets.exceptions import WebSocketException

from . import __version__

class Candidate(BaseModel):
    id: str
    harness: Literal["claude", "codex"]
    project_id: str
    project_label: str = "Project"
    label: str
    activity: str = "unknown"
    native_id: str

    def public(self):
        return self.model_dump(exclude={"native_id"})


def command_json(command):
    process = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        chunks = bytearray()
        deadline = time.monotonic() + 8
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    return None
                data = os.read(process.stdout.fileno(), 65536)
                if not data:
                    break
                chunks.extend(data)
                if len(chunks) > 2_000_000:
                    return None
        if process.wait(timeout=1):
            return None
        return json.loads(chunks)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()


def codex_rows(native_ids=None, diagnostic=None):
    diagnostic = diagnostic if diagnostic is not None else {}
    diagnostic.update(status="unavailable", reason="interface_unavailable")
    rows = []
    version = command_json(["codex", "app-server", "daemon", "version"])
    if not isinstance(version, dict) or version.get("status") != "running":
        return []
    socket_path = version.get("socketPath")
    try:
        if not isinstance(socket_path, str) or not Path(socket_path).is_socket():
            return []
        diagnostic.update(status="available", reason=None)
        with unix_connect(socket_path, uri="ws://localhost/", open_timeout=5, close_timeout=1, max_size=2_000_000) as socket:
            counter = 0

            def call(method, params, timeout=5):
                nonlocal counter
                counter += 1
                socket.send(json.dumps({"id": counter, "method": method, "params": params}))
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    message = json.loads(socket.recv(timeout=max(0.001, deadline - time.monotonic())))
                    if isinstance(message, dict) and message.get("id") == counter:
                        if "result" not in message:
                            raise ValueError("codex_request_failed")
                        return message["result"]
                raise TimeoutError()

            call("initialize", {"clientInfo": {"name": "agentrun_observer", "version": __version__}})
            socket.send(json.dumps({"method": "initialized"}))
            if native_ids is not None:
                for native in native_ids:
                    try:
                        rows.append(call("thread/read", {"threadId": native, "includeTurns": False})["thread"])
                    except (ValueError, KeyError, TypeError):
                        continue
                return rows
            cursor = None
            deadline = time.monotonic() + 15
            for page in range(50):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    diagnostic.update(status="partial" if rows else "unavailable", reason="time_budget")
                    break
                result = call("thread/list", {"limit": 20, "cursor": cursor, "useStateDbOnly": True,
                                               "sourceKinds": ["cli", "vscode", "appServer"]}, timeout=min(5, remaining))
                if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                    raise ValueError("codex_invalid_response")
                rows.extend(result["data"][:1000 - len(rows)])
                cursor = result.get("nextCursor")
                if not cursor:
                    break
                if len(rows) >= 1000 or page == 49:
                    diagnostic.update(status="partial" if rows else "unavailable", reason="discovery_limit")
                    break
            return rows
    except TimeoutError:
        diagnostic.update(status="partial" if rows else "unavailable", reason="time_budget")
    except (OSError, ValueError, KeyError, TypeError, WebSocketException):
        diagnostic.update(status="partial" if rows else "unavailable", reason="transport_unavailable")
    return rows


def candidates(state, harness, rows):
    candidates = []
    if not isinstance(rows, list):
        return candidates
    for row in rows:
        if not isinstance(row, dict):
            continue
        native = (row.get("sessionId") or row.get("id")) if harness == "claude" else row.get("id")
        cwd = row.get("cwd")
        if not isinstance(native, str) or not native or len(native) > 256 or not isinstance(cwd, str) or len(cwd) > 4096:
            continue
        identity = state.identity(harness, native)
        if harness == "claude":
            status = row.get("status")
            status = status if isinstance(status, str) else None
            activity = {"busy": "working", "waiting": "waiting_input", "idle": "idle"}.get(status, "unknown")
            if activity == "unknown":
                lifecycle = row.get("state")
                lifecycle = lifecycle if isinstance(lifecycle, str) else None
                activity = {"working": "working", "blocked": "waiting_input", "done": "finished", "failed": "failed",
                            "stopped": "stopped"}.get(lifecycle, "unknown")
        else:
            status = row.get("status")
            status = status if isinstance(status, dict) else {}
            kind = status.get("type")
            kind = kind if isinstance(kind, str) else None
            activity = {"idle": "idle", "active": "working", "systemError": "failed"}.get(kind, "unknown")
            if kind == "active":
                flags = status.get("activeFlags", [])
                if not isinstance(flags, list) or not all(isinstance(flag, str) for flag in flags):
                    activity = "unknown"
                elif any(flag in {"waitingOnApproval", "waitingOnUserInput"} for flag in flags):
                    activity = "waiting_input"
        candidates.append(Candidate(id=identity, harness=harness, project_id=state.project(harness, cwd),
                                    project_label=re.sub(r"[^\w .-]", "", Path(cwd).name)[:80] or "Project",
                                    label=harness.title() + " " + re.sub(r"[^A-Za-z0-9_-]", "", native)[:8],
                                    native_id=native, activity=activity))
    return candidates


def discover(state):
    claude = command_json(["claude", "agents", "--json", "--all"])
    rows = candidates(state, "claude", claude)
    diagnostics = [{"harness": "claude", "status": "available" if isinstance(claude, list) else "unavailable",
                    "reason": None if isinstance(claude, list) else "interface_unavailable", "sessions": len(rows)}]
    codex_diagnostic = {"harness": "codex"}
    codex = candidates(state, "codex", codex_rows(diagnostic=codex_diagnostic))
    codex_diagnostic["sessions"] = len(codex)
    diagnostics.append(codex_diagnostic)
    rows.extend(codex)
    state.data["discovery_diagnostics"] = diagnostics
    state.save()
    return rows


def observe(state):
    selections = state.data["selections"]
    rows = []
    if any(source["harness"] == "claude" for source in selections):
        rows.extend(candidates(state, "claude", command_json(["claude", "agents", "--json", "--all"])))
    codex = [source for source in selections if source["harness"] == "codex"]
    if codex:
        identifiers = {source["external_session_id"] for source in codex}
        native_ids = [key.split(":", 1)[1] for key, value in state.data["identities"].items()
                      if key.startswith("codex:") and value in identifiers]
        rows.extend(candidates(state, "codex", codex_rows(None if any(source["mode"] != "session" for source in codex) else native_ids)))
    found = {row.id for row in rows}
    for source in selections:
        if source["mode"] == "session" and source["external_session_id"] not in found:
            identity = source["external_session_id"]
            rows.append(Candidate(id=identity, harness=source["harness"], project_id="unknown", label="Session " + identity[:8],
                                  native_id="", activity="unknown"))
    state.save()
    return rows
