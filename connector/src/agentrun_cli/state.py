"""Private local installation identity and explicit source mappings."""

import json
import os
from pathlib import Path
import stat
import copy
import fcntl
from uuid import uuid4
from contextlib import contextmanager


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
    def _locked(self):
        fd = os.open(self.directory / "config.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

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
