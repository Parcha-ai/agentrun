"""CI smoke test of a running Computerd.app, through its own computerd command (the stdio binding over the app's socket).

    python3 -I smoke.py PATH/TO/computerd COMPUTERD_HOME

The core checks must pass: hello, ping, exec, files, apps, the socket's peer check, and each grant-bound method either
working or refused in words that name the grant. With the grants in place (seed-tcc.sh), it also drives TextEdit in the
background: open a document without bringing it forward, observe it, type into it, and expect the text. Then the ui
fixture (UIFixture.app, when installed): its elements, an expect, and its canvas, which only foreground input reaches.
Those live results are reported, and fail the run only with SMOKE_STRICT_LIVE=1. A summary goes to $GITHUB_STEP_SUMMARY.
"""

import base64
import json
import os
import socket
import subprocess
import sys
import time

helper, home = sys.argv[1], sys.argv[2]
results = []  # (group, name, ok, detail)


def record(group, name, ok, detail=""):
    results.append((group, name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} [{group}] {name}: {detail}", flush=True)


class Client:
    def __init__(self):
        env = dict(os.environ, COMPUTERD_HOME=home)
        self.p = subprocess.Popen([helper, "stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.next = 0

    def call(self, method, params=None):
        self.next += 1
        message = {"jsonrpc": "2.0", "id": self.next, "method": method}
        if params is not None:
            message["params"] = params
        self.p.stdin.write((json.dumps(message) + "\n").encode())
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"{method}: the connection closed")
            reply = json.loads(line)
            if reply.get("id") == self.next:
                return reply

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def kind(reply):
    return ((reply.get("error") or {}).get("data") or {}).get("kind")


def wait_for_socket():
    path = os.path.join(home, "computerd.sock")
    for _ in range(100):
        if os.path.exists(path):
            return path
        time.sleep(0.1)
    raise RuntimeError(f"no socket at {path} after 10 s")


def core(c):
    hello = c.call("hello", {"client": "smoke"})
    h = hello.get("result") or {}
    record("core", "hello", h.get("os") == "macos" and h.get("protocol") == "0.2", json.dumps(h.get("features")))
    record("core", "hello.device and osVersion", (h.get("device") or {}).get("maker") == "Apple" and "(" in (h.get("osVersion") or ""), f"{h.get('device')} {h.get('osVersion')}")
    names = {"apps.background", "ui.tree", "ui.image", "ui.background", "ui.foreground", "ui.page", "ui.nav"}
    features = h.get("features") or {}
    record("core", "hello.features names the seven", set(features) == names, ", ".join(sorted(features)))
    vague = [n for n, f in features.items() if f is not True and len((f or {}).get("off", "")) < 20]
    record("core", "every feature off says why", not vague, ", ".join(vague))
    record("core", "hello.screen", bool(h.get("screen")), json.dumps(h.get("screen")))
    record("core", "ping", c.call("ping").get("result") == {})

    run = c.call("exec.run", {"argv": ["/bin/echo", "hi"], "timeoutMs": 5000}).get("result") or {}
    record("core", "exec.run", run.get("exitCode") == 0 and base64.b64decode(run.get("stdout", "")) == b"hi\n", json.dumps(run))

    path = os.path.join(home, "smoke-file.txt")
    wrote = c.call("files.write", {"path": path, "data": base64.b64encode(b"computerd").decode()})
    read = c.call("files.read", {"path": path}).get("result") or {}
    record("core", "files.write and files.read", "result" in wrote and base64.b64decode(read.get("data", "")) == b"computerd", json.dumps(read))

    apps = c.call("apps.list").get("result") or {}
    ids = [a["id"] for a in apps.get("apps", [])]
    record("core", "apps.list has the Finder (running) and TextEdit (installed)", "com.apple.finder" in ids and "com.apple.TextEdit" in ids, f"{len(ids)} apps, front {apps.get('foreground')}")
    return features


def grant_bound(c, features):
    shot = c.call("screen.shot", {})
    if features.get("ui.image") is True:
        r = shot.get("result") or {}
        record("grants", "screen.shot with Screen Recording", r.get("width", 0) > 0, f"{r.get('width')}x{r.get('height')}, {r.get('size')} bytes")
    else:
        message = (shot.get("error") or {}).get("message", "")
        record("grants", "screen.shot refused without Screen Recording", kind(shot) == "denied" and "Screen Recording" in message, message)

    observe = c.call("ui.observe", {"target": {"app": "com.apple.finder"}})
    message = (observe.get("error") or {}).get("message", "")
    r = observe.get("result") or {}
    tree, image = features.get("ui.tree") is True, features.get("ui.image") is True
    if tree:
        record("grants", "ui.observe with the tree (or not_found: the Finder has no window)", "result" in observe or kind(observe) == "not_found", message or f"{len(r.get('nodes', []))} nodes")
    elif image:
        ok = kind(observe) == "not_found" or (r.get("nodes") == [] and "ui.tree is off" in (r.get("empty") or "") and bool(r.get("image")))
        record("grants", "ui.observe without the tree: no nodes, why, and the image", ok, message or f"empty: {r.get('empty')}")
    else:
        ok = kind(observe) == "denied" and "Accessibility" in message and "Screen Recording" in message
        record("grants", "ui.observe refused without the tree and the image, naming both", ok, message)
    return tree


def live(c):
    doc = os.path.join(home, "smoke.txt")
    with open(doc, "w") as f:
        f.write("")
    launch = c.call("apps.launch", {"id": "com.apple.TextEdit", "url": "file://" + doc, "background": True})
    record("live", "apps.launch TextEdit in the background", "result" in launch, json.dumps(launch.get("error")))
    front = (c.call("apps.list").get("result") or {}).get("foreground")
    record("live", "TextEdit stayed behind", front != "com.apple.TextEdit", f"front is {front}")

    observed = None
    for _ in range(20):
        reply = c.call("ui.observe", {"target": {"app": "com.apple.TextEdit"}, "image": True})
        if "result" in reply and any(n["role"] == "textbox" for n in reply["result"]["nodes"]):
            observed = reply["result"]
            break
        time.sleep(0.5)
    if observed is None:
        record("live", "ui.observe TextEdit's document", False, json.dumps(reply.get("error") or reply.get("result", {}).get("nodes", [])[:5]))
        return
    box = next(n for n in observed["nodes"] if n["role"] == "textbox")
    image = observed.get("image") or {}
    record("live", "ui.observe TextEdit's document", True, f"{len(observed['nodes'])} nodes, window {observed['window']['id']}, image {image.get('format')} {image.get('width')}x{image.get('height')}")

    act = c.call("ui.act", {
        "target": {"app": "com.apple.TextEdit", "window": observed["window"]["id"]},
        "state": observed["state"],
        "steps": [{"type": "hello from computerd", "into": box["ref"]}],
        "expect": {"text": "hello from computerd", "timeoutMs": 5000},
    })
    r = act.get("result") or {}
    step = (r.get("steps") or [{}])[0]
    record("live", "ui.act type into the document", r.get("expect") == "met" and "route" in step, json.dumps(act.get("error") or r.get("steps")) + f" expect {r.get('expect')}")

    key = c.call("ui.act", {"target": {"app": "com.apple.TextEdit", "window": observed["window"]["id"]}, "steps": [{"key": "super+a"}]})
    ks = ((key.get("result") or {}).get("steps") or [{}])[0]
    record("live", "ui.act super+a (the menu item, in the background)", "route" in ks, json.dumps(key.get("error") or ks))
    front = (c.call("apps.list").get("result") or {}).get("foreground")
    record("live", "TextEdit still behind after acting", front != "com.apple.TextEdit", f"front is {front}")
    c.call("apps.terminate", {"id": "com.apple.TextEdit"})


FIXTURE = "ai.agentrun.ui-fixture"


def fixture(c):
    """The ui fixture (UIFixture.app, CI installs it), checked the way the ui conformance cases read it."""
    ids = [a["id"] for a in (c.call("apps.list").get("result") or {}).get("apps", [])]
    if FIXTURE not in ids:
        record("fixture", f"skipped: {FIXTURE} is not installed", True)
        return
    c.call("apps.terminate", {"id": FIXTURE})
    launch = c.call("apps.launch", {"id": FIXTURE})
    record("fixture", "apps.launch the ui fixture", "result" in launch, json.dumps(launch.get("error")))
    seen = None
    for _ in range(20):
        reply = c.call("ui.observe", {"target": {"app": FIXTURE}})
        r = reply.get("result") or {}
        if any(n.get("id") == "next" for n in r.get("nodes", [])):
            seen = r
            break
        time.sleep(0.5)
    if seen is None:
        record("fixture", "ui.observe the fixture's home", False, json.dumps(reply.get("error") or reply.get("result", {}).get("nodes", [])[:8]))
        return
    by = {n["id"]: n for n in seen["nodes"] if n.get("id")}
    shape = {k: (by.get(k) or {}).get("role") for k in ["name", "wifi", "save", "next", "canvas"]}
    want = {"name": "textbox", "wifi": "switch", "save": "button", "next": "button", "canvas": "image"}
    record("fixture", "the fixture's elements, by id and role", shape == want, json.dumps(shape))
    size = seen["window"]["bounds"][2:]
    record("fixture", "the window is 480 by 320 points", size == [480, 320], json.dumps(seen["window"]))
    record("fixture", "Wi-Fi's desc", (by.get("wifi") or {}).get("desc") == "Networks nearby", json.dumps(by.get("wifi")))
    record("fixture", "the canvas's count starts at 0", (by.get("canvas") or {}).get("value") == "0", json.dumps(by.get("canvas")))
    if shape != want:
        return

    saved = c.call("ui.act", {"target": {"app": FIXTURE}, "steps": [{"press": by["save"]["ref"]}], "expect": {"text": "Saved", "timeoutMs": 3000}})
    r = saved.get("result") or {}
    record("fixture", "press Save, expect Saved", r.get("expect") == "met", json.dumps(saved.get("error") or r.get("steps")) + f" expect {r.get('expect')}")

    def count():
        nodes = (c.call("ui.observe", {"target": {"app": FIXTURE}}).get("result") or {}).get("nodes", [])
        return next((n.get("value") for n in nodes if n.get("id") == "canvas"), None)

    before = count()
    posted = c.call("ui.act", {"target": {"app": FIXTURE}, "steps": [{"click": by["canvas"]["ref"]}]})
    step = ((posted.get("result") or {}).get("steps") or [{}])[0]
    after = count()
    if "error" in step:
        ok = step["error"].get("kind") in ("denied", "unsupported")
    else:
        ok = step.get("route") != "foreground" and (not step.get("verified") or after != before)
    record("fixture", "a canvas click without foreground: refused, or never verified unless it landed", ok, f"{json.dumps(posted.get('error') or step)} count {before} -> {after}")

    allowed = c.call("ui.act", {"target": {"app": FIXTURE}, "steps": [{"click": by["canvas"]["ref"]}], "foreground": True})
    step = ((allowed.get("result") or {}).get("steps") or [{}])[0]
    final = count()
    landed = after is not None and final is not None and int(final) == int(after) + 1
    record("fixture", "a canvas click with foreground: true lands and verifies", landed and step.get("verified") is True, f"{json.dumps(allowed.get('error') or step)} count {after} -> {final}")
    c.call("apps.terminate", {"id": FIXTURE})


def peer_check():
    path = wait_for_socket()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(path)
    s.sendall(b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    data = b""
    try:
        while not data.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    s.close()
    record("core", "the socket refuses a client not signed as Computerd", b"refused this client" in data, data.decode(errors="replace").strip())


def main():
    wait_for_socket()
    c = Client()
    try:
        features = core(c)
        if grant_bound(c, features):
            live(c)
            fixture(c)
        else:
            record("live", "skipped: ui.tree is off (Accessibility is not granted)", True)
    finally:
        c.close()
    peer_check()

    lines = ["| | Group | Check | Detail |", "| --- | --- | --- | --- |"]
    for group, name, ok, detail in results:
        lines.append(f"| {'✅' if ok else '❌'} | {group} | {name} | {detail[:300].replace('|', '/')} |")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("### Computerd smoke\n\n" + "\n".join(lines) + "\n")
    strict_live = os.environ.get("SMOKE_STRICT_LIVE") == "1"
    failed = [r for r in results if not r[2] and (r[0] not in ("live", "fixture") or strict_live)]
    print(f"{len(results) - len([r for r in results if not r[2]])} of {len(results)} checks passed")
    sys.exit(1 if failed else 0)


main()
