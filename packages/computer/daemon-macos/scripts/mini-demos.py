"""The Mac mini's five demo tasks (MINI.md), on Notes, Safari, Finder, TextEdit and Calendar. Each is driven through
the running Computerd's own computerd command by ui.observe and ui.act with batched steps. Each is recorded from
screen.watch to a movie with the step on screen. Each call's latency is logged.

    python3 -I mini-demos.py PATH/TO/computerd COMPUTERD_HOME OUT_DIR [--keep] [--no-movie] [TASK ...]

TASK is a task's id (mac.notes.new-note, ...); none runs all five. --keep leaves what a task made (a note, an event)
instead of deleting it. --no-movie keeps the frames and skips the movie. Writes, under OUT_DIR:

    demos.json             every task's calls: method, params, ms, the steps' routes, the expect, the error
    demos.md               the table: task, calls, steps, ms, result
    <task>.mp4             the task's movie, its current step written along the bottom (frames-to-movie.swift)
    <task>/frames/         the frames, as screen.watch gave them, and timeline.txt
    <task>/observe-N.json  each observation's nodes, for when a step finds nothing

The ids are the computer bench's mac-dev ids (packages/computer-bench/suites/mac-dev), and each task checks what the
bench's task checks, read here through ui.observe or the file system rather than AppleScript, so a Mac with no
Automation grant runs them. The exit code is 1 when a task fails.
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}
if len(args) < 3:
    sys.exit(__doc__)
helper, home, out = args[0], args[1], os.path.abspath(args[2])
only = set(args[3:])
keep = "--keep" in flags
movie = "--no-movie" not in flags
here = os.path.dirname(os.path.abspath(__file__))


class Client:
    """One connection: the stdio binding through the app's computerd command. One caller at a time."""

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


class Recorder(threading.Thread):
    """The live view, from screen.watch on a connection of its own, each frame stamped with the run's clock."""

    def __init__(self, folder, clock):
        super().__init__(daemon=True)
        self.folder, self.clock = folder, clock
        self.frames, self.captions, self.errors = [], [], []
        self.halt = threading.Event()
        os.makedirs(folder, exist_ok=True)

    def caption(self, text):
        self.captions.append((self.clock(), text))

    def run(self):
        c = Client()
        seq = 0
        try:
            while not self.halt.is_set():
                reply = c.call("screen.watch", {"after": seq, "waitMs": 250, "maxWidth": 1280, "quality": 70})
                r = reply.get("result")
                if r is None:
                    self.errors.append(json.dumps(reply.get("error")))
                    time.sleep(0.5)
                    continue
                if not r.get("changed"):
                    continue
                at = self.clock()
                data = base64.b64decode(r.get("data", ""))
                while not r.get("eof", True) and len(data) < r.get("size", 0):
                    more = c.call("screen.read", {"id": r["id"], "offset": len(data)}).get("result") or {}
                    data += base64.b64decode(more.get("data", ""))
                    if more.get("eof", True):
                        break
                seq = r["seq"]
                path = os.path.join(self.folder, f"{len(self.frames):05d}.jpg")
                with open(path, "wb") as f:
                    f.write(data)
                self.frames.append((at, path))
        except Exception as e:  # the movie is a record, not a check: a dead recorder never fails the task
            self.errors.append(repr(e))
        finally:
            c.close()

    def finish(self):
        self.halt.set()
        self.join(timeout=5)
        end = self.clock()
        with open(os.path.join(self.folder, "timeline.txt"), "w") as f:
            for at, path in self.frames:
                f.write(f"frame {at:.3f} {path}\n")
            for at, text in self.captions:
                f.write(f"caption {at:.3f} {text}\n")
            f.write(f"end {end:.3f}\n")
        return os.path.join(self.folder, "timeline.txt")


class Failed(Exception):
    pass


