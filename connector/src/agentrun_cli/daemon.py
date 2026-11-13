"""Outbound observation daemon. Source activity is independent from its heartbeat."""

import fcntl
import os
import random
import selectors
import signal
import socket
import subprocess
import sys
import time

from .adapters import observe
from .network import APIError, request
from .queue import Queue, destination


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


def tick(state, queue):
    api_origin, token = state.data["origin"], state.data["credential"]
    prefix = "/connectors/" + state.data["connector_id"]
    online = True
    try:
        response = request(api_origin, token, "POST", prefix + "/heartbeat", {"dropped_events": queue.dropped()})
        approved = state.data["approved_selections"]
        # A server may remove consent but cannot expand local consent or reuse its identity.
        selections = [source for source in response["selections"] if source in approved]
        state.data.update({"selections": selections, "selections_revision": response["selections_revision"]})
        state.save()
        queue.retain_sources({source["source_id"] for source in selections})
    except APIError as error:
        if error.status == 401:
            return revoked(state)
        online = False
        retry(state, error)
    except OSError:
        online = False
        retry(state)
    if not state.data.get("observing"):
        return "observation_stopped"
    selected = state.data["selections"]
    for candidate in observe(state):
        source = next((source for source in selected if source["harness"] == candidate.harness and
                       ((source["mode"] == "session" and source["external_session_id"] == candidate.id) or
                        (source["include_future_sessions"] and (source["mode"] == "harness" or
                         (source["mode"] == "project" and source["source_id"] == candidate.project_id))))), None)
        if source:
            queue.observe(source["source_id"], candidate)
    if not state.data.get("observing"):
        return "observation_stopped"
    if not online:
        return "queued"
    try:
        deadline = time.monotonic() + 10
        for _ in range(20):
            if time.monotonic() >= deadline:
                break
            events = queue.batch()
            if not events:
                break
            accepted = request(api_origin, token, "POST", prefix + "/events",
                               {"selections_revision": state.data["selections_revision"], "events": events})
            sent = {event["event_id"] for event in events}
            acknowledged = sent.intersection(accepted["accepted_event_ids"])
            if not acknowledged:
                break
            queue.acknowledge(acknowledged)
        delivery = "queued" if queue.count() else "delivered"
        state.data.update(retry_after_seconds=0, failures=0, delivery_state=delivery)
        state.save()
        return delivery
    except APIError as error:
        if error.status == 401:
            return revoked(state)
        retry(state, error)
        return "queued"
    except OSError:
        retry(state)
        return "queued"


def retry(state, error=None):
    failures = min(8, state.data.get("failures", 0) + 1)
    delay = min(300, 30 * 2 ** (failures - 1))
    delivery = "unavailable"
    if error is not None:
        if error.status in {403, 409}:
            delivery, delay = "configuration_refresh_required", 5
        elif error.status == 429:
            delivery = "rate_limited"
        if error.retry_after is not None:
            delay = error.retry_after
    state.data.update(failures=failures, retry_after_seconds=delay, delivery_state=delivery)
    state.save()


def revoked(state):
    state.data.update(observing=False, reconnect_required=True)
    state.data.pop("credential", None)
    state.save()
    return "reconnect_required"


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
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(30)
        client.connect(str(state.directory / "daemon.sock"))
        client.sendall(b"stop\n")
        if client.recv(32) != b"stopped\n":
            raise ValueError("daemon_stop_failed")
    return {"status": "stopped"}


def run(state, once=False, interval=30, ready_fd=None):
    if not state.data.get("connector_id") or not state.data.get("observing"):
        raise ValueError("not_connected")
    fd = lock(state.directory)
    if fd is None:
        return {"status": "already_running"}
    queue = Queue(state.directory, max_events=state.data.get("queue_limit", 1000),
                  max_bytes=state.data.get("queue_byte_limit", 1_000_000), refresh_seconds=state.data.get("refresh_seconds", 60),
                  binding=destination(state))
    listener = None
    stopper = None
    socket_path = state.directory / "daemon.sock"
    try:
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
            result = tick(state, queue)
            if once or not state.data.get("observing"):
                return {"status": result, "queued_events": queue.count()}
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
        queue.close()
        if listener is not None:
            listener.close()
            socket_path.unlink(missing_ok=True)
        os.close(fd)
        if stopper is not None:
            stopper.sendall(b"stopped\n")
            stopper.close()
