"""Private descriptor broker for source capture on hosts without procfs. No network or source code execution."""
import base64
import errno
import json
import os
import selectors
import stat
import subprocess
import sys
import time

handles = {}


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def opened(path, roots):
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise Refused("source_unavailable")
    expected = {root["path"]: root for root in roots}
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    current = "/"
    try:
        for component in [None, *path.split("/")[1:]]:
            if component:
                current = os.path.join(current, component)
                try:
                    next_fd = os.open(component, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_DIRECTORY if current != path else 0), dir_fd=fd)
                except OSError:
                    if any(root["path"] == current or root["path"].startswith(current + "/") for root in roots):
                        raise Refused("source_changed")
                    raise
                os.close(fd)
                fd = next_fd
            if current in expected:
                info, root = os.fstat(fd), expected[current]
                if not stat.S_ISDIR(info.st_mode) or str(info.st_dev) != root["device"] or str(info.st_ino) != root["inode"]:
                    raise Refused("source_changed")
        handles[fd] = fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def git(request, fd):
    # The worktree is a held descriptor. No path lookup occurs after it is handed to the child.
    limit = request["max"]
    if not isinstance(limit, int) or limit < 1 or limit > 64 * 1024 * 1024:
        raise Refused("limit")
    child = subprocess.Popen(["git", *request["args"]], env=request["env"], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, pass_fds=(fd,),
                             preexec_fn=lambda: os.fchdir(fd))
    deadline = time.monotonic() + request["timeout"] / 1000
    chunks, size = [], 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                left = deadline - time.monotonic()
                if left <= 0 or not selector.select(left):
                    raise Refused("limit")
                chunk = os.read(child.stdout.fileno(), min(65536, limit + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise Refused("limit")
                chunks.append(chunk)
        if child.wait(timeout=max(0.001, deadline - time.monotonic())):
            raise Refused("source_unavailable")
        return base64.b64encode(b"".join(chunks)).decode("ascii")
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()


def dispatch(request):
    op = request["op"]
    if op == "open":
        return opened(request["path"], request["roots"])
    fd = handles[request["fd"]]
    if op == "close":
        del handles[fd]
        os.close(fd)
        return None
    if op == "stat":
        info = os.fstat(fd)
        return {"dev": str(info.st_dev), "ino": str(info.st_ino), "size": info.st_size,
                "mode": info.st_mode, "nlink": info.st_nlink, "mtimeMs": info.st_mtime_ns / 1_000_000,
                "ctimeMs": info.st_ctime_ns / 1_000_000, "file": stat.S_ISREG(info.st_mode),
                "directory": stat.S_ISDIR(info.st_mode)}
    if op == "read":
        length, position = request["length"], request["position"]
        if not stat.S_ISREG(os.fstat(fd).st_mode) or not 0 <= length <= 64 * 1024 * 1024 + 1 or position < 0:
            raise Refused("source_unavailable")
        return base64.b64encode(os.pread(fd, length, position)).decode("ascii")
    if op == "names":
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise Refused("source_unavailable")
        names = []
        with os.scandir(fd) as entries:
            for entry in entries:
                names.append(entry.name)
                if len(names) > request["max"]:
                    raise Refused("limit")
        return names
    if op == "git":
        return git(request, fd)
    raise Refused("source_unavailable")


try:
    while True:
        line = sys.stdin.buffer.readline(1024 * 1024 + 1)
        if not line:
            break
        if len(line) > 1024 * 1024:
            break
        request = json.loads(line)
        try:
            response = {"id": request["id"], "value": dispatch(request)}
        except Refused as error:
            response = {"id": request["id"], "error": error.code}
        except OSError as error:
            response = {"id": request["id"], "error": errno.errorcode.get(error.errno, "source_unavailable")}
        except Exception:
            response = {"id": request["id"], "error": "source_unavailable"}
        sys.stdout.write(json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()
finally:
    for fd in handles:
        os.close(fd)
