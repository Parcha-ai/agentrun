import argparse
import getpass
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlencode
from uuid import uuid4

from . import __version__
from .adapters import discover
from .daemon import run, start, status, stop
from .device_auth import authenticate as device_authenticate
from .network import MAX_SELECTIONS, APIError, origin, read_credential, request
from .picker import choose_sessions
from .picker import supported as interactive_picker_supported
from .queue import Queue, destination
from .startup import configure as startup
from .state import State
from . import telemetry

ERROR_MESSAGES = {
    "invalid_observation_checkpoint": "The local observation checkpoint is invalid. Preserve this state directory for inspection and reconnect with a separate state directory.",
    "observation_sequence_exhausted": "This state directory exhausted its observation sequence. Reconnect with a separate state directory; the sequence is never reset.",
    "ingestion_mode_mismatch": "The destination did not confirm the requested ingestion mode. Update its connector receiver, disconnect, and enroll again; local observation remains stopped.",
    "telemetry_scope_required": "Telemetry setup requires an explicit workspace and --subscribe-harness claude or codex; session and project selections use the local observer.",
    "telemetry_unavailable": "This API does not advertise compatible metadata-only OTLP ingestion. Ask its administrator to configure telemetry support.",
    "invalid_credential_env": "Supply the name of a nonempty enrollment-secret environment variable and an explicit origin and workspace; its value is never printed.",
    "ingestion_mode_change_requires_disconnect": "Disconnect before changing between polling and telemetry, or use a separate state directory.",
    "telemetry_managed_externally": "This connection uses an external OpenTelemetry Collector. Start or stop that deployment through its supervisor; the local polling daemon is not used.",
    "credential_file_required": "Use --device-auth, a private origin-bound credential file, or an interactive terminal to enter the API key.",
    "invalid_origin": "Use an HTTPS API origin without a path, query, or credentials; HTTP is allowed only for loopback development.",
    "unsafe_credential": "The credential must be a regular file owned by you with mode 0600.",
    "invalid_credential": "The private credential file must contain an origin and a nonempty API key.",
    "credential_origin_mismatch": "The credential file belongs to a different API origin.",
    "authentication_failed": "Authentication failed. Supply a fresh credential for this destination.",
    "permission_denied": "The credential cannot manage this workspace or connector.",
    "service_unavailable": "The destination is unavailable. Retry later; pending metadata is retained.",
    "redirect_refused": "The destination redirected the request. Verify the API origin; credentials were not forwarded.",
    "not_connected": "Connect and explicitly select sources before starting observation.",
    "disconnect_before_destination_change": "Disconnect the current destination before choosing another, or use a separate state directory.",
    "explicit_selection_and_workspace_required": "Noninteractive connect requires an explicit workspace and session or subscription selection.",
    "workspace_not_authorized": "Choose a workspace returned by the authenticated identity.",
    "invalid_selection": "Choose one or more discovered sessions or explicit subscriptions, up to 1,000 selections per connector.",
    "no_supported_sessions": "No supported local sessions were found. Start a Claude Code session or use a Codex app-server daemon with visible threads, then run agentrun discover and connect again. Installing the Codex CLI alone does not expose sessions.",
    "invalid_project": "Choose a project ID from local discovery.",
    "unsupported_harness": "Choose an available Claude Code or Codex source.",
    "unsafe_state": "Use a private state directory owned by you without symlinks.",
    "candidate_limit": "This installation reached its local discovery limit. Use a separate state directory for additional sources.",
    "startup_unsupported": "Automatic login startup is supported only with Linux systemd user services.",
    "startup_failed": "The Linux user service could not be configured. Foreground observation remains available.",
    "daemon_start_failed": "The daemon did not become ready. Inspect status and retry a foreground start.",
    "daemon_stop_failed": "The daemon did not acknowledge stopping. Inspect its status before retrying.",
    "daemon_action_required": "Choose daemon start or daemon stop.",
    "invalid_interval": "Choose an interval between 1 and 3600 seconds.",
    "invalid_queue_limits": "Choose queue limits within the documented ranges.",
    "request_failed": "The request could not be completed. Check the destination, private credentials, and selected sources.",
    "device_invalid_response": "Device sign-in returned invalid or untrusted data. Verify the API origin and retry, or use a private API key file.",
    "device_authorization_denied": "Device sign-in was denied. Run the command again and approve the displayed code to continue.",
    "device_authorization_expired": "The device sign-in code expired. Run the command again to obtain a new code.",
    "device_authorization_cancelled": "Device sign-in was cancelled. Run the command again when you are ready to approve a new code.",
    "device_authorization_unavailable": "Device sign-in is unavailable for this destination. Ask its administrator to configure Descope device authorization, or use --credential-file.",
}