class Task:
    """One run of one task: its calls, timed, its observations, and its movie's captions."""

    def __init__(self, c, tid, app):
        self.c, self.id, self.app = c, tid, app
        self.nonce = uuid.uuid4().hex[:6]
        self.calls, self.notes = [], []
        self.observed = 0
        self.folder = os.path.join(out, tid)
        self.t0 = time.monotonic()
        self.rec = Recorder(os.path.join(self.folder, "frames"), lambda: time.monotonic() - self.t0) if movie else None

    def say(self, text):
        print(f"  {self.id}: {text}", flush=True)
        if self.rec:
            self.rec.caption(text)

    def call(self, method, params, label):
        start = time.monotonic()
        reply = self.c.call(method, params)
        ms = round((time.monotonic() - start) * 1000)
        r = reply.get("result") or {}
        entry = {"label": label, "method": method, "ms": ms, "params": params}
        if "error" in reply:
            entry["error"] = reply["error"]
        if method == "ui.act":
            entry["steps"] = r.get("steps")
            entry["expect"] = r.get("expect")
            entry["changed"] = r.get("changed")
        if method == "ui.observe":
            entry["nodes"] = len(r.get("nodes", []))
        self.calls.append(entry)
        # A route, with " unverified" when no readback saw the step's effect; or the refusal's kind.
        routes = ", ".join(
            (s["route"] + ("" if s.get("verified") else " unverified")) if "route" in s else (s.get("error") or {}).get("kind", "?")
            for s in r.get("steps") or []
        )
        tail = f" [{routes}]" if routes else ""
        if "expect" in entry and entry["expect"]:
            tail += f" expect {entry['expect']}"
        print(f"    {method} {label}: {ms} ms{tail}" + (f" ERROR {json.dumps(reply['error'])}" if "error" in reply else ""), flush=True)
        return reply

    def observe(self, label="observe", **extra):
        params = {"target": {"app": self.app}}
        params.update(extra)
        # An app just opened may swap its first window for another (Notes does): not_found is asked again, for 10 s.
        deadline = time.monotonic() + 10
        while True:
            reply = self.call("ui.observe", params, label)
            if (reply.get("error") or {}).get("data", {}).get("kind") != "not_found" or time.monotonic() > deadline:
                break
            time.sleep(0.5)
        if "error" in reply:
            raise Failed(f"ui.observe {self.app}: {reply['error'].get('message')}")
        r = reply["result"]
        self.observed += 1
        path = os.path.join(self.folder, f"observe-{self.observed}.json")
        with open(path, "w") as f:
            json.dump({k: v for k, v in r.items() if k != "image"}, f, indent=1)
        return r

    def act(self, steps, label, expect=None, state=None, foreground=False, must=True):
        """One ui.act call: the steps in one batch, then the expect polled on the Mac. Fails the task on a refused step
        or an unmet expect, with the step and the words; with must=False, answers None instead, for a way the task
        tries before another."""
        if not must:
            try:
                return self.act(steps, label, expect, state, foreground)
            except Failed as e:
                print(f"    (tried, and it did not do it: {e})", flush=True)
                return None
        params = {"target": {"app": self.app}, "steps": steps}
        if expect is not None:
            params["expect"] = expect
        if state is not None:
            params["state"] = state
        if foreground:
            params["foreground"] = True
        self.say(label)
        reply = self.call("ui.act", params, label)
        if "error" in reply:
            raise Failed(f"{label}: {reply['error'].get('message')}")
        r = reply["result"]
        for i, s in enumerate(r.get("steps") or []):
            if "error" in s:
                raise Failed(f"{label}: step {i + 1} {json.dumps(steps[i])} refused {s['error']['kind']}: {s['error']['message']}")
        if expect is not None and r.get("expect") != "met":
            raise Failed(f"{label}: the expect {json.dumps(expect)} was {r.get('expect')}")
        return r

    def close(self, label):
        """super+w on the task's window, as teardown. Closing the act's own window leaves no window to settle on, which
        the driver answers not_found: the window is then gone, as asked."""
        self.say(label)
        reply = self.call("ui.act", {"target": {"app": self.app}, "steps": [{"key": "super+w"}]}, label)
        kind = (reply.get("error") or {}).get("data", {}).get("kind")
        if kind not in (None, "not_found"):
            raise Failed(f"{label}: {reply['error'].get('message')}")

    def dump(self):
        """The window's nodes, printed, for a failed task."""
        try:
            r = self.c.call("ui.observe", {"target": {"app": self.app}}).get("result") or {}
        except Exception as e:
            print(f"  (no observation: {e!r})")
            return
        print(f"  the window now ({r.get('window', {}).get('title')!r}, {len(r.get('nodes', []))} nodes):")
        for n in r.get("nodes", [])[:150]:
            print(f"    {n.get('ref')} {n.get('role')} name={n.get('name')!r} value={(n.get('value') or '')[:60]!r} id={n.get('id')!r} flags={n.get('flags')} parent={n.get('parent')}")

    def wait_for(self, text, label, seconds=20):
        """Until the app has a window that shows the text: an expect, asked again while the app has no window yet."""
        self.say(label)
        deadline = time.monotonic() + seconds
        while True:
            params = {"target": {"app": self.app}, "steps": [], "expect": {"text": text, "timeoutMs": 3000}}
            reply = self.call("ui.act", params, label)
            if (reply.get("result") or {}).get("expect") == "met":
                return
            if time.monotonic() > deadline:
                why = (reply.get("error") or {}).get("message") or f"the expect was {(reply.get('result') or {}).get('expect')}"
                raise Failed(f"{label}: no window of {self.app} showed {text!r} in {seconds} s: {why}")
            time.sleep(0.5)

    def run_exec(self, argv, label, timeout_ms=30000):
        reply = self.call("exec.run", {"argv": argv, "timeoutMs": timeout_ms}, label)
        if "error" in reply:
            raise Failed(f"{label}: {reply['error'].get('message')}")
        r = reply["result"]
        if r.get("exitCode") != 0:
            err = base64.b64decode(r.get("stderr", "")).decode(errors="replace").strip()
            raise Failed(f"{label}: exit {r.get('exitCode')}: {err}")
        return base64.b64decode(r.get("stdout", "")).decode(errors="replace")

    def write(self, path, text, label):
        reply = self.call("files.write", {"path": path, "data": base64.b64encode(text.encode()).decode()}, label)
        if "error" in reply:
            raise Failed(f"{label}: {reply['error'].get('message')}")

    def launch(self, label=None):
        reply = self.call("apps.launch", {"id": self.app, "background": True}, label or f"open {self.app} in the background")
        if "error" in reply:
            raise Failed(f"apps.launch {self.app}: {reply['error'].get('message')}")


