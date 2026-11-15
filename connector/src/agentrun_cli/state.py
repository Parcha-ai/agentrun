"""Private local installation identity and explicit source mappings."""

import json
import os
from pathlib import Path
import stat
import copy
import fcntl
from uuid import uuid4
from contextlib import contextmanager


def heartbeat_epoch(data):
    return {key: copy.deepcopy(data.get(key)) for key in (
        "origin", "workspace_id", "connector_id", "credential", "selections_revision",
        "approved_selections", "selections", "observing",
    )}


class State:
    def __init__(self, directory):
        self.directory = Path(directory).expanduser().absolute()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.is_symlink() or self.directory.resolve() != self.directory:
            raise ValueError("unsafe_state")
        info = self.directory.stat()
        if info.st_uid != os.getuid():
            raise ValueError("unsafe_state")
        self.directory.chmod(0o700)
        self.path = self.directory / "config.json"
        with self._locked():
            if self.path.is_symlink():
                raise ValueError("unsafe_state")
            if self.path.exists():
                self.data = self._read()
            else:
                self.data = {"installation_id": str(uuid4()), "identities": {}, "projects": {}}
                self._save()
        self.baseline = copy.deepcopy(self.data)

    def read(self):
        value = self._read()
        self.baseline = copy.deepcopy(value)
        return value

    def _read(self):
        fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 2_000_000:
                raise ValueError("unsafe_state")
            value = json.load(handle)
            if not isinstance(value, dict) or not isinstance(value.get("installation_id"), str) or any(
                not isinstance(value.get(name), dict) or not all(isinstance(key, str) and isinstance(item, str) for key, item in value[name].items())
                for name in ("identities", "projects")
            ):
                raise ValueError("unsafe_state")
            return value

    @contextmanager
    def _locked(self, name="config.lock"):
        fd = os.open(self.directory / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    @contextmanager
    def connection(self):
        # Remote enrollment/rotation and its final save are one lifecycle. Keep its lock separate:
        # daemon stop and metadata writers must still acquire the short config lock while it waits.
        # A caller may have constructed State before waiting, so reload after acquiring ownership.
        with self._locked("connection.lock"):
            self.data = self.read()
            yield

    def save(self):
        with self._locked():
            latest = self._read()
            canonical = {"installation_id", "identities", "projects"}
            latest.update({key: value for key, value in self.data.items() if key not in canonical and (key not in self.baseline or value != self.baseline[key])})
            for removed in self.baseline.keys() - self.data.keys() - canonical:
                latest.pop(removed, None)
            self.data = latest
            self._save()
            self.baseline = copy.deepcopy(self.data)

    def reject_connection(self, expected):
        # A response belongs to the connection that sent it. Re-read and compare while holding
        # the short write lock so a late response cannot erase a newer enrollment's state.
        with self._locked():
            latest = self._read()
            matched = tuple(latest.get(key) for key in ("origin", "workspace_id", "connector_id", "credential")) == expected
            if matched:
                latest.update(observing=False, reconnect_required=True)
                latest.pop("credential", None)
                self._save(latest)
            self.data = latest
            self.baseline = copy.deepcopy(latest)
            return matched

    def heartbeat_epoch(self):
        return heartbeat_epoch(self.data)

    def apply_connection_epoch(self, expected, action):
        # Harness and HTTP work happens outside this lock. Its results may mutate the
        # queue or delivery metadata only while the original consent still owns it.
        with self._locked():
            latest = self._read()
            matched = heartbeat_epoch(latest) == expected
            if matched:
                updates = action(latest)
                if updates:
                    latest.update(updates)
                    self._save(latest)
            self.data = latest
            self.baseline = copy.deepcopy(latest)
            return matched

    def accept_heartbeat(self, expected, response, retain_sources):
        # Settlement and its queue pruning share the same short lock as enrollment
        # publication. A late response can neither rewrite nor prune a newer epoch.
        with self._locked():
            latest = self._read()
            matched = heartbeat_epoch(latest) == expected
            if matched:
                approved = latest["approved_selections"]
                selections = [source for source in response["selections"] if source in approved]
                retain_sources({source["source_id"] for source in selections})
                latest.update(selections=selections, selections_revision=response["selections_revision"])
                self._save(latest)
            self.data = latest
            self.baseline = copy.deepcopy(latest)
            return matched

    def complete_connection(self, connection, before_save=None):
        # The caller owns connection.lock. Set the completed enrollment's explicit fields
        # over current metadata, even when an old worker stopped observation during the request.
        with self._locked():
            latest = self._read()
            if before_save is not None:
                before_save(latest)
            latest.update(connection)
            latest.pop("pending_registration", None)
            self._save(latest)
            self.data = latest
            self.baseline = copy.deepcopy(latest)

    def _save(self, value=None):
        temporary = self.directory / (".config-" + str(uuid4()))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(self.data if value is None else value, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

    def _allocate(self, collection, key):
        # Persist before returning: a caller can immediately enroll this opaque ID while another discovery runs.
        with self._locked():
            latest = self._read()
            mapping = latest[collection]
            if key not in mapping:
                if len(mapping) >= 4096:
                    raise ValueError("candidate_limit")
                mapping[key] = str(uuid4())
                self._save(latest)
            self.data["installation_id"] = latest["installation_id"]
            self.data[collection] = copy.deepcopy(mapping)
            self.baseline[collection] = copy.deepcopy(mapping)
            return mapping[key]

    def identity(self, harness, native_id):
        return self._allocate("identities", harness + ":" + native_id)

    def project(self, harness, cwd):
        return self._allocate("projects", harness + ":" + cwd)