def safe_error(error):
    code = str(error) if isinstance(error, ValueError) and str(error) in ERROR_MESSAGES else "request_failed"
    if isinstance(error, APIError):
        code = ("authentication_failed" if error.status == 401 else "permission_denied" if error.status == 403 else
                "redirect_refused" if 300 <= error.status < 400 else
                "service_unavailable" if error.status == 429 or error.status >= 500 else "request_failed")
    return {"error": code, "message": ERROR_MESSAGES[code]}


def enrollment_credential(args, api_origin):
    if args.device_auth:
        return device_authenticate(api_origin)
    if args.credential_file:
        return read_credential(args.credential_file, api_origin)
    if args.credential_env:
        if not args.origin or (args.command == "connect" and not args.workspace_id) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.credential_env):
            raise ValueError("invalid_credential_env")
        token = os.environ.get(args.credential_env, "")
        if not token or len(token) > 8192 or "\n" in token or "\r" in token:
            raise ValueError("invalid_credential_env")
        return token
    if not sys.stdin.isatty():
        raise ValueError("credential_file_required")
    token = getpass.getpass("API key for " + api_origin + ": ")
    if not token or len(token) > 8192 or "\n" in token or "\r" in token:
        raise ValueError("invalid_credential")
    return token


def disconnect(args, state):
    if not state.data.get("connector_id"):
        return {"status": "disconnected"}
    state.data.update(observing=False, revocation_pending=True)
    state.save()
    stop(state)
    if state.data.get("startup_enabled"):
        startup(state, "disable")
    # Reload after the daemon releases its lock; it may have reconciled config while stopping.
    state.data = state.read()
    try:
        api_origin = origin(state.data["origin"])
        if args.origin and origin(args.origin) != api_origin:
            raise ValueError("credential_origin_mismatch")
        token = enrollment_credential(args, api_origin)
        request(api_origin, token, "DELETE", "/connectors/" + state.data["connector_id"] + "?" +
                urlencode({"workspace_id": state.data["workspace_id"]}))
    except (APIError, OSError, ValueError) as error:
        return {"status": "revocation_pending", "observing": False, **safe_error(error)}
    queue = Queue(state.directory)
    try:
        queue.clear_pending()
    finally:
        queue.close()
    state.data.update(revocation_pending=False, disconnected=True)
    state.data.pop("credential", None)
    if state.data.get("ingestion_mode") == "otlp":
        (state.directory / "telemetry" / "collector.env").unlink(missing_ok=True)
    state.save()
    return {"status": "disconnected"}


