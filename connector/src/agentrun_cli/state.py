"""Private local installation identity and explicit source mappings."""

import json
import os
from pathlib import Path
import stat
import copy
import fcntl
from uuid import uuid4


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
        self.data = self.read() if self.path.exists() else {"installation_id": str(uuid4()), "identities": {}, "projects": {}}
        self.baseline = copy.deepcopy(self.data) if self.path.exists() else {}

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
            return json.load(handle)

    def save(self):
        fd = os.open(self.directory / "config.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            latest = self._read() if self.path.exists() else {}
            latest.update({key: value for key, value in self.data.items() if key not in self.baseline or value != self.baseline[key]})
            for removed in self.baseline.keys() - self.data.keys():
                latest.pop(removed, None)
            self.data = latest
            self._save()
            self.baseline = copy.deepcopy(self.data)
        finally:
            os.close(fd)

    def _save(self):
        temporary = self.directory / (".config-" + str(uuid4()))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(self.data, handle)
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

    def identity(self, harness, native_id):
        key = harness + ":" + native_id
        if key not in self.data["identities"] and len(self.data["identities"]) >= 4096:
            raise ValueError("candidate_limit")
        return self.data["identities"].setdefault(key, str(uuid4()))

    def project(self, harness, cwd):
        key = harness + ":" + cwd
        if key not in self.data["projects"] and len(self.data["projects"]) >= 4096:
            raise ValueError("candidate_limit")
        return self.data["projects"].setdefault(key, str(uuid4()))