def find(nodes, role=None, name=None, starts=None, contains=None, value=None):
    """The first node with this role whose name (or value) is, starts with, or holds the given words."""
    roles = (role,) if isinstance(role, str) else role
    for n in nodes:
        if roles is not None and n.get("role") not in roles:
            continue
        words = [n.get("name") or "", n.get("value") or ""]
        if name is not None and name not in words:
            continue
        if starts is not None and not any(w.startswith(starts) for w in words):
            continue
        if contains is not None and not any(contains in w for w in words):
            continue
        if value is not None and n.get("value") != value:
            continue
        return n
    return None


def need(task, nodes, what, **query):
    node = find(nodes, **query)
    if node is None:
        shown = [f"{n.get('role')} {n.get('name') or ''!r} {n.get('value') or ''!r}"[:90] for n in nodes[:80]]
        raise Failed(f"no {what} ({json.dumps(query)}) among {len(nodes)} nodes; first ones: " + "; ".join(shown))
    return node


# A fresh Mac's first-run sheets: pressed once, before a task starts.
FIRST_RUN = ("Continue", "Get Started", "Not Now", "Done", "OK")


def first_run(task, tree):
    for _ in range(3):
        button = next((n for n in tree["nodes"] if n.get("role") == "button" and n.get("name") in FIRST_RUN), None)
        if button is None:
            return tree
        task.act([{"press": button["ref"]}], f"dismiss the first-run sheet ({button['name']})")
        tree = task.observe("observe after the first-run sheet")
    return tree


# --- the five tasks ------------------------------------------------------------------------------------------------


