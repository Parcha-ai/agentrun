"""TEMPORARY CI diagnostic (removed before merge): why Safari's page body is blank in the demo movies' frames.

    python3 -I safari-diag.py PATH/TO/computerd COMPUTERD_HOME OUT_DIR

Opens a red page in Safari in the background, then captures it several ways (Computerd's screen.shot, the window's
own image through ui.observe, the screencapture command, whole and by window) at once, after 5 s, and after Safari is
activated, with the window list and the WebKit processes beside each. CI only.
"""

import base64
import json
import os
import subprocess
import sys
import time

if os.environ.get("GITHUB_ACTIONS") != "true":
    sys.exit("safari-diag runs on CI only")

helper, home, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
notes = open(os.path.join(out, "diag.txt"), "w")
SAFARI = "com.apple.Safari"


def say(*parts):
    line = " ".join(str(p) for p in parts)
    print("safari-diag:", line, flush=True)
    notes.write(line + "\n")
    notes.flush()


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


LIST = r"""
import CoreGraphics
import Foundation
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for (i, w) in windows.enumerated() {
	let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
	let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
	print(i, owner, "pid", w[kCGWindowOwnerPID as String] ?? "?", "wid", w[kCGWindowNumber as String] ?? "?",
		"layer", w[kCGWindowLayer as String] ?? "?", "alpha", w[kCGWindowAlpha as String] ?? "?",
		"sharing", w[kCGWindowSharingState as String] ?? "?", "name", w[kCGWindowName as String] ?? "-",
		"bounds", b["X"] ?? "?", b["Y"] ?? "?", b["Width"] ?? "?", b["Height"] ?? "?")
}
"""
lister = os.path.join(out, "list-windows.swift")
with open(lister, "w") as f:
    f.write(LIST)


def sh(argv, timeout=60):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return done.returncode, done.stdout + done.stderr
    except Exception as e:
        return -1, repr(e)


def full_bytes(c, r):
    data = base64.b64decode(r.get("data", ""))
    while not r.get("eof", True) and len(data) < r.get("size", 0):
        more = c.call("screen.read", {"id": r["id"], "offset": len(data)}).get("result") or {}
        data += base64.b64decode(more.get("data", ""))
        if more.get("eof", True):
            break
    return data


def capture(c, tag):
    say(f"--- {tag}")
    shot = c.call("screen.shot", {})
    r = shot.get("result")
    if r:
        with open(os.path.join(out, f"{tag}-screen-shot.png"), "wb") as f:
            f.write(full_bytes(c, r))
        say("screen.shot", r.get("width"), r.get("height"), r.get("scale"))
    else:
        say("screen.shot error", json.dumps(shot.get("error")))
    seen = c.call("ui.observe", {"target": {"app": SAFARI}, "image": {"maxEdge": 1600}})
    r = seen.get("result") or {}
    image = r.get("image") or {}
    if image.get("data"):
        with open(os.path.join(out, f"{tag}-window-image.{image.get('format', 'png')}"), "wb") as f:
            f.write(base64.b64decode(image["data"]))
    say("observe window", json.dumps(r.get("window")), "nodes", len(r.get("nodes", [])), "image", image.get("width"), image.get("height"), "error", json.dumps(seen.get("error")))
    texts = [n.get("name") for n in r.get("nodes", []) if n.get("role") in ("heading", "text")]
    say("texts", json.dumps(texts[:12]))
    wid = (r.get("window") or {}).get("id")
    say("screencapture full", *sh(["screencapture", "-x", os.path.join(out, f"{tag}-screencapture.png")]))
    if wid:
        say("screencapture -l", *sh(["screencapture", "-x", "-o", f"-l{wid}", os.path.join(out, f"{tag}-screencapture-window.png")]))
    say("windows\n" + sh(["swift", lister], timeout=120)[1])
    listing = sh(["/bin/ps", "-axo", "pid,ppid,stat,%cpu,etime,comm"])[1].splitlines()
    say("processes\n" + "\n".join(line for line in listing if "WebKit" in line or "Safari" in line))
    say("frontmost", *sh(["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true']))


def main():
    page = "/tmp/agentrun-safari-diag/index.html"
    os.makedirs(os.path.dirname(page), exist_ok=True)
    with open(page, "w") as f:
        f.write("<!doctype html><title>Diag page</title><body style=\"background:#c00;color:#fff;margin:0\"><h1 style=\"font-size:96px\">DIAG RED PAGE</h1><p>body text</p></body>")
    c = Client()
    try:
        say("open -g", *sh(["/usr/bin/open", "-g", "-a", "Safari", page]))
        began = time.monotonic()
        found = False
        while time.monotonic() - began < 30:
            r = c.call("ui.observe", {"target": {"app": SAFARI}}).get("result") or {}
            if any("DIAG RED PAGE" in (n.get("name") or "") for n in r.get("nodes", [])):
                found = True
                break
            time.sleep(0.5)
        say("page in the tree", found, f"after {time.monotonic() - began:.1f} s")
        capture(c, "bg0")
        time.sleep(5)
        capture(c, "bg5")
        say("activate", *sh(["/usr/bin/open", "-a", "Safari"]))
        time.sleep(3)
        capture(c, "fg3")
        say("log\n" + sh(["/bin/sh", "-c", "log show --last 4m --style compact --predicate 'process BEGINSWITH \"com.apple.WebKit\" OR process == \"Safari\"' | grep -iE 'error|fault|fail|visib|occlu|suspend|throttl|gpu|render|layer|sandbox' | tail -250"], timeout=180)[1])
    finally:
        sh(["osascript", "-e", 'tell application "Safari" to quit'])
        c.close()


main()
