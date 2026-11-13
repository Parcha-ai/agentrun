"""Native telemetry setup without editing harness configuration or starting workloads."""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

from .network import APIError, request

NATIVE_EVENTS = {
    "claude": ["user_prompt", "api_request", "tool_result"],
    "codex": ["codex.conversation_starts", "codex.user_prompt", "codex.api_request", "codex.tool_result"],
}
LIFECYCLE_EVENTS = ["agentrun.session." + activity for activity in
                    ["working", "waiting_input", "idle", "finished", "failed", "stopped", "unknown"]]
TOKEN_ATTRIBUTES = ["agentrun.input_tokens", "agentrun.output_tokens", "agentrun.cache_read_tokens",
                    "agentrun.cache_write_tokens"]
MAX_TOKEN_COUNT = 9007199254740991


def token_statements(harness):
    """Convert bounded native request counters to a cache-inclusive input count."""
    names = (["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"] if harness == "claude"
             else ["input_token_count", "output_token_count", "cached_token_count", "cache_write_token_count"])

    def count_valid(name):
        value = 'attributes[' + json.dumps(name) + ']'
        return f'({value} != nil and IsMatch(String({value}), "^[0-9]{{1,16}}$") and Int({value}) <= {MAX_TOKEN_COUNT})'

    checks = ['IsString(attributes["model"])',
              'IsMatch(attributes["model"], "^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$")']
    for index, name in enumerate(names):
        check = count_valid(name)
        checks.append(f'(attributes[{json.dumps(name)}] == nil or {check})' if harness == "codex" and index > 1 else check)
    event_check = ('(attributes["event.name"] == "api_request" or attributes["event.name"] == "claude_code.api_request")'
                   if harness == "claude" else
                   '(attributes["event.name"] == "codex.sse_event" and attributes["event.kind"] == "response.completed")')
    statements = ['set(cache["usage.valid"], true) where ' + " and ".join([event_check, *checks])]
    for label, native in zip(["input", "output", "read", "write"], names):
        statements += [f'set(cache["usage.{label}"], 0)',
                       f'set(cache["usage.{label}"], Int(attributes[{json.dumps(native)}])) where '
                       f'cache["usage.valid"] == true and attributes[{json.dumps(native)}] != nil']
    if harness == "claude":
        statements.append('set(cache["usage.input"], cache["usage.input"] + cache["usage.read"] + cache["usage.write"]) '
                          'where cache["usage.valid"] == true')
    statements.append('set(cache["usage.valid"], false) where cache["usage.valid"] == true and '
                      f'(cache["usage.input"] + cache["usage.output"] > {MAX_TOKEN_COUNT} or '
                      'cache["usage.read"] + cache["usage.write"] > cache["usage.input"])')
    statements.append('set(attributes["agentrun.model"], attributes["model"]) where cache["usage.valid"] == true')
    for canonical, label, native in zip(TOKEN_ATTRIBUTES, ["input", "output", "read", "write"], names):
        condition = 'cache["usage.valid"] == true'
        if harness == "codex" and label in {"read", "write"}:
            condition += f' and attributes[{json.dumps(native)}] != nil'
        statements.append(f'set(attributes[{json.dumps(canonical)}], cache["usage.{label}"]) where ' + condition)
    if harness == "codex":
        statements.append('set(attributes["event.name"], "codex.response_usage") where '
                          'attributes["event.name"] == "codex.sse_event" and attributes["event.kind"] == "response.completed"')
    return statements


def deployment_selections(args, state):
    if not args.workspace_id or args.select or args.subscribe_project or not args.subscribe_harness:
        raise ValueError("telemetry_scope_required")
    if set(args.subscribe_harness) - {"claude", "codex"}:
        raise ValueError("unsupported_harness")
    return [{"source_id": state.data.setdefault("subscriptions", {}).setdefault(harness, str(uuid4())),
             "harness": harness, "mode": "harness", "external_session_id": None, "include_future_sessions": True}
            for harness in sorted(set(args.subscribe_harness))]


def check_capabilities(api_origin, harnesses):
    try:
        value = request(api_origin, None, "GET", "/connectors/capabilities")
    except (APIError, OSError, ValueError):
        raise ValueError("telemetry_unavailable") from None
    if (not set(harnesses).issubset(value["supported_harnesses"]) or
            "otlp" not in value["ingestion_modes"] or "json" not in value["logs_formats"] or
            value["logs_endpoint_template"] != "/api/v2/control/connectors/{connector_id}/otel/v1/logs" or
            value["selections_revision_header"] != "X-AgentRun-Selections-Revision" or
            value["privacy"].get("metadata_only") is not True or
            value["privacy"].get("raw_session_ids") is not False or
            value["privacy"] != {"metadata_only": True, "session_id_attribute": "agentrun.session_id",
                                 "session_id_format": "sha256", "raw_session_ids": False}):
        raise ValueError("telemetry_unavailable")
    usage = value.get("token_usage")
    if usage is None:
        return []
    supported = usage.get("supported_harnesses")
    if (not isinstance(supported, list) or not all(isinstance(item, str) for item in supported)
            or usage.get("model_attribute") != "agentrun.model"
            or usage.get("count_attributes") != TOKEN_ATTRIBUTES
            or usage.get("input_includes_cache") is not True):
        raise ValueError("telemetry_unavailable")
    return sorted(set(harnesses) & set(supported))