def textedit_edit_number(t):
    """mac.textedit.edit-number: change one number in a text file and save it; the rest of the file stays."""
    folder = f"/tmp/computer-bench-{t.nonce}"
    path = f"{folder}/totals.txt"
    before = "Apples: 3\nPears: 41\nPlums: 7\n"
    after = "Apples: 3\nPears: 42\nPlums: 7\n"
    t.run_exec(["/bin/mkdir", "-p", folder], "make the task's folder")
    t.write(path, before, "write totals.txt")
    t.say("open totals.txt in TextEdit, in the background")
    t.run_exec(["/usr/bin/open", "-g", "-a", "TextEdit", path], "open -g -a TextEdit totals.txt")
    t.wait_for("Pears: 41", "wait for the document")
    tree = t.observe()
    text = need(t, tree["nodes"], "text area", role="textbox", contains="Pears: 41")
    t.act([{"set": text["ref"], "value": after}, {"key": "super+s"}], "set the text and save (super+s)", expect={"ref": text["ref"], "text": "Pears: 42"})
    deadline = time.monotonic() + 10
    while True:
        got = t.c.call("files.read", {"path": path}).get("result") or {}
        saved = base64.b64decode(got.get("data", "")).decode(errors="replace")
        if saved == after or time.monotonic() > deadline:
            break
        time.sleep(0.25)
    if saved != after:
        raise Failed(f"totals.txt holds {saved!r}, not {after!r}")
    t.notes.append("totals.txt saved with Pears: 42, the other lines kept")
    if not keep:
        t.close("close the document (super+w)")
        t.run_exec(["/bin/rm", "-rf", folder], "remove the task's folder")


def finder_rename_file(t):
    """mac.finder.rename-file: rename one file in a Finder window; the other file stays."""
    folder = f"/tmp/computer-bench-{t.nonce}"
    t.run_exec(["/bin/mkdir", "-p", folder], "make the task's folder")
    t.write(f"{folder}/draft.txt", "the draft\n", "write draft.txt")
    t.write(f"{folder}/other.txt", "another file\n", "write other.txt")
    t.say("open the folder in Finder, in the background")
    t.run_exec(["/usr/bin/open", "-g", folder], "open -g the folder")
    t.wait_for("draft", "wait for the folder's window")
    tree = t.observe()
    # By element, never by point: the window may sit under other apps' windows on a real desktop. As a list, each
    # file is a row whose name is a text field Accessibility reaches.
    as_list = find(tree["nodes"], role="radio", name="list view")
    if as_list is not None and "checked" not in (as_list.get("flags") or []):
        t.act([{"press": as_list["ref"]}], "show the folder as a list", expect={"text": "draft.txt", "timeoutMs": 5000})
        tree = t.observe("observe the list")
    item = need(t, tree["nodes"], "draft.txt in the window", name="draft.txt")
    t.act([{"click": item["ref"]}], "select draft.txt")

    want = ["final.txt", "other.txt"]

    def listing(seconds=0):
        """The folder's names, asked again for a few seconds until they are the ones wanted."""
        deadline = time.monotonic() + seconds
        while True:
            listed = (t.c.call("files.list", {"path": folder}).get("result") or {}).get("entries", [])
            got = sorted(os.path.basename(e.get("path") or "") for e in listed)
            if got == want or time.monotonic() >= deadline:
                return got
            time.sleep(0.25)

    field = find(tree["nodes"], role="textbox", value="draft.txt")
    done = False
    if field is not None:
        set_it = t.act([{"set": field["ref"], "value": "final.txt"}], "set its name field to final.txt", expect={"text": "final.txt", "timeoutMs": 5000}, must=False)
        done = set_it is not None and listing(3) == want
        if set_it is not None and not done:
            print("    (the name field took the text, but Finder did not rename the file)", flush=True)
    if not done:
        # Enter on the selected file edits its name with the name before .txt selected: typing replaces that.
        t.act([{"key": "enter"}, {"type": "final"}, {"key": "enter"}], "rename it: enter, type final, enter", expect={"text": "final.txt", "timeoutMs": 10000})
    names = listing(5)
    if names != want:
        raise Failed(f"the folder holds {names}, not final.txt and other.txt")
    t.notes.append(f"the folder holds {', '.join(names)}")
    if not keep:
        t.close("close the window (super+w)")
        t.run_exec(["/bin/rm", "-rf", folder], "remove the task's folder")