def connect(args, state):
    if not 1 <= args.queue_limit <= 10000 or not 1024 <= args.queue_byte_limit <= 10_000_000 or not 0 <= args.refresh_seconds <= 120:
        raise ValueError("invalid_queue_limits")
    api_origin = origin(args.origin)
    if state.data.get("connector_id") and not state.data.get("disconnected"):
        if (state.data["origin"] != api_origin or
                (args.workspace_id and state.data["workspace_id"] != args.workspace_id)):
            raise ValueError("disconnect_before_destination_change")
    mode = "otlp" if args.telemetry else "polling"
    if state.data.get("connector_id") and not state.data.get("disconnected") and state.data.get("ingestion_mode", "polling") != mode:
        raise ValueError("ingestion_mode_change_requires_disconnect")
    if args.telemetry:
        telemetry.deployment_selections(args, state)
        state.data["token_usage_harnesses"] = telemetry.check_capabilities(api_origin, args.subscribe_harness)
    chosen = args.select
    used_picker = False
    if args.yes and (not (chosen or args.subscribe_project or args.subscribe_harness) or not args.workspace_id):
        raise ValueError("explicit_selection_and_workspace_required")
    token = enrollment_credential(args, api_origin)
    identity = request(api_origin, token, "GET", "/identity")
    workspaces = identity["workspace_ids"]
    workspace = args.workspace_id
    if not workspace:
        if len(workspaces) == 1:
            workspace = workspaces[0]
        else:
            print(json.dumps({"workspaces": workspaces}))
            workspace = input("Destination workspace ID: ").strip()
    if workspace not in workspaces:
        raise ValueError("workspace_not_authorized")
    if state.data.get("connector_id") and not state.data.get("disconnected") and state.data["workspace_id"] != workspace:
        raise ValueError("disconnect_before_destination_change")
    if not args.yes:
        print(json.dumps({"destination": api_origin, "workspace_id": workspace}))
        if input("Use this destination workspace? [y/N] ").strip().lower() not in {"y", "yes"}:
            return {"status": "cancelled"}
    if args.telemetry:
        selections = telemetry.deployment_selections(args, state)
        state.data["discovery_diagnostics"] = []
    else:
        candidates = discover(state)
        if not candidates:
            raise ValueError("no_supported_sessions")
        if not args.yes and any(adapter["status"] != "available" for adapter in state.data["discovery_diagnostics"]):
            print(json.dumps({"discovery_adapters": state.data["discovery_diagnostics"]}))
        if not chosen and not args.subscribe_project and not args.subscribe_harness and interactive_picker_supported():
            picked = choose_sessions(candidates)
            if picked is None:
                return {"status": "cancelled"}
            chosen, args.subscribe_project, args.subscribe_harness = picked
            used_picker = True
        if not chosen and not args.subscribe_project and not args.subscribe_harness:
            print("Plain selection mode: interactive navigation requires a capable terminal on stdin and stdout.")
            for index, candidate in enumerate(candidates, 1):
                print(f"{index}. {candidate.label} ({candidate.harness}) — {candidate.project_label}; project:{candidate.project_id}")
            print("Numbers select only existing sessions. project:ID or harness:claude / harness:codex also include future matching sessions.")
            choice = input("Select comma-separated sessions/subscriptions, or none to cancel: ").strip()
            if not choice or choice.lower() in {"none", "cancel"}:
                return {"status": "cancelled"}
            chosen = []
            for value in choice.split(","):
                value = value.strip()
                if value.startswith("project:"):
                    args.subscribe_project.append(value.split(":", 1)[1])
                elif value.startswith("harness:"):
                    args.subscribe_harness.append(value.split(":", 1)[1])
                elif int(value) > 0:
                    chosen.append(candidates[int(value) - 1].id)
        selected = [candidate for candidate in candidates if candidate.id in chosen]
        if len(selected) != len(set(chosen)):
            raise ValueError("invalid_selection")
        selections = [{"source_id": candidate.id, "harness": candidate.harness, "mode": "session",
                       "external_session_id": candidate.id, "include_future_sessions": False} for candidate in selected]
        for project_id in set(args.subscribe_project):
            project = next((candidate for candidate in candidates if candidate.project_id == project_id), None)
            if project is None:
                raise ValueError("invalid_project")
            selections.append({"source_id": project_id, "harness": project.harness, "mode": "project",
                               "external_session_id": None, "include_future_sessions": True})
        for harness in set(args.subscribe_harness):
            if harness not in {"claude", "codex"} or not any(candidate.harness == harness for candidate in candidates):
                raise ValueError("unsupported_harness")
            source_id = state.data.setdefault("subscriptions", {}).setdefault(harness, str(uuid4()))
            selections.append({"source_id": source_id, "harness": harness, "mode": "harness",
                               "external_session_id": None, "include_future_sessions": True})
    if not selections or len(selections) > MAX_SELECTIONS:
        raise ValueError("invalid_selection")
    if not args.yes:
        if used_picker:
            print(f"Destination: {api_origin}\nWorkspace: {workspace}")
            print(f"Connect {len(selected)} existing sessions; future subscriptions: "
                  f"{len(set(args.subscribe_project))} projects, {len(set(args.subscribe_harness))} harnesses.")
        else:
            print(json.dumps({"destination": api_origin, "workspace_id": workspace, "selections": selections}))
        print("Share selected session identity, harness, activity and timestamps." +
              (" Native telemetry also shares reported model names and token counts." if args.telemetry else "") +
              " Project/harness subscriptions include future sessions.")
        if input("Confirm workspace and metadata selection? [y/N] ").strip().lower() not in {"y", "yes"}:
            return {"status": "cancelled"}
    stop(state)
    pending = state.data.get("pending_registration", {})
    body = {"workspace_id": workspace, "installation_id": state.data["installation_id"],
            "display_name": args.name, "cli_version": __version__,
            "ingestion_mode": mode,
            "adapters": [{"harness": harness, "adapter_version": "1", "activity": "lifecycle"}
                         for harness in ["claude", "codex"]], "selections": selections}
    fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    unchanged = pending.get("origin") == api_origin and pending.get("fingerprint") == fingerprint
    body["operation_id"] = pending["operation_id"] if unchanged else str(uuid4())
    state.data["pending_registration"] = {"origin": api_origin, "workspace_id": workspace,
                                          "operation_id": body["operation_id"], "fingerprint": fingerprint}
    state.save()
    try:
        registered = request(api_origin, token, "POST", "/connectors", body)
    except APIError as error:
        detail = error.payload.get("detail", {})
        if error.status != 409 or not isinstance(detail, dict) or detail.get("code") != "connector_reauthentication_required":
            raise
        connector_id = detail.get("connector_id", "")
        if not isinstance(connector_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", connector_id):
            raise ValueError("invalid_response") from None
        suffix = "?" + urlencode({"workspace_id": workspace})
        registered = request(api_origin, token, "POST", "/connectors/" + connector_id + "/rotate-credential" + suffix, {})
        updated = request(api_origin, token, "PATCH", "/connectors/" + connector_id + "/selections" + suffix,
                          {"selections_revision": registered["connector"]["selections_revision"], "selections": selections})
        registered["connector"] = updated
    connector = registered["connector"]
    if connector.get("ingestion_mode") != mode:
        state.data.update(observing=False, reconnect_required=True, delivery_state="configuration_refresh_required")
        state.save()
        raise ValueError("ingestion_mode_mismatch")
    state.data.update({"origin": api_origin, "workspace_id": workspace, "connector_id": connector["id"],
                       "credential": registered["credential"], "credential_expires_at": registered["credential_expires_at"],
                       "selections": selections, "approved_selections": selections,
                       "selections_revision": connector["selections_revision"],
                       "queue_limit": args.queue_limit, "queue_byte_limit": args.queue_byte_limit, "refresh_seconds": args.refresh_seconds,
                       "observing": not args.telemetry, "ingestion_mode": mode, "revocation_pending": False, "reconnect_required": False, "disconnected": False})
    state.data.pop("pending_registration", None)
    state.save()
    Queue(state.directory, binding=destination(state)).close()
    daemon = "stopped"
    if args.telemetry:
        state.data["delivery_state"] = "unverified"
        bundle = telemetry.configure(state)
        state.data["telemetry"] = bundle
        state.save()
        return {"status": "configured", "connector_id": connector["id"], "ingestion_mode": mode,
                "selected_sources": selections, "daemon": daemon, "telemetry": bundle}
    if not args.no_start:
        start(state, args.interval)
        daemon = "running"
    if sys.stdin.isatty() and not args.yes and sys.platform == "linux":
        if input("Start automatically after login with a Linux user service? [y/N] ").strip().lower() in {"y", "yes"}:
            startup(state, "enable")
    return {"status": "connected", "connector_id": connector["id"], "selected_sources": len(selections), "daemon": daemon,
            "adapters": state.data["discovery_diagnostics"]}


def main(argv=None):
    incoming = sys.argv[1:] if argv is None else argv
    if incoming and incoming[0] == "remote":
        from .remote import main as remote_main
        return remote_main(incoming[1:])
    parser = argparse.ArgumentParser(prog="agentrun")
    parser.add_argument("command", choices=["setup", "hook", "discover", "connect", "status", "daemon", "disconnect", "startup"])
    parser.add_argument("action", nargs="?", choices=["start", "stop", "enable", "disable", "status"])
    parser.add_argument("--state-dir", default=str(Path.home() / ".agentrun"))
    parser.add_argument("--origin")
    parser.add_argument("--workspace-id")
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument("--credential-env", help="Environment variable name containing an enrollment API key")
    credentials.add_argument("--credential-file", help="Private origin-bound API key file for connect/disconnect")
    credentials.add_argument("--device-auth", action="store_true", help="Sign in on another device for connect/disconnect")
    parser.add_argument("--telemetry", action="store_true", help="Configure native OTLP collection for explicit future harness subscriptions")
    parser.add_argument("--target", choices=["auto", "existing-sessions", "deployment"], default="auto", help="Setup recommendation target")
    parser.add_argument("--hook-endpoint", default="http://127.0.0.1:4318/v1/logs", help="Loopback Collector endpoint for the Claude lifecycle hook")
    parser.add_argument("--select", action="append", default=[])
    parser.add_argument("--subscribe-project", action="append", default=[])
    parser.add_argument("--subscribe-harness", action="append", default=[])
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--no-start", action="store_true")
    parser.add_argument("--name", default="Local connector")
    parser.add_argument("--foreground", action="store_true")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=float, default=30)
    parser.add_argument("--ready-fd", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--queue-limit", type=int, default=1000)
    parser.add_argument("--queue-byte-limit", type=int, default=1_000_000)
    parser.add_argument("--refresh-seconds", type=float, default=60)
    args = parser.parse_args(argv)
    try:
        if args.command == "hook":
            from .hooks import emit
            emit(args.hook_endpoint)
            return 0
        if args.command == "setup":
            print(json.dumps(telemetry.setup(args.target)))
            return 0
        state = State(args.state_dir)
        if args.command == "discover":
            candidates = discover(state)
            print(json.dumps({"sessions": [candidate.public() for candidate in candidates],
                              "adapters": state.data["discovery_diagnostics"]}))
        elif args.command == "status":
            print(json.dumps(status(state)))
        elif args.command == "daemon":
            if state.data.get("ingestion_mode") == "otlp":
                raise ValueError("telemetry_managed_externally")
            if not 1 <= args.interval <= 3600:
                raise ValueError("invalid_interval")
            if args.action == "stop":
                result = stop(state)
            elif args.action != "start":
                raise ValueError("daemon_action_required")
            elif args.foreground or args.once:
                result = run(state, once=args.once, interval=args.interval, ready_fd=args.ready_fd)
            else:
                result = start(state, args.interval)
            print(json.dumps(result))
        elif args.command == "disconnect":
            result = disconnect(args, state)
            print(json.dumps(result))
            if result["status"] == "revocation_pending":
                return 2
        elif args.command == "startup":
            if state.data.get("ingestion_mode") == "otlp" and args.action == "enable":
                raise ValueError("telemetry_managed_externally")
            print(json.dumps(startup(state, args.action)))
        else:
            print(json.dumps(connect(args, state)))
        return 0
    except (ValueError, OSError, EOFError, IndexError, KeyError, TypeError, APIError, subprocess.SubprocessError) as error:
        payload = safe_error(error)
        if payload["error"] == "no_supported_sessions":
            payload["adapters"] = state.data["discovery_diagnostics"]
        print(json.dumps(payload))
        return 1
    except KeyboardInterrupt:
        return 0