def setup(target):
    environment = "kubernetes" if os.environ.get("KUBERNETES_SERVICE_HOST") else (
        "docker" if Path("/.dockerenv").exists() else "host")
    harnesses = []
    for harness in ("claude", "codex"):
        binary = shutil.which(harness)
        version = None
        if binary:
            try:
                output = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=3)
                match = re.search(r"\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b", output.stdout[:4096])
                version = match.group(0) if match else None
            except (OSError, subprocess.SubprocessError):
                pass
        harnesses.append({"harness": harness, "installed": bool(binary), "version": version})
    names = sorted(name for name in os.environ if name.startswith("OTEL_") or name == "CLAUDE_CODE_ENABLE_TELEMETRY")
    codex_config = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"
    codex_otel = False
    if codex_config.is_file():
        import tomllib
        try:
            codex_otel = "otel" in tomllib.loads(codex_config.read_text()[:1_000_000])
        except (OSError, ValueError):
            codex_otel = True
    claude_otel = False
    for settings in [Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) / "settings.json",
                     Path.cwd() / ".claude" / "settings.json", Path.cwd() / ".claude" / "settings.local.json"]:
        try:
            value = json.loads(settings.read_text()[:1_000_000]) if settings.is_file() else {}
            env = value.get("env", {}) if isinstance(value, dict) else {}
            claude_otel |= isinstance(env, dict) and any(name.startswith("OTEL_") or name == "CLAUDE_CODE_ENABLE_TELEMETRY" for name in env)
        except (OSError, ValueError):
            claude_otel = True
    choice = "native_otlp" if target == "deployment" or (target == "auto" and environment != "host") else "observer"
    return {"environment": environment, "target": target, "recommendation": choice,
            "harnesses": harnesses, "existing_telemetry": {"environment_variable_names": names,
            "codex_config_present": codex_otel, "claude_config_present": claude_otel,
            "collector_binary_present": bool(shutil.which("otelcol-contrib"))},
            "requires_new_harness_process": choice == "native_otlp", "configuration_changed": False,
            "guidance": "Use observer for already-running sessions without restart; native_otlp for a new deployment. Review existing telemetry destinations before merging the generated fragments."}