def safari_follow_link(t):
    """mac.safari.follow-link: open a local page in Safari, follow a link by its name, and come back."""
    folder = f"/tmp/computer-bench-{t.nonce}"
    t.run_exec(["/bin/mkdir", "-p", folder], "make the task's site")
    t.write(f"{folder}/index.html", f"<!doctype html><title>Home {t.nonce}</title><h1>Home {t.nonce}</h1><p><a href=\"report.html\">Quarterly report</a></p><p><a href=\"other.html\">Something else</a></p>", "write index.html")
    t.write(f"{folder}/report.html", f"<!doctype html><title>Report {t.nonce}</title><h1>Report {t.nonce}</h1><p>Revenue grew 12%.</p>", "write report.html")
    t.write(f"{folder}/other.html", "<!doctype html><title>Other</title><h1>Other</h1>", "write other.html")
    t.say("open the site in Safari, in the background")
    t.run_exec(["/usr/bin/open", "-g", "-a", "Safari", f"{folder}/index.html"], "open -g -a Safari index.html")
    t.wait_for("Quarterly report", "wait for the page")
    tree = first_run(t, t.observe())
    link = need(t, tree["nodes"], "the Quarterly report link", role="link", contains="Quarterly report")
    t.act([{"press": link["ref"]}], "follow Quarterly report", expect={"text": f"Report {t.nonce}", "timeoutMs": 10000})
    t.act([{"key": "super+["}], "go back (super+[)", expect={"text": "Quarterly report", "timeoutMs": 10000})
    t.notes.append("followed the link by its name and came back")
    if not keep:
        t.close("close the tab (super+w)")
        t.run_exec(["/bin/rm", "-rf", folder], "remove the task's site")


def notes_new_note(t):
    """mac.notes.new-note: a note whose first line is its title and whose second line is given."""
    title, line = f"Groceries {t.nonce}", "oat milk and eggs"
    t.launch()
    tree = first_run(t, t.observe())
    # The new note's editor takes focus a moment after super+n: typing at once went to the notes list and was lost.
    # So the agent looks again and types into the editor by its ref.
    t.act([{"key": "super+n"}], "new note (super+n)")
    tree = t.observe("observe the new note's editor")
    boxes = [n for n in tree["nodes"] if n.get("role") == "textbox"]
    editor = next((n for n in boxes if "focused" in (n.get("flags") or [])), None) or (boxes[-1] if boxes else None)
    if editor is None:
        raise Failed("no text box for the new note among %d nodes" % len(tree["nodes"]))
    t.act([{"type": title, "into": editor["ref"]}, {"key": "enter"}, {"type": line}], "type the note's title and a line", expect={"text": line, "timeoutMs": 10000})
    tree = t.observe("observe the new note")
    need(t, tree["nodes"], "the note in the list, by its title", contains=title)
    t.notes.append(f"the note \"{title}\" is in the list, with its line")
    if not keep:
        # The note is selected: Delete in the list moves it to Recently Deleted.
        listed = find(tree["nodes"], role=("row", "cell", "listitem"), contains=title)
        if listed is not None:
            t.act([{"click": listed["ref"]}, {"key": "delete"}], "select the note in the list and delete it", expect={"text": title, "gone": True, "timeoutMs": 10000})


def calendar_new_event(t):
    """mac.calendar.new-event: a new event with a given title, in the calendar's current view."""
    # One word: Calendar reads a quick event's words for a date and a time, and a bare number could be taken for one.
    title = f"Standup-{t.nonce}"
    t.launch()
    tree = first_run(t, t.observe())
    # The toolbar's Add Event button opens the quick event field: the title typed there and enter make the event.
    add = need(t, tree["nodes"], "the Add Event button", role="button", name="Add Event")
    t.act([{"press": add["ref"]}], "press Add Event")
    tree = t.observe("observe the quick event field")
    boxes = [n for n in tree["nodes"] if n.get("role") == "textbox"]
    field = next((n for n in boxes if "focused" in (n.get("flags") or [])), None) or next((n for n in boxes if "Event" in (n.get("name") or "")), None)
    typing = {"type": title, "into": field["ref"]} if field is not None else {"type": title}
    t.act([typing, {"key": "enter"}], "type the event's title, enter", expect={"text": title, "timeoutMs": 10000})
    t.notes.append(f"the event \"{title}\" is on the calendar")
    if not keep:
        # The new event stays selected: Delete removes it.
        t.act([{"key": "delete"}], "delete the event", expect={"text": title, "gone": True, "timeoutMs": 10000})


