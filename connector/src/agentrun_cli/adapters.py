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
from .session_labels import native_labels
from .learning_association import session_role

class Candidate(BaseModel):
    id: str
    harness: Literal["claude", "codex"]
    project_id: str
    project_label: str = "Project"
    label: str
    activity: str = "unknown"
    native_id: str
    usage_path: str | None = None
    model: str | None = None
    display_name: str | None = None
    project_name: str | None = None
    project_path: str | None = None
    session_role: Literal["root", "delegated", "unknown"] = "unknown"

    def public(self):
        return self.model_dump(exclude={"native_id", "usage_path", "model", "display_name", "project_name", "project_path", "session_role"})


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


def codex_rows(native_ids=None, diagnostic=None, stopping=None, loaded_only=False):
    diagnostic = diagnostic if diagnostic is not None else {}
    diagnostic.update(status="unavailable", reason="interface_unavailable")
    rows = []
    # Reserve one second for WebSocket cleanup inside the overall fifteen-second pass budget.
    deadline = time.monotonic() + 14
    def check():
        if stopping is not None and stopping():
            raise InterruptedError()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        return remaining
    if stopping is not None and stopping():
        diagnostic.update(reason="stopped")
        return []
    version = command_json(["codex", "app-server", "daemon", "version"])
    if not isinstance(version, dict) or version.get("status") != "running":
        return []
    socket_path = version.get("socketPath")
    try:
        if not isinstance(socket_path, str) or not Path(socket_path).is_socket():
            return []
        diagnostic.update(status="available", reason=None)
        with unix_connect(socket_path, uri="ws://localhost/", open_timeout=min(5, check()), close_timeout=1, max_size=2_000_000) as socket:
            counter = 0

            def call(method, params, timeout=5):
                nonlocal counter
                counter += 1
                remaining = check()
                socket.send(json.dumps({"id": counter, "method": method, "params": params}))
                call_deadline = time.monotonic() + min(timeout, remaining)
                while time.monotonic() < call_deadline:
                    check()
                    message = json.loads(socket.recv(timeout=max(0.001, call_deadline - time.monotonic())))
                    if isinstance(message, dict) and message.get("id") == counter:
                        if "result" not in message:
                            raise ValueError("codex_request_failed")
                        return message["result"]
                raise TimeoutError()

            call("initialize", {"clientInfo": {"name": "agentrun_observer", "version": __version__}})
            socket.send(json.dumps({"method": "initialized"}))
            seen = set()
            if native_ids is not None:
                for native in native_ids:
                    if native in seen: continue
                    try:
                        row = call("thread/read", {"threadId": native, "includeTurns": False})["thread"]
                        if isinstance(row, dict) and row.get("id") not in seen:
                            rows.append(row); seen.add(row.get("id"))
                    except (ValueError, KeyError, TypeError):
                        continue
                if not loaded_only:
                    return rows
            # Mixed selections also read explicitly selected unloaded sessions above, inside this same
            # pass deadline. Loaded threads include exec and delegated sessions; read them before any
            # fallback history walk so that walk cannot hide agents currently running.
            loaded_available = False
            try:
                loaded = call("thread/loaded/list", {"limit": 100})
                if not isinstance(loaded, dict) or not isinstance(loaded.get('data'), list) or not all(isinstance(item, str) for item in loaded['data']):
                    raise ValueError("codex_invalid_response")
                loaded_available = True
                for native in loaded.get("data", [])[:100]:
                    if not isinstance(native, str) or native in seen: continue
                    try:
                        row = call("thread/read", {"threadId": native, "includeTurns": False})["thread"]
                        if isinstance(row, dict) and row.get("id") not in seen:
                            rows.append(row); seen.add(row.get("id"))
                    except (ValueError, KeyError, TypeError):
                        continue
                if loaded.get("nextCursor"):
                    diagnostic.update(status="partial", reason="discovery_limit")
            except (ValueError, KeyError, TypeError):
                pass  # Older native daemons may not expose the loaded-list method.
            if loaded_only and loaded_available:
                return rows
            cursor = None
            for page in range(50):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    diagnostic.update(status="partial" if rows else "unavailable", reason="time_budget")
                    break
                result = call("thread/list", {"limit": 20, "cursor": cursor, "useStateDbOnly": True,
                                               "sourceKinds": ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"]}, timeout=min(5, remaining))
                if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                    raise ValueError("codex_invalid_response")
                for row in result["data"]:
                    if isinstance(row, dict) and row.get("id") not in seen and len(rows) < 1000:
                        rows.append(row); seen.add(row.get("id"))
                cursor = result.get("nextCursor")
                if not cursor:
                    break
                if len(rows) >= 1000 or page == 49:
                    diagnostic.update(status="partial" if rows else "unavailable", reason="discovery_limit")
                    break
            return rows
    except InterruptedError:
        diagnostic.update(status="partial" if rows else "unavailable", reason="stopped")
    except TimeoutError:
        diagnostic.update(status="partial" if rows else "unavailable", reason="time_budget")
    except (OSError, ValueError, KeyError, TypeError, WebSocketException):
        diagnostic.update(status="partial" if rows else "unavailable", reason="transport_unavailable")
    return rows


def candidates(state, harness, rows, *, selections=None, diagnostic=None):
    candidates = []
    if not isinstance(rows, list):
        return candidates
    selected = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        native = (row.get("sessionId") or row.get("id")) if harness == "claude" else row.get("id")
        cwd = row.get("cwd")
        if not isinstance(native, str) or not native or len(native) > 256 or not isinstance(cwd, str) or len(cwd) > 4096:
            continue
        identity = state.data["identities"].get(harness + ":" + native)
        project = state.data["projects"].get(harness + ":" + cwd)
        if selections is not None and not any(source["harness"] == harness and
                ((source["mode"] == "session" and identity is not None and source["external_session_id"] == identity) or
                 (source["include_future_sessions"] and (source["mode"] == "harness" or
                  (source["mode"] == "project" and project is not None and source["source_id"] == project))))
                for source in selections):
            continue
        selected.append((row, native, cwd))
    # Resolve the pass together: reparsing/copying the whole map for each known
    # session made discovery and repeated observation quadratic in session count.
    # Observation still allocates no project choices, even for a new directory.
    identifiers = state.candidate_ids(harness, [(native, cwd) for _, native, cwd in selected], projects=selections is None)
    for (row, native, cwd), resolved in zip(selected, identifiers):
        if resolved is None:
            if diagnostic is not None:
                diagnostic.update(status="partial", reason="candidate_limit")
            continue
        identity, project = resolved
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
        display_name, project_name = native_labels(row, harness, identity, cwd)
        candidates.append(Candidate(id=identity, harness=harness, project_id=project,
                                    project_label=re.sub(r"[^\w .-]", "", Path(cwd).name)[:80] or "Project",
                                    label=harness.title() + " " + re.sub(r"[^A-Za-z0-9_-]", "", native)[:8],
                                    native_id=native, activity=activity, display_name=display_name, project_name=project_name,
                                    project_path=cwd, session_role=session_role(harness, row),
                                    usage_path=row.get("path") if harness == "codex" and isinstance(row.get("path"), str) else None,
                                    model=row.get("model") if harness == "codex" and isinstance(row.get("model"), str) else None))
    return candidates


def discover(state):
    claude = command_json(["claude", "agents", "--json", "--all"])
    claude_diagnostic = {"harness": "claude", "status": "available" if isinstance(claude, list) else "unavailable",
                         "reason": None if isinstance(claude, list) else "interface_unavailable"}
    rows = candidates(state, "claude", claude, diagnostic=claude_diagnostic)
    claude_diagnostic["sessions"] = len(rows)
    diagnostics = [claude_diagnostic]
    codex_diagnostic = {"harness": "codex"}
    codex = candidates(state, "codex", codex_rows(diagnostic=codex_diagnostic), diagnostic=codex_diagnostic)
    codex_diagnostic["sessions"] = len(codex)
    diagnostics.append(codex_diagnostic)
    rows.extend(codex)
    state.data["discovery_diagnostics"] = diagnostics
    state.save()
    return rows


def observe(state, stopping=None):
    if stopping is not None and stopping():
        return []
    selections = state.data["selections"]
    rows = []
    diagnostics = []
    if any(source["harness"] == "claude" for source in selections):
        claude = command_json(["claude", "agents", "--json", "--all"])
        diagnostic = {"harness": "claude", "status": "available" if isinstance(claude, list) else "unavailable",
                      "reason": None if isinstance(claude, list) else "interface_unavailable"}
        observed = candidates(state, "claude", claude, selections=selections, diagnostic=diagnostic)
        diagnostic["sessions"] = len(observed)
        diagnostics.append(diagnostic)
        rows.extend(observed)
    if stopping is not None and stopping():
        return rows
    codex = [source for source in selections if source["harness"] == "codex"]
    if codex:
        identifiers = {source["external_session_id"] for source in codex if source["mode"] == "session"}
        native_ids = [key.split(":", 1)[1] for key, value in state.data["identities"].items()
                      if key.startswith("codex:") and value in identifiers]
        diagnostic = {"harness": "codex"}
        observed = candidates(state, "codex", codex_rows(native_ids,
                              diagnostic=diagnostic, stopping=stopping, loaded_only=any(source["mode"] != "session" for source in codex)), selections=selections, diagnostic=diagnostic)
        diagnostic["sessions"] = len(observed)
        diagnostics.append(diagnostic)
        rows.extend(observed)
    found = {row.id for row in rows}
    for source in selections:
        if source["mode"] == "session" and source["external_session_id"] not in found:
            identity = source["external_session_id"]
            rows.append(Candidate(id=identity, harness=source["harness"], project_id="unknown", label="Session " + identity[:8],
                                  native_id="", activity="unknown"))
    state.data["discovery_diagnostics"] = diagnostics
    state.save()
    return rows