def private_file(directory, name, content):
    temporary = directory / ("." + name + "-" + str(uuid4()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
        os.replace(temporary, directory / name)
    finally:
        temporary.unlink(missing_ok=True)


def configure(state):
    directory = state.directory / "telemetry"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink():
        raise ValueError("unsafe_state")
    directory.chmod(0o700)
    queue = directory / "queue"
    queue.mkdir(mode=0o700, exist_ok=True)
    if queue.is_symlink():
        raise ValueError("unsafe_state")
    config = {"extensions": {"file_storage/agentrun": {"directory": "${env:AGENTRUN_OTEL_QUEUE_DIRECTORY}"}},
              "receivers": {}, "processors": {}, "exporters": {"otlphttp/agentrun": {
                  "logs_endpoint": state.data["origin"] + "/api/v2/control/connectors/" + state.data["connector_id"] + "/otel/v1/logs",
                  "encoding": "json", "compression": "none",
                  "headers": {"Authorization": "Bearer ${env:AGENTRUN_CONNECTOR_CREDENTIAL}",
                              "X-AgentRun-Selections-Revision": str(state.data["selections_revision"])},
                  "retry_on_failure": {"enabled": True, "max_elapsed_time": "0s"},
                  "sending_queue": {"enabled": True, "queue_size": 1000, "storage": "file_storage/agentrun"}}},
              "service": {"extensions": ["file_storage/agentrun"], "pipelines": {}}}
    files = []
    token_harnesses = state.data.get("token_usage_harnesses", [])
    for source in state.data["selections"]:
        harness = source["harness"]
        port = 4318 if harness == "claude" else 4319
        receiver, transform, filter_name, batch = [name + "/agentrun_" + harness for name in ("otlp", "transform", "filter", "batch")]
        config["receivers"][receiver] = {"protocols": {"http": {"endpoint": f"127.0.0.1:{port}"}}}
        native_key = "session.id" if harness == "claude" else "conversation.id"
        names = NATIVE_EVENTS[harness] + LIFECYCLE_EVENTS
        usage_enabled = harness in token_harnesses
        if harness == "codex" and usage_enabled:
            names += ["codex.sse_event"]
        if harness == "claude":
            names += ["claude_code." + name for name in NATIVE_EVENTS[harness]]
        condition = " and ".join('attributes["event.name"] != ' + json.dumps(name) for name in names)
        filters = ['attributes[' + json.dumps(native_key) + '] == nil', condition]
        if harness == "codex" and usage_enabled:
            filters.append('attributes["event.name"] == "codex.sse_event" and attributes["event.kind"] != "response.completed"')
        config["processors"][filter_name] = {"error_mode": "propagate", "logs": {"log_record": filters}}
        allowed = ["agentrun.session_id", "event.name"] + (["agentrun.model", *TOKEN_ATTRIBUTES] if usage_enabled else [])
        config["processors"][transform] = {"error_mode": "propagate", "log_statements": [{
            "context": "log", "statements": [
                'delete_matching_keys(attributes, "^agentrun[.]")',
                'set(attributes["agentrun.session_id"], SHA256(Concat([' + json.dumps(state.data["installation_id"] + ":") +
                ', attributes[' + json.dumps(native_key) + ']], "")))',
                *(token_statements(harness) if usage_enabled else []),
                'keep_keys(attributes, ' + json.dumps(allowed) + ')',
                'set(body, "")', 'set(event_name, "")', 'set(severity_text, "")',
                'set(severity_number, 0)', 'set(flags, 0)', 'set(dropped_attributes_count, 0)',
                'set(observed_time_unix_nano, 0)',
                'set(trace_id, TraceID(0x00000000000000000000000000000000))',
                'set(span_id, SpanID(0x0000000000000000))',
                'keep_keys(resource.attributes, [])', 'keep_keys(instrumentation_scope.attributes, [])',
                'set(resource.schema_url, "")', 'set(instrumentation_scope.schema_url, "")',
                'set(resource.dropped_attributes_count, 0)', 'set(instrumentation_scope.dropped_attributes_count, 0)',
                'set(instrumentation_scope.name, "agentrun")', 'set(instrumentation_scope.version, "1")',
                'set(resource.attributes["agentrun.source_id"], ' + json.dumps(source["source_id"]) + ')',
                'set(resource.attributes["agentrun.harness"], ' + json.dumps(harness) + ')',
            ]}]}
        config["processors"][batch] = {"send_batch_size": 50, "send_batch_max_size": 100, "timeout": "1s"}
        config["service"]["pipelines"]["logs/agentrun_" + harness] = {
            "receivers": [receiver], "processors": [filter_name, transform, batch], "exporters": ["otlphttp/agentrun"]}
        if harness == "claude":
            private_file(directory, "claude.env", "\n".join([
                "CLAUDE_CODE_ENABLE_TELEMETRY=1", "OTEL_LOGS_EXPORTER=otlp", "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf",
                f"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:{port}/v1/logs",
                "OTEL_LOG_USER_PROMPTS=0", "OTEL_LOG_TOOL_DETAILS=0", ""]))
            files.append(str(directory / "claude.env"))
            hook_command = shlex.join([sys.executable, "-I", "-m", "agentrun_cli", "hook"])
            hooks = {"hooks": {event: [{"hooks": [{"type": "command", "command": hook_command, "timeout": 2}]}]
                               for event in ["UserPromptSubmit", "Stop", "SessionEnd"]}}
            hooks["hooks"]["Notification"] = [{"matcher": "permission_prompt|elicitation_dialog",
                                               "hooks": [{"type": "command", "command": hook_command, "timeout": 2}]}]
            private_file(directory, "claude-hooks.json", json.dumps(hooks, indent=2) + "\n")
            files.append(str(directory / "claude-hooks.json"))
        else:
            private_file(directory, "codex.toml", '[otel]\nlog_user_prompt = false\n\n[otel.exporter.otlp-http]\n' +
                         f'endpoint = "http://127.0.0.1:{port}/v1/logs"\nprotocol = "binary"\n')
            files.append(str(directory / "codex.toml"))
    private_file(directory, "collector.yaml", json.dumps(config, indent=2) + "\n")
    private_file(directory, "collector.env", "AGENTRUN_CONNECTOR_CREDENTIAL=" + shlex.quote(state.data["credential"]) +
                 "\nAGENTRUN_OTEL_QUEUE_DIRECTORY=" + shlex.quote(str(queue)) + "\n")
    return {"directory": str(directory), "config_path": str(directory / "collector.yaml"),
            "credential_env_file": str(directory / "collector.env"), "harness_files": files,
            "token_usage_harnesses": token_harnesses,
            "collector_started": False, "delivery_verified": False,
            "next_step": "Review and deploy the Collector with its private environment file; merge only the selected harness fragments for new processes. Existing configuration was not changed."}
