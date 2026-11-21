"""Outbound observation daemon. Source activity is independent from its heartbeat."""

import fcntl
import os
import random
import selectors
import select
import signal
import socket
import subprocess
import sys
import time

from .adapters import observe
from .network import APIError, request
from .queue import Queue, destination
from .learning_association import discover_learning


def lock(directory):
    fd = os.open(directory / "daemon.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BlockingIOError:
        os.close(fd)
        return None


def running(directory):
    fd = lock(directory)
    if fd is None:
        return True
    os.close(fd)
    return False


def status(state):
    queue = Queue(state.directory)
    try:
        return {"connector_id": state.data.get("connector_id"), "daemon": "running" if running(state.directory) else "stopped",
                "ingestion_mode": state.data.get("ingestion_mode", "polling"),
                "observing": state.data.get("observing", False), "queued_events": queue.count(), "dropped_events": queue.dropped(),
                "revocation_pending": state.data.get("revocation_pending", False),
                "reconnect_required": state.data.get("reconnect_required", False), "active_sources": len(state.data.get("selections", [])),
                "retry_after_seconds": state.data.get("retry_after_seconds", 0), "delivery_state": state.data.get("delivery_state", "unknown")}
    finally:
        queue.close()


def tick(state, queue, stopping=None):
    connection = tuple(state.data.get(key) for key in ("origin", "workspace_id", "connector_id", "credential"))
    heartbeat = state.heartbeat_epoch()
    api_origin, token = state.data["origin"], state.data["credential"]
    prefix = "/connectors/" + state.data["connector_id"]
    online = True
    checked = getattr(queue, 'usage_capability_checked_at', None)
    if checked is not None and (checked == 0 or time.monotonic() - checked > 300):
        try:
            capabilities = request(api_origin, None, 'GET', '/connectors/capabilities')
            queue.polling_usage_enabled = (capabilities.get('token_usage') or {}).get('polling') is True
            queue.session_labels_enabled = capabilities.get('session_labels') is True
            queue.learning_associations_enabled = (capabilities.get('cli_learning') or {}).get('session_association') is True
        except (APIError, OSError):
            queue.polling_usage_enabled = False
            queue.session_labels_enabled = False
            queue.learning_associations_enabled = False
        queue.usage_capability_checked_at = time.monotonic()
    try:
        response = request(api_origin, token, "POST", prefix + "/heartbeat", {"dropped_events": queue.dropped()})
        if not state.accept_heartbeat(heartbeat, response, queue.retain_sources):
            return "connection_changed"
    except APIError as error:
        if error.status == 401:
            return revoked(state, connection)
        online = False
        if not retry(state, error, expected=heartbeat):
            return "connection_changed"
    except OSError:
        online = False
        if not retry(state, expected=heartbeat):
            return "connection_changed"
    if not state.data.get("observing"):
        return "observation_stopped"
    # Discovery may refresh State while another enrollment publishes. Its candidates
    # still belong to this immutable consent, never to the refreshed revision.
    epoch = state.heartbeat_epoch()
    selected = epoch["selections"]
    if stopping is not None and stopping():
        return "observation_stopped"
    candidates = observe(state, stopping=stopping)
    learning_reports = {}
    if getattr(queue, 'learning_associations_enabled', False):
        cache = {}
        for candidate in candidates:
            if stopping is not None and stopping():
                return "observation_stopped"
            learning_reports[candidate.id] = discover_learning(candidate, api_origin, cache)

    def enqueue(_latest):
        # A failed session can still have final counters since its last poll.
        # Keep reading its checkpointed tail while selected, under the same
        # 32 MiB rotating budget as the loaded sessions.
        eligible = [candidate.id for candidate in candidates if candidate.harness == 'codex' and
                    candidate.activity in {'working', 'waiting_input', 'idle', 'failed'} and getattr(candidate, 'usage_path', None)]
        cursor = getattr(queue, 'usage_cursor', 0) % max(1, len(eligible))
        selected_usage = set((eligible[cursor:] + eligible[:cursor])[:32])
        queue.usage_cursor = cursor + 32
        for candidate in candidates:
            source = next((source for source in selected if source["harness"] == candidate.harness and
                           ((source["mode"] == "session" and source["external_session_id"] == candidate.id) or
                            (source["include_future_sessions"] and (source["mode"] == "harness" or
                             (source["mode"] == "project" and source["source_id"] == candidate.project_id))))), None)
            if source:
                options = {}
                if getattr(queue, 'polling_usage_enabled', False) and candidate.id in selected_usage:
                    options['collect_usage'] = True
                if getattr(queue, 'session_labels_enabled', False):
                    options['collect_labels'] = True
                if candidate.id in learning_reports:
                    options.update(cli_learning=learning_reports[candidate.id], connector_id=epoch['connector_id'])
                queue.observe(source["source_id"], candidate, **options)

    if not state.apply_connection_epoch(epoch, enqueue):
        return "connection_changed"
    if stopping is not None and stopping():
        return "observation_stopped"
    if not online:
        return "queued"
    try:
        deadline = time.monotonic() + 10
        for _ in range(20):
            if time.monotonic() >= deadline:
                break
            events = []

            def batch(_latest):
                events.extend(queue.batch())

            if not state.apply_connection_epoch(epoch, batch):
                return "connection_changed"
            if not events:
                break
            accepted = request(api_origin, token, "POST", prefix + "/events",
                               {"selections_revision": epoch["selections_revision"], "events": events})
            sent = {event["event_id"] for event in events}
            acknowledged = sent.intersection(accepted["accepted_event_ids"])
            if not state.apply_connection_epoch(epoch, lambda _latest: queue.acknowledge(acknowledged)):
                return "connection_changed"
            if not acknowledged:
                break
        delivery = []

        def finished(_latest):
            delivery.append("queued" if queue.count() else "delivered")
            return {"retry_after_seconds": 0, "failures": 0, "delivery_state": delivery[0]}

        if not state.apply_connection_epoch(epoch, finished):
            return "connection_changed"
        return delivery[0]
    except APIError as error:
        if error.status == 401:
            return revoked(state, connection)
        if not retry(state, error, expected=epoch):
            return "connection_changed"
        return "queued"
    except OSError:
        if not retry(state, expected=epoch):
            return "connection_changed"
        return "queued"


def retry(state, error=None, expected=None):
    def failed(latest):
        failures = min(8, latest.get("failures", 0) + 1)
        delay = min(300, 30 * 2 ** (failures - 1))
        delivery = "unavailable"
        if error is not None:
            if error.status in {403, 409}:
                delivery, delay = "configuration_refresh_required", 5
            elif error.status == 429:
                delivery = "rate_limited"
            if error.retry_after is not None:
                delay = error.retry_after
        return {"failures": failures, "retry_after_seconds": delay, "delivery_state": delivery}

    return state.apply_connection_epoch(state.heartbeat_epoch() if expected is None else expected, failed)


def revoked(state, connection):
    return "reconnect_required" if state.reject_connection(connection) else "connection_changed"


def start(state, interval=30):
    if running(state.directory):
        return {"status": "already_running"}
    read_fd, write_fd = os.pipe()
    log_fd = os.open(state.directory / "daemon.log", os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    child = None
    try:
        child = subprocess.Popen([sys.executable, "-I", "-m", "agentrun_cli", "daemon", "start", "--foreground",
                                  "--state-dir", str(state.directory), "--interval", str(interval), "--ready-fd", str(write_fd)],
                                 stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, start_new_session=True,
                                 pass_fds=(write_fd,))
        os.close(write_fd)
        write_fd = None
        with selectors.DefaultSelector() as selector:
            selector.register(read_fd, selectors.EVENT_READ)
            if not selector.select(12) or os.read(read_fd, 1) != b"1":
                raise ValueError("daemon_start_failed")
        return {"status": "started"}
    finally:
        os.close(read_fd)
        os.close(log_fd)
        if write_fd is not None:
            os.close(write_fd)
        if child is not None and child.poll() is not None:
            child.wait()


def stop(state):
    if not running(state.directory):
        return {"status": "stopped"}
    deadline = time.monotonic() + 30
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(30)
            client.connect(str(state.directory / "daemon.sock"))
            client.sendall(b"stop\n")
            if client.recv(32) != b"stopped\n":
                raise ValueError("daemon_stop_failed")
    except (OSError, ValueError):
        # Disconnect first disables observation. The daemon can then exit between the
        # liveness check and this socket exchange. Its released lock is proof of stop;
        # a missing socket or failed acknowledgement alone is not.
        while running(state.directory):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(0.05, remaining))
    return {"status": "stopped"}


def run(state, once=False, interval=30, ready_fd=None):
    fd = lock(state.directory)
    if fd is None:
        return {"status": "already_running"}
    queue = None
    listener = None
    stopper = None
    socket_path = state.directory / "daemon.sock"
    try:
        # State may predate lock acquisition. Enrollment uses the same config→queue
        # order, so reload, admission and destination binding cannot straddle its save.
        with state._locked():
            state.data = state.read()
            if not state.data.get("connector_id") or not state.data.get("observing"):
                raise ValueError("not_connected")
            queue = Queue(state.directory, max_events=state.data.get("queue_limit", 1000),
                          max_bytes=state.data.get("queue_byte_limit", 1_000_000), refresh_seconds=state.data.get("refresh_seconds", 60),
                          binding=destination(state))
        queue.polling_usage_enabled = False
        queue.session_labels_enabled = False
        queue.learning_associations_enabled = False
        queue.usage_capability_checked_at = 0
        if not once:
            if socket_path.exists() and not socket_path.is_socket():
                raise ValueError("unsafe_state")
            socket_path.unlink(missing_ok=True)
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(socket_path))
            socket_path.chmod(0o600)
            listener.listen(2)
            if ready_fd is not None:
                os.write(ready_fd, b"1")
                os.close(ready_fd)
            def terminate(signum, frame):
                raise KeyboardInterrupt()
            signal.signal(signal.SIGTERM, terminate)
        while True:
            state.data = state.read()
            if not state.data.get("observing"):
                return {"status": "observation_stopped"}
            def stopping():
                return not state._read().get("observing", False) or (listener is not None and bool(select.select([listener], [], [], 0)[0]))
            result = tick(state, queue, stopping=stopping)
            if once or not state.data.get("observing"):
                return {"status": result, "queued_events": queue.count()}
            if result == "connection_changed" and not stopping():
                continue
            with selectors.DefaultSelector() as selector:
                selector.register(listener, selectors.EVENT_READ)
                delay = max(interval, state.data.get("retry_after_seconds", 0))
                if selector.select(delay * random.uniform(1.0, 1.1)):
                    client, _ = listener.accept()
                    client.settimeout(1)
                    if client.recv(32) == b"stop\n":
                        stopper = client
                        break
                    client.close()
        return {"status": "stopped"}
    finally:
        if queue is not None:
            queue.close()
        if listener is not None:
            listener.close()
            socket_path.unlink(missing_ok=True)
        os.close(fd)
        if stopper is not None:
            stopper.sendall(b"stopped\n")
            stopper.close()