TASKS = [
    ("mac.notes.new-note", "Notes", "com.apple.Notes", notes_new_note),
    ("mac.safari.follow-link", "Safari", "com.apple.Safari", safari_follow_link),
    ("mac.finder.rename-file", "Finder", "com.apple.finder", finder_rename_file),
    ("mac.textedit.edit-number", "TextEdit", "com.apple.TextEdit", textedit_edit_number),
    ("mac.calendar.new-event", "Calendar", "com.apple.iCal", calendar_new_event),
]


def encode(timeline, path):
    """The movie, by frames-to-movie.swift (AVFoundation, so nothing to install beyond Xcode)."""
    try:
        done = subprocess.run(["swift", os.path.join(here, "frames-to-movie.swift"), timeline, path], capture_output=True, text=True, timeout=600)
    except Exception as e:
        return f"not made: {e!r}"
    if done.returncode != 0:
        return f"not made: {(done.stderr or done.stdout).strip()[-400:]}"
    return path


def main():
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    c = Client()
    report = []
    try:
        hello = c.call("hello", {"client": "mini-demos"}).get("result") or {}
        print(f"Computerd on {hello.get('device', {}).get('model')}, macOS {hello.get('osVersion')}, features {json.dumps(hello.get('features'))}", flush=True)
        for tid, name, app, drive in TASKS:
            if only and tid not in only:
                continue
            t = Task(c, tid, app)
            os.makedirs(t.folder, exist_ok=True)
            print(f"{tid} ({name})", flush=True)
            if t.rec:
                t.rec.start()
                time.sleep(0.5)
            error = None
            try:
                drive(t)
            except Failed as e:
                error = str(e)
            except Exception as e:
                error = repr(e)
            took = round((time.monotonic() - t.t0) * 1000)
            if error is not None:
                print(f"  {error}")
                t.dump()
            if t.rec:
                t.say("passed" if error is None else "failed")
                time.sleep(1)
                timeline = t.rec.finish()
                t.movie = encode(timeline, os.path.join(out, f"{tid}.mp4")) if movie else "not made: --no-movie"
                frames = len(t.rec.frames)
            else:
                t.movie, frames = "not made: --no-movie", 0
            acts = [x for x in t.calls if x["method"] == "ui.act"]
            ui_ms = sum(x["ms"] for x in t.calls if x["method"] in ("ui.act", "ui.observe"))
            entry = {
                "id": tid, "app": name, "ok": error is None, "error": error, "ms": took, "uiMs": ui_ms,
                "acts": len(acts), "steps": sum(len(x["params"].get("steps", [])) for x in acts),
                "observes": sum(1 for x in t.calls if x["method"] == "ui.observe"),
                "frames": frames, "movie": t.movie, "notes": t.notes, "calls": t.calls,
            }
            if t.rec and t.rec.errors:
                entry["recorderErrors"] = t.rec.errors[:5]
            report.append(entry)
            print(f"{'PASS' if error is None else 'FAIL'} {tid}: {took} ms, {entry['acts']} acts, {entry['steps']} steps, {frames} frames, movie {t.movie}" + (f"\n  {error}" if error else ""), flush=True)
    finally:
        c.close()

    with open(os.path.join(out, "demos.json"), "w") as f:
        json.dump(report, f, indent=1)
    lines = ["| Task | App | Result | ui.act calls | Steps | ui ms | Task ms | Each call (ms) |", "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |"]
    for e in report:
        each = ", ".join(f"{x['method'].split('.')[-1]} {x['ms']}" for x in e["calls"] if x["method"].startswith("ui."))
        lines.append(f"| {e['id']} | {e['app']} | {'pass' if e['ok'] else 'FAIL: ' + (e['error'] or '')[:200].replace('|', '/')} | {e['acts']} | {e['steps']} | {e['uiMs']} | {e['ms']} | {each} |")
    table = "\n".join(lines) + "\n"
    with open(os.path.join(out, "demos.md"), "w") as f:
        f.write(table)
    print(table)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("### Demo tasks\n\n" + table)
    sys.exit(0 if all(e["ok"] for e in report) else 1)


main()
