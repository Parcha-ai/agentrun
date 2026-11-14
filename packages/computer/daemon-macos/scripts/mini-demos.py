"""The Mac mini's five demo tasks, on Notes, Safari, Finder, TextEdit and Calendar. Each is driven through
the running Computerd's own computerd command by ui.observe and ui.act with batched steps. Each call's latency is
logged. With --movie, each is recorded from screen.watch to a movie of its own window, with the step on screen.

    python3 -I mini-demos.py PATH/TO/computerd COMPUTERD_HOME OUT_DIR [--movie] [--ask-grants] [TASK ...]

TASK is a task's id (mac.notes.new-note, ...); none runs all five. Without --movie nothing is recorded (no frames, no
movie). --movie works only on a demo machine, and refuses before anything is made otherwise: a CI runner
(GITHUB_ACTIONS=true), or a user whose login name starts with "agentrun-demo" (a dedicated demo account, made by a
person). Nothing else unlocks it. --ask-grants raises Computerd's Automation prompts for the five apps, for a person at the Mac to answer, and
exits. Writes, under OUT_DIR:

    demos.json             every task's calls: method, params, ms, the steps' routes, the expect, the error, and what it left
    demos.md               the table: task, calls, steps, ms, result, left behind
    <task>.mp4             with --movie: the task's movie, its current step written along the bottom (frames-to-movie.swift)
    <task>/frames/         with --movie: the frames, each cut to the task's window, and timeline.txt
    <task>/observe-N.json  each observation's nodes, for when a step finds nothing

A screen.watch frame is the whole screen, and the Mac is a person's: a frame is cut to the task's window (the one it
pinned, else the one it last observed) before it is written anywhere, and every window in front of that window is
painted black (window-frames.swift). A frame is kept only when the window list read before it and the one read after it
agree (the window did not move, and nothing came in front or left), and the list, read every 10 ms in between, never
changed for the window, so a frame never shows a window the cut did not know of (one that lived under 10 ms could
still slip through). Until the task has a window, no frame is kept. The Dock's own window, which covers the display at
the Dock's level and is clear but for the Dock, is not painted: anything the Dock draws in it (Mission Control's
thumbnails, say) would show in a frame.

The Mac is a person's own, so a task works only in a sandbox it makes, named "AgentRun demo <run id>": its own
Calendar calendar, its own Notes folder, its own folder under /private/tmp/agentrun-demos. A note goes in the task's
folder, an event in its calendar, files in its folder. Setup and teardown are plain AppleScript and file system calls,
not the driver, so a broken driver cannot stop the cleanup; they run through Computerd's exec.run, so the Automation
grants they need are Computerd's (--ask-grants). Teardown runs whatever happens (a pass, a failure, an exception,
Ctrl-C, SIGTERM): it closes the windows and tabs on the task's files, deletes what the task made, then the sandbox.
A failed teardown fails the task.

An app that was not running before the run is the run's: it is started for the grants and the sweep and quit after
them, and its task starts it again and quits it at the end of its teardown, after the snapshot, so its window never
sits in front of a later task's. Its windows are not compared, since they go with it, and an app that did not quit
counts as left. An app that was running before the run, a
person's, is left as it is. Calendar and Notes are asked about (snapshot, teardown) only while they run, since asking
would start them.

Before each task the harness takes a snapshot of what it can see: every calendar with its count of today's events,
every Notes folder with its count of notes, the onscreen windows of the five apps by id, and the sandbox root. Only
names, counts and ids: never an event's, note's or file's contents; the calendars and folders only while Calendar and
Notes run. After the teardown it takes it again, and any difference is the task's "left", Calendar or Notes started or
quit during the task among them. The run's last line is "N/5 pass, K left behind"; the exit code is 1 unless every
task passed and left nothing. A run starts by sweeping the sandboxes an earlier run left (one killed mid-task).

Observations are written with every name and value redacted to its length, unless it holds the run id or is one the
script itself looks for, so a person's own titles never reach a file. On a CI runner (CI=true), a throwaway Mac with
nothing of a person's, nothing is redacted, so a failure's words can be read.

The ids are the computer bench's mac-dev ids (packages/computer-bench/suites/mac-dev), and each task checks what the
bench's task checks.
"""

import base64
import contextlib
import fcntl
import json
import os
import pwd
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}
if len(args) < 3:
    sys.exit(__doc__)
if flags - {"--movie", "--ask-grants"}:
    sys.exit(f"unknown option {' '.join(sorted(flags - {'--movie', '--ask-grants'}))}\n{__doc__}")
helper, home, out = args[0], args[1], os.path.abspath(args[2])
only = set(args[3:])
movie = "--movie" in flags


def demo_machine():
    """Whether this Mac may be recorded: a CI runner, or a dedicated demo account. The login name is the account's own
    (the user database's, by uid), not $USER, so no variable or flag stands in for it."""
    return os.environ.get("GITHUB_ACTIONS") == "true" or pwd.getpwuid(os.getuid()).pw_name.startswith("agentrun-demo")


if movie and not demo_machine():
    sys.exit("--movie records only on a demo machine: a CI runner (GITHUB_ACTIONS=true), or a user whose login name "
             "starts with agentrun-demo. This is neither, so nothing was recorded or made; run without --movie.")
here =os.path.dirname(os.path.abspath(__file__))
CI = os.environ.get("CI") == "true"

RUN = uuid.uuid4().hex[:6]
PREFIX = "AgentRun demo "
NAME = PREFIX + RUN
# /tmp is a link to /private/tmp: Finder and TextEdit answer with the real path, so the root is named by it.
ROOT = "/private/tmp/agentrun-demos"
APPS = {"com.apple.iCal": "Calendar", "com.apple.Notes": "Notes", "com.apple.finder": "Finder", "com.apple.TextEdit": "TextEdit", "com.apple.Safari": "Safari"}


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
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


class Cropper:
    """window-frames.swift, one process a run: where a window is and what is in front of it, and a frame cut to it."""

    def __init__(self):
        self.p = subprocess.Popen(["swift", os.path.join(here, "window-frames.swift")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.lock = threading.Lock()

    def ask(self, request):
        with self.lock:
            self.p.stdin.write(json.dumps(request) + "\n")
            self.p.stdin.flush()
            line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("window-frames.swift ended")
        reply = json.loads(line)
        if "error" in reply:
            raise RuntimeError(f"window-frames.swift: {reply['error']}")
        return reply

    def where(self, window):
        """{"bounds": [x, y, w, h], "above": [...]}, or None when the window is not on screen."""
        reply = self.ask({"op": "where", "window": str(window)})
        return reply if reply.get("bounds") else None

    def crop(self, data, place, path):
        return self.ask({"op": "crop", "jpeg": base64.b64encode(data).decode(), "bounds": place["bounds"], "above": place["above"], "out": path, "quality": 70})

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


class Recorder(threading.Thread):
    """The live view, from screen.watch on a connection of its own, each frame stamped with the run's clock and cut to
    the task's window before it is written (see the top of this file). aim() answers the task's window id, or None."""

    def __init__(self, folder, clock, aim, cropper):
        super().__init__(daemon=True)
        self.folder, self.clock, self.aim, self.cropper = folder, clock, aim, cropper
        self.frames, self.captions, self.errors = [], [], []
        # Frames not kept, by why: the sequence's first, no window yet, the window not on screen, the window moved, a
        # window in front came or went, the window list changed and changed back between the two reads, or the cut
        # failed.
        self.dropped = {}
        # The windows painted over in kept frames, by owner, layer and size, and how many frames each was in.
        self.painted = {}
        self.halt = threading.Event()
        os.makedirs(folder, exist_ok=True)

    def caption(self, text):
        self.captions.append((self.clock(), text))

    def place(self):
        """Where the task's window is, "no window yet" before the task has one, or "not on screen"."""
        window = self.aim()
        if not window:
            return "no window yet"
        return self.cropper.where(window) or "not on screen"

    def run(self):
        c = Client()
        seq = None
        try:
            while not self.halt.is_set():
                before = self.place()
                # The first call only learns the sequence: screen.watch may answer it with a frame taken before the task.
                reply = c.call("screen.watch", {"after": seq or 0, "waitMs": 0 if seq is None else 250, "maxWidth": 1280, "quality": 70})
                r = reply.get("result")
                if r is None:
                    self.errors.append(json.dumps(reply.get("error")))
                    time.sleep(0.5)
                    continue
                if not r.get("changed"):
                    seq = r["seq"] if seq is None else seq
                    continue
                at = self.clock()
                data = base64.b64decode(r.get("data", ""))
                while not r.get("eof", True) and len(data) < r.get("size", 0):
                    more = c.call("screen.read", {"id": r["id"], "offset": len(data)}).get("result") or {}
                    data += base64.b64decode(more.get("data", ""))
                    if more.get("eof", True):
                        break
                first, seq = seq is None, r["seq"]
                after = self.place()
                why = None
                if first:
                    why = "first"
                elif isinstance(before, str) or isinstance(after, str):
                    why = before if isinstance(before, str) else after
                elif before["bounds"] != after["bounds"]:
                    why = "moved"
                elif before["above"] != after["above"]:
                    why = "in front"
                elif before["changes"] != after["changes"]:
                    why = "came and went"  # a window, say, in front only between the two reads
                if why is None:
                    path = os.path.join(self.folder, f"{len(self.frames):05d}.jpg")
                    try:
                        self.cropper.crop(data, before, path)
                        self.frames.append((at, path))
                        for who in before.get("who", []):
                            self.painted[who] = self.painted.get(who, 0) + 1
                    except RuntimeError as e:  # a window off the main display, say: that frame is not kept
                        why = "cut failed"
                        self.errors.append(str(e))
                if why:
                    self.dropped[why] = self.dropped.get(why, 0) + 1
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


# --- plain scripting: AppleScript through Computerd's exec.run, and the window list ---------------------------------


def exec_run(c, argv, timeout_ms=60000):
    """A command on the Mac through Computerd's exec.run: its stdout, or Failed with its stderr."""
    reply = c.call("exec.run", {"argv": argv, "timeoutMs": timeout_ms})
    if "error" in reply:
        raise Failed(f"{os.path.basename(argv[0])}: {reply['error'].get('message')}")
    r = reply["result"]
    if r.get("timedOut"):
        raise Failed(f"{os.path.basename(argv[0])}: no answer in {timeout_ms // 1000} s")
    if r.get("exitCode") != 0:
        err = base64.b64decode(r.get("stderr", "")).decode(errors="replace").strip()
        raise Failed(f"{os.path.basename(argv[0])}: exit {r.get('exitCode')}: {err[-400:]}")
    return base64.b64decode(r.get("stdout", "")).decode(errors="replace")


def osa(c, script, *argv):
    """An AppleScript, its words given as argv (never spliced into the source)."""
    return exec_run(c, ["/usr/bin/osascript", "-e", script, *argv])


def can_automate(c, ask=False):
    """Computerd's grants the sandbox needs, by what they are for: granted, denied, unasked, not running. Automation of
    each app, and Calendars (Privacy & Security > Calendars), since Calendar's AppleScript reads the store for the
    process that sent the event: without it the snapshot waited on Calendar with no answer."""
    words = exec_run(c, ["/usr/bin/swift", os.path.join(here, "can-automate.swift")] + (["--ask"] if ask else []) + list(APPS), 600000)
    names = dict(APPS, calendars="calendar data")
    pairs = (line.split(" ", 1) for line in words.splitlines() if " " in line)
    return {(f"Automation of {names[k]}" if k in APPS else names.get(k, k)): v for k, v in pairs}


# The onscreen windows of every app, by id, through CoreGraphics from JavaScript for Automation's bridge: no Apple event,
# so no grant, and run here (not through Computerd) so it works when Computerd does not. Without Screen Recording,
# CoreGraphics gives no titles: ids are all it reads.
WINDOWS_JS = """
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
function run(argv) {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey('kCGWindowLayer')) !== 0) continue;
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')));
    if (app.isNil()) continue;
    const id = ObjC.unwrap(app.bundleIdentifier);
    if (argv.indexOf(id) >= 0) out.push([id, ObjC.unwrap(w.objectForKey('kCGWindowNumber'))]);
  }
  return JSON.stringify(out);
}
"""


RUNNING_JS = """
ObjC.import('AppKit');
function run(argv) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const out = [];
  for (let i = 0; i < apps.count; i++) {
    const id = ObjC.unwrap(apps.objectAtIndex(i).bundleIdentifier);
    if (argv.indexOf(id) >= 0) out.push(id);
  }
  return JSON.stringify(out);
}
"""


def running():
    """Which of the five apps run now (apps.list lists the installed ones too)."""
    done = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", RUNNING_JS, *APPS], capture_output=True, text=True, timeout=30)
    if done.returncode != 0:
        raise Failed(f"the running apps: {done.stderr.strip()[-300:]}")
    return set(json.loads(done.stdout or "[]"))


def windows():
    done = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", WINDOWS_JS, *APPS], capture_output=True, text=True, timeout=30)
    if done.returncode != 0:
        raise Failed(f"the window list: {done.stderr.strip()[-300:]}")
    found = {}
    for app, wid in json.loads(done.stdout or "[]"):
        found.setdefault(app, set()).add(str(wid))
    return found


# --- the sandbox: made and removed by AppleScript ---------------------------------------------------------------------

MAKE_CALENDAR = """on run argv
  tell application "Calendar" to make new calendar with properties {name:item 1 of argv}
  return ""
end run"""
# The Notes folders' names (CI only: on a person's Mac they are theirs).
FOLDER_NAMES = """tell application "Notes" to return name of every folder"""

# The calendars, every event in them with them; then any event anywhere titled exactly as a task titles its event (one
# made in the default calendar and not yet moved into the sandbox when the task failed or was killed). Only while
# Calendar runs: a tell would start it, and its window would sit in front of the next task's. The sweep runs while it
# does, so a sandbox a quit Calendar still holds goes then.
REMOVE_CALENDARS = """on run argv
  if application "Calendar" is not running then return ""
  set prefix to item 1 of argv
  set titles to rest of argv
  tell application "Calendar"
    set n to 0
    repeat while (exists (first calendar whose name starts with prefix)) and n < 50
      delete (first calendar whose name starts with prefix)
      set n to n + 1
    end repeat
    repeat with t in titles
      set t to t as text
      repeat with c in calendars
        if writable of c then delete (every event of c whose summary is t)
      end repeat
    end repeat
  end tell
  return ""
end run"""


def event_title(run):
    """The calendar task's event title: one word with the run id in it, since Calendar reads a quick event's words for a
    date and a time."""
    return f"Standup-{run}"

MAKE_FOLDER = """on run argv
  tell application "Notes" to make new folder with properties {name:item 1 of argv}
  return ""
end run"""

# Every note in the sandbox folders, then the folders, then those notes again from Recently Deleted, where a deleted
# note waits 30 days: only notes whose title starts with the prefix, which only a task writes. Only while Notes runs, as
# with Calendar.
REMOVE_FOLDERS = """on run argv
  if application "Notes" is not running then return ""
  set prefix to item 1 of argv
  tell application "Notes"
    set n to 0
    repeat while (exists (first folder whose name starts with prefix)) and n < 50
      set f to first folder whose name starts with prefix
      delete (every note of f)
      delete f
      set n to n + 1
    end repeat
    repeat with f in (every folder whose name is "Recently Deleted")
      delete (every note of f whose name starts with prefix)
    end repeat
  end tell
  return ""
end run"""

# The windows and tabs on the sandbox's files: Safari's tabs by their address, Finder's windows by their folder's name
# (a sandbox's own name), TextEdit's documents by their path, each closed without saving. An app that is not
# running has none.
CLOSE_WINDOWS = """on run argv
  set root to item 1 of argv
  set url_root to "file://" & root
  if application "Safari" is running then
    tell application "Safari"
      repeat with w in windows
        close (every tab of w whose URL starts with url_root)
      end repeat
    end tell
  end if
  if application "TextEdit" is running then
    tell application "TextEdit"
      repeat with d in (every document whose path starts with root)
        close d saving no
      end repeat
    end tell
  end if
  set name_prefix to item 2 of argv
  -- Finder's windows by name, the sandbox folder's own: on macOS 26 Finder answered close on a reference taken from
  -- its window list with -10010, and id of one with -1728, so each is named instead.
  tell application "Finder" to set names to name of every Finder window
  repeat with n in names
    set n to n as text
    if n starts with name_prefix then
      tell application "Finder"
        try
          close (every Finder window whose name is n)
        end try
        if exists Finder window n then close Finder window n
        if exists Finder window n then error "Finder's window " & n & " stayed open"
      end tell
    end if
  end repeat
  return ""
end run"""

# The snapshot's AppleScript half: each calendar's name and its count of today's events, each Notes folder's name and
# its count of notes. Names and counts only. One script per app, so a stuck app is named.
SNAPSHOT_CALENDARS = """on run argv
  set t0 to current date
  set time of t0 to 0
  set t1 to t0 + 1 * days
  set out to ""
  tell application "Calendar"
    repeat with c in calendars
      set out to out & (name of c) & tab & (count (events of c whose start date >= t0 and start date < t1)) & linefeed
    end repeat
  end tell
  return out
end run"""

SNAPSHOT_FOLDERS = """on run argv
  set out to ""
  tell application "Notes"
    repeat with f in folders
      set out to out & (name of f) & tab & (count notes of f) & linefeed
    end repeat
  end tell
  return out
end run"""


# Each calendar holding an event with this title, and how many.
EVENT_CALENDARS = """on run argv
  set out to ""
  tell application "Calendar"
    repeat with c in calendars
      set n to count (events of c whose summary is (item 1 of argv))
      if n > 0 then set out to out & (name of c) & " " & n & linefeed
    end repeat
  end tell
  return out
end run"""


def snapshot(c):
    """What the harness can see: names, counts and ids. Calendar's calendars and Notes' folders only while the app runs
    (None when it does not): asking would start it."""
    shot = {"calendars": {}, "folders": {}, "windows": {}, "root": []}
    up = running()
    for group, script, app in (("calendars", SNAPSHOT_CALENDARS, "com.apple.iCal"), ("folders", SNAPSHOT_FOLDERS, "com.apple.Notes")):
        if app not in up:
            shot[group] = None
            continue
        try:
            lines = osa(c, script).splitlines()
        except Failed as e:
            raise Failed(f"the snapshot of {APPS[app]}: {e}")
        for line in lines:
            name, count = (line.split("\t") + [""])[:2]
            fill(shot[group], name, count)
    shot["windows"] = {app: sorted(ids) for app, ids in windows().items()}
    shot["root"] = sorted(os.listdir(ROOT)) if os.path.isdir(ROOT) else []
    return shot


def fill(group, name, count):
    """One name and count, under a key of its own: two calendars may share a name."""
    key, n = name, 2
    while key in group:
        key, n = f"{name} ({n})", n + 1
    group[key] = int(count or 0)


def differences(before, after, quitting=None):
    """Every way after is not before, in words. quitting: an app the run started, quit right after this: its windows go
    with it (and one that does not quit counts on its own), so none of them is left. What an app opens on launch is
    not the same each time (TextEdit's Open panel on CI, or nothing)."""
    left = []
    for group, what, unit, app in (("calendars", "calendar", "events today", "Calendar"), ("folders", "Notes folder", "notes", "Notes")):
        if before[group] is None or after[group] is None:
            if before[group] is not None:
                left.append(f"{app} quit during the task")
            elif after[group] is not None:
                left.append(f"{app} was started during the task")
            continue
        for name in sorted(set(before[group]) | set(after[group])):
            was, now = before[group].get(name), after[group].get(name)
            if was is None:
                left.append(f"{what} {name!r} ({now} {unit})")
            elif now is None:
                left.append(f"{what} {name!r} is gone")
            elif now != was:
                left.append(f"{what} {name!r}: {now} {unit}, was {was}")
    for app in sorted((set(before["windows"]) | set(after["windows"])) - {quitting}):
        new =sorted(set(after["windows"].get(app, [])) - set(before["windows"].get(app, [])))
        gone = sorted(set(before["windows"].get(app, [])) - set(after["windows"].get(app, [])))
        left += [f"{APPS[app]} window {w}" for w in new] + [f"{APPS[app]} window {w} is gone" for w in gone]
    left += [f"{ROOT}/{name}" for name in after["root"] if name not in before["root"]]
    return left


def settle(c, before, quitting=None, seconds=15):
    """The snapshot again, asked until it matches the one before or the time is up: a store takes a moment to save."""
    deadline = time.monotonic() + seconds
    while True:
        after = snapshot(c)
        left = differences(before, after, quitting)
        if not left or time.monotonic() > deadline:
            return left
        time.sleep(1)


def sweep(c):
    """The sandboxes an earlier run left (killed mid-task, or a teardown that failed): removed before anything else."""
    shot = snapshot(c)
    calendars, folders = shot["calendars"] or {}, shot["folders"] or {}
    earlier = [n for n in calendars if n.startswith(PREFIX)] + [n for n in folders if n.startswith(PREFIX)] + [f"{ROOT}/{n}" for n in shot["root"]]
    for name in earlier:
        print(f"  sweep: {name}", flush=True)
    # A killed calendar task's event may still be in the default calendar: its title is known from the run id in the
    # name of the calendar the task made first.
    runs = sorted({n[len(PREFIX):len(PREFIX) + 6] for n in calendars if n.startswith(PREFIX)})
    osa(c, CLOSE_WINDOWS, ROOT, PREFIX)
    osa(c, REMOVE_CALENDARS, PREFIX, *[event_title(r) for r in runs])
    osa(c, REMOVE_FOLDERS, PREFIX)
    shutil.rmtree(ROOT, ignore_errors=True)
    shot = snapshot(c)
    still = [n for n in shot["calendars"] or {} if n.startswith(PREFIX)] + [n for n in shot["folders"] or {} if n.startswith(PREFIX)] + shot["root"]
    if still:
        raise Failed(f"the sweep left an earlier run's sandbox: {still}")
    print(f"earlier runs' sandboxes: {len(earlier)} swept, none left", flush=True)


# --- one task ---------------------------------------------------------------------------------------------------------

# The words the script looks for: an observation keeps these, and anything holding the run id, and redacts the rest.
KNOWN = {"Continue", "Get Started", "Not Now", "Done", "OK", "Add Event", "Go back", "list view", "draft.txt", "final.txt",
         "other.txt", "Quarterly report", "Pears: 41", "Edited", "New Note", "Notes", "Calendar", "Delete", "Cancel"}


def redacted(text):
    if CI or not text or RUN in text or text in KNOWN:
        return text
    return f"<{len(text)} chars>"


def redact(node):
    return {k: (redacted(v) if k in ("name", "value", "desc") else v) for k, v in node.items()}


class Task:
    """One run of one task: its calls, timed, its observations, its movie's captions, and what it made."""

    def __init__(self, c, tid, app, cropper):
        self.c, self.id, self.app = c, tid, app
        self.calls, self.notes = [], []
        self.observed = 0
        self.window = None
        # The window the task last observed: the movie's frames are cut to it until the task pins one.
        self.shown = None
        self.inspector = False
        self.folder = os.path.join(out, tid)
        self.t0 = time.monotonic()
        aim = lambda: self.window or self.shown  # noqa: E731
        self.rec = Recorder(os.path.join(self.folder, "frames"), lambda: time.monotonic() - self.t0, aim, cropper) if cropper else None

    def say(self, text):
        print(f"  {self.id}: {text}", flush=True)
        if self.rec:
            self.rec.caption(text)

    def call(self, method, params, label, not_found=None):
        """One call, timed and recorded. not_found: the words for a not_found the caller expects (a poll for a window
        still to come), printed in place of an error."""
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
            self.shown = (r.get("window") or {}).get("id") or self.shown
        self.calls.append(entry)
        # A route, with " unverified" when no readback saw the step's effect; or the refusal's kind.
        routes = ", ".join(
            (s["route"] + ("" if s.get("verified") else " unverified")) if "route" in s else (s.get("error") or {}).get("kind", "?")
            for s in r.get("steps") or []
        )
        tail = f" [{routes}]" if routes else ""
        if "expect" in entry and entry["expect"]:
            tail += f" expect {entry['expect']}"
        kind = (reply.get("error") or {}).get("data", {}).get("kind")
        if not_found and kind == "not_found":
            tail += f" ({not_found})"
        elif "error" in reply:
            tail += f" ERROR {json.dumps(reply['error'])}"
        print(f"    {method} {label}: {ms} ms{tail}", flush=True)
        return reply

    def observe(self, label="observe", **extra):
        params = {"target": self.target()}
        params.update(extra)
        # An app just opened may swap its first window for another (Notes does): not_found is asked again, for 10 s.
        deadline = time.monotonic() + 10
        while True:
            reply = self.call("ui.observe", params, label, not_found="no window yet")
            if (reply.get("error") or {}).get("data", {}).get("kind") != "not_found" or time.monotonic() > deadline:
                break
            time.sleep(0.5)
        if "error" in reply:
            raise Failed(f"ui.observe {self.app}: {reply['error'].get('message')}")
        r = reply["result"]
        self.observed += 1
        path = os.path.join(self.folder, f"observe-{self.observed}.json")
        with open(path, "w") as f:
            kept = {k: v for k, v in r.items() if k not in ("image", "nodes", "window")}
            kept["window"] = dict(r["window"], title=redacted(r["window"].get("title")))
            kept["nodes"] = [redact(n) for n in r.get("nodes", [])]
            json.dump(kept, f, indent=1)
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
        params = {"target": self.target(), "steps": steps}
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

    def dump(self):
        """The window's nodes, printed redacted, for a failed task."""
        try:
            r = self.c.call("ui.observe", {"target": self.target()}).get("result") or {}
        except Exception as e:
            print(f"  (no observation: {e!r})")
            return
        print(f"  the window now ({redacted(r.get('window', {}).get('title'))!r}, {len(r.get('nodes', []))} nodes):")
        for n in [redact(n) for n in r.get("nodes", [])[:150]]:
            print(f"    {n.get('ref')} {n.get('role')} name={n.get('name')!r} value={(n.get('value') or '')[:60]!r} id={n.get('id')!r} flags={n.get('flags')} parent={n.get('parent')}")

    def wait_for(self, text, label, seconds=20):
        """Until the task's window (or, before one is pinned, the app's main one) shows the text: an expect, asked again
        while there is no window yet."""
        self.say(label)
        deadline = time.monotonic() + seconds
        while True:
            params = {"target": self.target(), "steps": [], "expect": {"text": text, "timeoutMs": 3000}}
            reply = self.call("ui.act", params, label, not_found="no window yet")
            if (reply.get("result") or {}).get("expect") == "met":
                return
            if time.monotonic() > deadline:
                why = (reply.get("error") or {}).get("message") or f"the expect was {(reply.get('result') or {}).get('expect')}"
                raise Failed(f"{label}: no window of {self.app} showed {text!r} in {seconds} s: {why}")
            time.sleep(0.5)

    def pin(self, title, label, seconds=20):
        """The app's onscreen window with this title, pinned: every later call names it, so a person's own windows of
        the same app are never the target. Read by window id from the window list, then by ui.observe's title."""
        self.say(label)
        deadline = time.monotonic() + seconds
        while True:
            for wid in sorted(windows().get(self.app, ())):
                reply = self.c.call("ui.observe", {"target": {"app": self.app, "window": wid}})
                if ((reply.get("result") or {}).get("window") or {}).get("title") == title:
                    self.window = wid
                    print(f"    pinned window {wid}", flush=True)
                    return
            if time.monotonic() > deadline:
                raise Failed(f"{label}: no {APPS[self.app]} window titled {title!r} in {seconds} s")
            time.sleep(0.5)

    def run_exec(self, argv, label, timeout_ms=30000):
        start = time.monotonic()
        try:
            return exec_run(self.c, argv, timeout_ms)
        finally:
            self.calls.append({"label": label, "method": "exec.run", "ms": round((time.monotonic() - start) * 1000), "params": {"argv": argv[:1]}})

    def write(self, path, text, label):
        reply = self.call("files.write", {"path": path, "data": base64.b64encode(text.encode()).decode()}, label)
        if "error" in reply:
            raise Failed(f"{label}: {reply['error'].get('message')}")

    def target(self):
        """The task's app, and its window once the task pinned one (an app such as Finder has other windows open)."""
        return {"app": self.app, "window": self.window} if self.window else {"app": self.app}

    def launch(self, label=None, background=True):
        words = label or f"open {APPS[self.app]}" + (" in the background" if background else ", in front")
        reply = self.call("apps.launch", {"id": self.app, "background": background}, words)
        if "error" in reply:
            raise Failed(f"apps.launch {self.app}: {reply['error'].get('message')}")


def find(nodes, role=None, name=None, starts=None, contains=None, value=None, id=None):
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
        if id is not None and n.get("id") != id:
            continue
        return n
    return None


def need(task, nodes, what, **query):
    node = find(nodes, **query)
    if node is None:
        shown = [f"{n.get('role')} {redacted(n.get('name')) or ''!r} {redacted(n.get('value')) or ''!r}"[:90] for n in nodes[:80]]
        raise Failed(f"no {what} ({json.dumps(query)}) among {len(nodes)} nodes; first ones: " + "; ".join(shown))
    return node


# A fresh Mac's first-run sheets: pressed once, before a task's snapshot (CI's runner shows Notes' each time).
FIRST_RUN = ("Continue", "Get Started", "Not Now", "Done", "OK")


def first_run(task, tree):
    """The tree once the app's first-run sheets are pressed away, and how many there were."""
    pressed = 0
    for _ in range(3):
        button = next((n for n in tree["nodes"] if n.get("role") == "button" and n.get("name") in FIRST_RUN), None)
        if button is None:
            break
        task.act([{"press": button["ref"]}], f"dismiss the first-run sheet ({button['name']})")
        pressed += 1
        tree = task.observe("observe after the first-run sheet")
    return tree, pressed


# --- the five tasks ---------------------------------------------------------------------------------------------------
# Each one is (prepare, drive): prepare opens the app and its first-run sheets before the snapshot; drive makes the
# task's sandbox and does the task in it.


def sandbox_folder(t, short):
    """The task's own folder under the root, named for the sandbox and the task."""
    folder = f"{ROOT}/{NAME} {short}"
    t.run_exec(["/bin/mkdir", "-p", folder], "make the task's folder")
    return folder


def textedit_edit_number(t):
    """mac.textedit.edit-number: change one number in a text file and save it; the rest of the file stays."""
    folder = sandbox_folder(t, "textedit")
    path = f"{folder}/totals-{RUN}.txt"
    before = "Apples: 3\nPears: 41\nPlums: 7\n"
    after = "Apples: 3\nPears: 42\nPlums: 7\n"
    t.write(path, before, "write the totals file")
    t.say("open the totals file in TextEdit, in the background")
    t.run_exec(["/usr/bin/open", "-g", "-a", "TextEdit", path], "open -g -a TextEdit the totals file")
    t.pin(f"totals-{RUN}.txt", "find the document's window")
    t.wait_for("Pears: 41", "wait for the document")
    tree = t.observe()
    text = need(t, tree["nodes"], "text area", role="textbox", contains="Pears: 41")
    # Typed, not set: a set (or an accessibility insert) replaces the text view's string without the document taking it
    # as an edit (no "Edited" mark on the mini and in CI), so the driver types a text area's text by keys first. Each
    # expect reads the document, not the field's echo: TextEdit marks a document it took an edit into "Edited", and
    # drops the mark once it saved it.
    t.act([{"key": "super+a"}, {"type": after, "into": text["ref"]}], "select all and type the new text", expect={"text": "Edited", "timeoutMs": 5000})
    t.act([{"key": "super+s"}], "save (super+s)", expect={"text": "Edited", "gone": True, "timeoutMs": 5000})
    deadline = time.monotonic() + 10
    while True:
        got = t.c.call("files.read", {"path": path}).get("result") or {}
        saved = base64.b64decode(got.get("data", "")).decode(errors="replace")
        if saved == after or time.monotonic() > deadline:
            break
        time.sleep(0.25)
    if saved != after:
        raise Failed(f"the totals file holds {saved!r}, not {after!r}")
    t.notes.append("the totals file saved with Pears: 42, the other lines kept")


def finder_rename_file(t):
    """mac.finder.rename-file: rename one file in a Finder window; the other file stays."""
    folder = sandbox_folder(t, "finder")
    t.write(f"{folder}/draft.txt", "the draft\n", "write draft.txt")
    t.write(f"{folder}/other.txt", "another file\n", "write other.txt")
    t.say("open the folder in Finder, in the background")
    t.run_exec(["/usr/bin/open", "-g", folder], "open -g the folder")
    # Finder has a person's own windows open on a real desktop: the task's window is found by its title and every later
    # call names it.
    t.pin(os.path.basename(folder), "find the folder's window")
    t.wait_for("draft", "wait for the folder's files")
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

    # Each way is judged by the disk, never by the window. A file's name is an item that opens, not a field: the driver
    # refuses a set on it (Finder took a set name into the field and renamed nothing), so the rename is Finder's own,
    # by keys. The ways, most background first; the one that renamed it goes in the notes.
    def renamed(way, steps, foreground=False):
        r = t.act(steps, way, foreground=foreground, must=False)
        routes = ", ".join((s.get("route", "?") + ("" if s.get("verified") else " unverified")) for s in (r or {}).get("steps") or [])
        if listing(3) == want:
            t.notes.append(f"renamed by: {way} [{routes}]")
            return True
        print(f"    (the folder still holds draft.txt after: {way} [{routes}])", flush=True)
        return False

    # Enter on the selected file edits its name with the part before .txt selected: typing replaces that.
    keys = [{"key": "enter"}, {"type": "final"}, {"key": "enter"}]
    done = renamed("rename it in the background: enter, type final, enter", keys)
    if not done:
        # Finder starts a rename only in its key window: bring it forward, raise the task's window, and rename as a
        # person does.
        t.launch(background=False)
        window = find(tree["nodes"], role="window")
        if window is not None:
            t.act([{"perform": window["ref"], "action": "AXRaise"}], "raise the folder's window", must=False)
        done = renamed("rename it in front: enter, type final, enter", keys, foreground=True)
    names = listing(5)
    if names != want:
        raise Failed(f"the folder holds {names}, not final.txt and other.txt")
    t.notes.append(f"the folder holds {', '.join(names)}")


def safari_follow_link(t):
    """mac.safari.follow-link: open a local page in Safari, follow a link by its name, and come back."""
    folder = sandbox_folder(t, "safari")
    home_title, report_title = f"Home {RUN}", f"Report {RUN}"
    t.write(f"{folder}/index.html", f"<!doctype html><title>{home_title}</title><h1>{home_title}</h1><p><a href=\"report.html\">Quarterly report</a></p><p><a href=\"other.html\">Something else</a></p>", "write index.html")
    t.write(f"{folder}/report.html", f"<!doctype html><title>{report_title}</title><h1>{report_title}</h1><p>Revenue grew 12%.</p>", "write report.html")
    t.write(f"{folder}/other.html", f"<!doctype html><title>Other {RUN}</title><h1>Other</h1>", "write other.html")
    t.say("open the site in Safari, in the background")
    t.run_exec(["/usr/bin/open", "-g", "-a", "Safari", f"{folder}/index.html"], "open -g -a Safari index.html")
    # Safari may put the page in a tab of a person's own window: the window is found by the page's title, the tab it
    # shows, and the teardown closes the tab by its address.
    t.pin(home_title, "find the page's window")
    t.wait_for("Quarterly report", "wait for the page")
    tree, _ = first_run(t, t.observe())
    link = need(t, tree["nodes"], "the Quarterly report link", role="link", contains="Quarterly report")
    t.act([{"press": link["ref"]}], "follow Quarterly report", expect={"text": report_title, "timeoutMs": 10000})
    # Back by the toolbar's Back button, by its ref: a background Safari's menus read disabled, and super+[ posted to
    # it in the background does not always land.
    tree = t.observe("observe the report")
    back = find(tree["nodes"], role="button", name="Go back") or need(t, tree["nodes"], "the Back button", role="button", contains="back")
    t.act([{"press": back["ref"]}], "go back (the Back button)", expect={"text": "Quarterly report", "timeoutMs": 10000})
    t.notes.append("followed the link by its name and came back by the Back button")


def notes_prepare(t):
    """Notes open, and a fresh Notes' first-run state answered before the snapshot. A Notes that showed its Welcome sheet
    (CI's runner, which has no Apple Account) also asks to turn on iCloud the first time anything is made in it, so a
    folder is made here, the alert is answered Cancel, and the folder is removed: the task then makes its own with no
    alert, and the snapshot sees none of it."""
    t.launch()
    _, pressed = first_run(t, t.observe())
    if not pressed:
        return
    setup = f"{NAME} setup"
    t.say("make and remove a setup folder, answering the iCloud alert it raises")
    with shielded():
        notes_setup_folder(t, setup)


def notes_setup_folder(t, setup):
    """The setup folder made, the alert answered, and the folder removed whatever happened in between (the caller holds
    stop signals off until then)."""
    try:
        t.run_exec(["/usr/bin/osascript", "-e", MAKE_FOLDER, setup], "make a setup folder")
        deadline = time.monotonic() + 10
        while True:
            tree = t.observe("look for the iCloud alert")
            alert = find(tree["nodes"], role="dialog")
            cancel = find(tree["nodes"], role="button", name="Cancel")
            if alert is not None and cancel is not None and find(tree["nodes"], contains="iCloud") is not None:
                t.act([{"press": cancel["ref"]}], "answer the iCloud alert (Cancel)")
                break
            if time.monotonic() > deadline:
                print("    (no iCloud alert in 10 s)", flush=True)
                break
            time.sleep(0.5)
    finally:
        t.run_exec(["/usr/bin/osascript", "-e", REMOVE_FOLDERS, setup], "remove the setup folder")


def notes_new_note(t):
    """mac.notes.new-note: a note whose first line is its title and whose second line is given, in the task's folder."""
    # The line starts with a capital: Notes capitalizes a line's first word as it is typed (it did on CI's runner).
    title, line = f"{NAME} groceries", "Oat milk and eggs"
    t.say("make the task's Notes folder (AppleScript)")
    t.run_exec(["/usr/bin/osascript", "-e", MAKE_FOLDER, NAME], "make the Notes folder")
    # The folder list shows a folder made by AppleScript a moment later.
    try:
        t.wait_for(f"{NAME},", "wait for the task's folder in the folder list", seconds=15)
    except Failed as e:
        if CI:
            raise Failed(f"{e}; Notes' folders: {osa(t.c, FOLDER_NAMES).strip()}") from None
        raise
    tree = t.observe("observe Notes with the task's folder")
    # The folder list names each folder "<name>, <count> notes": the task's folder, opened by its cell, is where
    # super+n puts the new note.
    cell = need(t, tree["nodes"], "the task's folder in the folder list", starts=f"{NAME},")
    t.act([{"click": cell["ref"]}], "open the task's folder")
    # The folder is open when its cell is the selected one. The window's title names it too ("<folder> – No notes"),
    # but not always: on macOS 26 it kept the first folder's name with the task's folder open, in some runs.
    deadline = time.monotonic() + 5
    while "selected" not in ((find((tree := t.observe("observe the task's folder"))["nodes"], role="cell", starts=f"{NAME},") or {}).get("flags") or []):
        if time.monotonic() > deadline:
            raise Failed("the task's folder did not open: another folder is selected")
        time.sleep(0.3)
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
    count = """on run argv
  tell application "Notes" to return count (notes of folder (item 1 of argv) whose name is (item 2 of argv))
end run"""
    deadline = time.monotonic() + 10
    while (got := t.run_exec(["/usr/bin/osascript", "-e", count, NAME, title], "count the note in the task's folder").strip()) != "1":
        if time.monotonic() > deadline:
            raise Failed(f"the task's folder holds {got} notes titled {title!r}, not 1")
        time.sleep(0.5)
    t.notes.append(f"the note \"{title}\" is in the task's folder, with its line")


def calendar_names(c):
    return [line.split("\t")[0] for line in osa(c, SNAPSHOT_CALENDARS).splitlines()]


def calendar_setup_quick_event(t, add):
    """The quick event field opened, typed into, and cancelled with escape whatever happened in between, before enter
    makes an event (the caller holds stop signals off until then)."""
    field = None
    try:
        t.act([{"press": add["ref"]}], "setup: open the quick event field")
        tree = t.observe("observe the quick event field")
        boxes = [n for n in tree["nodes"] if n.get("role") == "textbox"]
        field = next((n for n in boxes if "focused" in (n.get("flags") or [])), None)
        if field is not None:
            t.act([{"type": "Setup", "into": field["ref"]}], "setup: type into it")
            time.sleep(2)  # the field reads what is typed a moment later
    finally:
        # Escape cancels the field; it is gone after it.
        for _ in range(3):
            t.act([{"key": "escape"}], "setup: cancel the quick event")
            tree = t.observe("observe after escape")
            if field is None or not any(n.get("ref") == field["ref"] for n in tree["nodes"]):
                break
        else:
            raise Failed("the setup's quick event field is still open after escape")


def calendar_prepare(t):
    """Calendar open, its first-run sheets answered, and its calendar list still: a fresh Calendar (CI's runner) adds
    its own calendar (Scheduled Reminders) when its quick event field first reads what is typed into it, and one added
    after the snapshot would count as the task's. So a quick event is typed here and cancelled before it is made (no
    event is made), and the list is read until it has not changed for 8 s (at most 40 s)."""
    t.launch()
    tree, _ = first_run(t, t.observe())
    add = find(tree["nodes"], role="button", name="Add Event")
    if add is not None:
        with shielded():
            calendar_setup_quick_event(t, add)
    t.say("wait for Calendar's list of calendars to be still")
    start = time.monotonic()
    names, since = calendar_names(t.c), start
    while time.monotonic() - since < 8 and time.monotonic() - start < 40:
        time.sleep(1)
        now = calendar_names(t.c)
        if now != names:
            # Names on CI only: on a person's Mac they are theirs.
            print(f"    the calendars changed at {time.monotonic() - start:.1f} s: {len(names)} -> {len(now)}" + (f" {now}" if CI else ""), flush=True)
            names, since = now, time.monotonic()
    print(f"    {len(names)} calendars, still for {time.monotonic() - since:.0f} s" + (f": {names}" if CI else ""), flush=True)


def calendar_new_event(t):
    """mac.calendar.new-event: a new event with a given title, in the task's own calendar."""
    title = event_title(RUN)
    t.say("make the task's calendar (AppleScript)")
    t.run_exec(["/usr/bin/osascript", "-e", MAKE_CALENDAR, NAME], "make the calendar")
    tree = t.observe()
    # The toolbar's Add Event button opens the quick event field: the title typed there and enter make the event, in
    # the default calendar, with its inspector open; the inspector's calendar menu moves it into the task's calendar.
    add = need(t, tree["nodes"], "the Add Event button", role="button", name="Add Event")
    t.inspector = True  # from here on the teardown closes the inspector first (see close_inspector)
    t.act([{"press": add["ref"]}], "press Add Event")
    tree = t.observe("observe the quick event field")
    boxes = [n for n in tree["nodes"] if n.get("role") == "textbox"]
    field = next((n for n in boxes if "focused" in (n.get("flags") or [])), None) or next((n for n in boxes if "Event" in (n.get("name") or "")), None)
    typing = {"type": title, "into": field["ref"]} if field is not None else {"type": title}
    t.act([typing, {"key": "enter"}], "type the event's title, enter", expect={"text": title, "timeoutMs": 10000})
    tree = t.observe("observe the event's inspector")
    menu = need(t, tree["nodes"], "the inspector's calendar menu", id="calendar-button")
    t.act([{"press": menu["ref"]}], "open the event's calendar menu")
    tree = t.observe("observe the calendar menu", full=True)
    item = need(t, tree["nodes"], "the task's calendar in the menu", role="menuitem", name=NAME)
    t.act([{"press": item["ref"]}], "move the event into the task's calendar")
    # On macOS 26 an event whose inspector is still open, its title being edited, is in no calendar yet (AppleScript
    # finds it nowhere), and escape there drops it: enter in the title saves it.
    t.act([{"key": "enter"}], "save the event (enter in its title)")
    count = """on run argv
  tell application "Calendar" to return count (events of calendar (item 1 of argv) whose summary is (item 2 of argv))
end run"""
    deadline = time.monotonic() + 10
    while (got := t.run_exec(["/usr/bin/osascript", "-e", count, NAME, title], "count the event in the task's calendar").strip()) != "1":
        if time.monotonic() > deadline:
            # On CI, where the event went instead (calendar names are a person's elsewhere).
            where = f"; the calendars holding it: {osa(t.c, EVENT_CALENDARS, title).strip() or 'none'}" if CI else ""
            raise Failed(f"the task's calendar holds {got} events titled {title!r}, not 1{where}")
        time.sleep(0.5)
    t.notes.append(f"the event \"{title}\" is in the task's calendar")


TASKS = [
    ("mac.notes.new-note", "com.apple.Notes", notes_prepare, notes_new_note),
    ("mac.safari.follow-link", "com.apple.Safari", None, safari_follow_link),
    ("mac.finder.rename-file", "com.apple.finder", None, finder_rename_file),
    ("mac.textedit.edit-number", "com.apple.TextEdit", None, textedit_edit_number),
    ("mac.calendar.new-event", "com.apple.iCal", calendar_prepare, calendar_new_event),
]


def close_inspector(c, t):
    """Calendar's event inspector (or its quick event field, or its calendar menu), closed by escape while its event is
    still there: an inspector left open on a deleted event saved a new, untitled one in the default calendar when it was
    dismissed later. The one teardown part the driver does, since a key to Calendar by AppleScript needs System Events'
    grant too; when it cannot, the teardown fails, so the run says so."""
    target = {"app": t.app}
    for _ in range(3):
        r = c.call("ui.act", {"target": target, "steps": [{"key": "escape"}]})
        if "error" in r:
            raise Failed(f"escape: {r['error'].get('message')}")
        time.sleep(0.5)
        r = c.call("ui.observe", {"target": target})
        if "error" in r:
            raise Failed(f"ui.observe: {r['error'].get('message')}")
        nodes = r["result"].get("nodes", [])
        if find(nodes, id="calendar-button") is None and find(nodes, role="menuitem", name=NAME) is None:
            return
    raise Failed("the event's inspector is still open after escape")


def remove_files():
    """The task's folders under the root, then the root once nothing else is in it. The root is the run's (the sweep
    removed any earlier one), so the .DS_Store Finder writes there goes with it."""
    for n in os.listdir(ROOT) if os.path.isdir(ROOT) else []:
        if n.startswith(NAME):
            shutil.rmtree(os.path.join(ROOT, n))
    if os.path.isdir(ROOT) and set(os.listdir(ROOT)) <= {".DS_Store"}:
        shutil.rmtree(ROOT)


def teardown(t):
    """The task's sandbox, removed by plain scripting on a connection of its own (the task's may be stuck in a call):
    the windows and tabs on its files, its calendar, its Notes folder and their notes, its files. Each part runs even
    when one before it failed; the failures come back in words."""
    failed = []
    c = Client()
    try:
        parts = [("close the event's inspector", lambda: close_inspector(c, t))] if t.inspector else []
        parts += [
            ("close the windows and tabs on the task's files", lambda: osa(c, CLOSE_WINDOWS, ROOT, NAME)),
            ("delete the task's calendar and its events", lambda: osa(c, REMOVE_CALENDARS, NAME, event_title(RUN))),
            ("delete the task's Notes folder and its notes", lambda: osa(c, REMOVE_FOLDERS, NAME)),
            ("delete the task's files", remove_files),
        ]
        for words, part in parts:
            t.say(f"teardown: {words}")
            try:
                part()
            except Exception as e:
                failed.append(f"{words}: {e}")
    finally:
        c.close()
    return failed


def quit_apps(apps, seconds=15):
    """Apps the run started, quit by the driver (an Apple event to quit would itself need the grant), on a connection of
    their own, and waited for: the ones still running after that, by name."""
    if not apps:
        return []
    c = Client()
    try:
        for app in apps:
            try:
                refused = c.call("apps.terminate", {"id": app}).get("error")
            except Exception as e:
                refused = e
            if refused:
                print(f"  (could not quit {APPS[app]}, which the run started: {refused})", flush=True)
    finally:
        c.close()
    deadline = time.monotonic() + seconds
    while True:
        still = [app for app in apps if app in running()]
        if not still or time.monotonic() > deadline:
            return [APPS[app] for app in still]
        time.sleep(0.5)


def encode(timeline, path):
    """The movie, by frames-to-movie.swift (AVFoundation, so nothing to install beyond Xcode)."""
    try:
        done = subprocess.run(["swift", os.path.join(here, "frames-to-movie.swift"), timeline, path], capture_output=True, text=True, timeout=600)
    except Exception as e:
        return f"not made: {e!r}"
    if done.returncode != 0:
        return f"not made: {(done.stderr or done.stdout).strip()[-400:]}"
    return path


shield = {"on": False, "asked": None}


@contextlib.contextmanager
def shielded():
    """A setup that makes something and removes it again: a stop signal that comes during it waits for it to finish,
    as one during a teardown does, and the run then stops."""
    shield["on"] = True
    try:
        yield
    finally:
        shield["on"] = False
        # Also when the setup failed: the stop asked for wins over its error.
        if shield["asked"]:
            raise KeyboardInterrupt(shield["asked"])


def stop(signum, frame):
    """Ctrl-C, SIGTERM and SIGHUP stop the run, so the teardown runs. One that comes during a teardown waits for it to
    finish, and the run then stops."""
    name = signal.Signals(signum).name
    if shield["on"]:
        shield["asked"] = name
        print(f"  ({name}: the teardown finishes first)", flush=True)
        return
    raise KeyboardInterrupt(name)


LOCK = "/private/tmp/agentrun-demos.lock"


def lock():
    """One run at a time on a Mac: a second one's sweep would remove the first one's sandboxes. The lock goes with the
    process, so a killed run holds nothing. /private/tmp is shared: the file is opened without following a link and
    without truncating, and must be this user's own."""
    try:
        fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError as e:
        sys.exit(f"the lock {LOCK}: {e}")
    f = os.fdopen(fd, "r+")
    if os.fstat(fd).st_uid != os.getuid():
        sys.exit(f"the lock {LOCK} belongs to another user: remove it, then run this again")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("another mini-demos.py run is going on this Mac: run this again when it ends")
    return f


def main():
    for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, stop)
    held = lock()
    c = Client()
    hello = c.call("hello", {"client": "mini-demos"}).get("result") or {}
    print(f"Computerd on {hello.get('device', {}).get('model')}, macOS {hello.get('osVersion')}, features {json.dumps(hello.get('features'))}", flush=True)
    print(f"run {RUN}: sandboxes named {NAME!r}", flush=True)
    # The apps not running before the run are the run's own: started for the grants and the sweep, quit after it, started
    # again by their own task and quit at the end of its teardown, so no window of theirs sits in front of a later task.
    # An app that was running before the run (a person's) is left as it is.
    started = [app for app in APPS if app not in running()]
    report = []
    interrupted = None
    cropper = None
    try:
        for app in started:
            c.call("apps.launch", {"id": app, "background": True})
        if "--ask-grants" in flags:
            for app, words in can_automate(c, ask=True).items():
                print(f"Computerd, {app}: {words}")
            sys.exit(0)
        answers = can_automate(c)
        print("grants: " + ", ".join(f"{what} {words}" for what, words in answers.items()), flush=True)
        missing = {what: words for what, words in answers.items() if words != "granted"}
        if missing:
            names = ", ".join(f"{what} ({words})" for what, words in missing.items())
            sys.exit(f"Computerd lacks grants the sandbox needs: {names}. The sandbox is made and removed by AppleScript: "
                     "run this again with --ask-grants while a person is at the Mac to answer the prompts (System Settings > "
                     "Privacy & Security > Automation and > Calendars list them after).")

        if os.path.isdir(out):
            shutil.rmtree(out)
        os.makedirs(out)
        sweep(c)
        still = quit_apps(started)
        if still:
            raise Failed(f"{', '.join(still)}, which the run started, did not quit after the sweep")
        if movie:
            cropper = Cropper()
        for tid, app, prepare, drive in TASKS:
            if only and tid not in only:
                continue
            t = Task(c, tid, app, cropper)
            os.makedirs(t.folder, exist_ok=True)
            print(f"{tid} ({APPS[app]})", flush=True)
            if t.rec:
                t.rec.start()
                time.sleep(0.5)
            error, left = None, []
            try:
                if prepare:
                    prepare(t)
                before = snapshot(c)
            except BaseException as e:
                error, before = f"before the task: {e!r}", None
                if isinstance(e, KeyboardInterrupt):
                    interrupted = e
            if before is not None:
                try:
                    drive(t)
                except Failed as e:
                    error = str(e)
                except BaseException as e:
                    error = repr(e)
                    if isinstance(e, KeyboardInterrupt):
                        interrupted = e
                finally:
                    shield["on"] = True
                    try:
                        if error is not None and not interrupted:
                            print(f"  {error}")
                            t.dump()
                        failed = teardown(t)
                        if failed:
                            error = "; ".join(([error] if error else []) + [f"teardown: {f}" for f in failed])
                        try:
                            left = settle(c, before, app if app in started else None)
                        except Exception as e:
                            left = [f"no snapshot after the task: {e}"]
                        # After the snapshot, which was taken with the app as it was in the one before.
                        if app in started:
                            t.say(f"teardown: quit {APPS[app]}, which the run started")
                            try:
                                left += [f"{name}, which the run started, did not quit" for name in quit_apps([app])]
                            except Exception as e:
                                left.append(f"could not quit {APPS[app]}: {e}")
                    finally:
                        shield["on"] = False
                    if shield["asked"]:
                        interrupted = KeyboardInterrupt(shield["asked"])
                        error = error or f"stopped by {shield['asked']}"
            elif app in started:  # the setup failed, so there is no snapshot to compare, but the app still quits
                try:
                    left += [f"{name}, which the run started, did not quit" for name in quit_apps([app])]
                except Exception as e:
                    left.append(f"could not quit {APPS[app]}: {e}")
            took =round((time.monotonic() - t.t0) * 1000)
            if t.rec:
                t.say("passed" if error is None else "failed")
                time.sleep(1)
                timeline = t.rec.finish()
                frames = len(t.rec.frames)
                t.movie = encode(timeline, os.path.join(out, f"{tid}.mp4")) if frames else "not made: no frame of the task's window"
            else:
                t.movie, frames = "not made: no --movie", 0
            acts = [x for x in t.calls if x["method"] == "ui.act"]
            ui_ms = sum(x["ms"] for x in t.calls if x["method"] in ("ui.act", "ui.observe"))
            entry = {
                "id": tid, "app": APPS[app], "ok": error is None, "error": error, "left": left, "ms": took, "uiMs": ui_ms,
                "acts": len(acts), "steps": sum(len(x["params"].get("steps", [])) for x in acts),
                "observes": sum(1 for x in t.calls if x["method"] == "ui.observe"),
                "frames": frames, "movie": t.movie, "notes": t.notes, "calls": t.calls,
            }
            if t.rec:
                entry["framesDropped"] = t.rec.dropped
                entry["paintedOver"] = t.rec.painted
                if t.rec.errors:
                    entry["recorderErrors"] = t.rec.errors[:5]
            report.append(entry)
            dropped = f" (not kept: {', '.join(f'{n} {why}' for why, n in t.rec.dropped.items()) or 'none'})" if t.rec else ""
            print(f"{'PASS' if error is None else 'FAIL'} {tid}: {took} ms, {entry['acts']} acts, {entry['steps']} steps, {frames} frames{dropped}, movie {t.movie}" + (f"\n  {error}" if error else ""), flush=True)
            if t.rec and t.rec.errors:
                print(f"  recorder: {'; '.join(t.rec.errors[:3])}", flush=True)
            if t.rec and t.rec.painted:
                print(f"  painted over: {json.dumps(t.rec.painted)}", flush=True)
            print(f"  left: {json.dumps(left)}", flush=True)
            if interrupted:
                break
    finally:
        # Any app the run started that still runs (a run stopped before its task's teardown) quits too.
        try:
            still = quit_apps([app for app in started if app in running()])
            if still:
                print(f"  ({', '.join(still)}, which the run started, did not quit)", flush=True)
        except Exception as e:
            print(f"  (could not quit the apps the run started: {e})", flush=True)
        if cropper:
            cropper.close()
        c.close()
        os.unlink(LOCK)
        held.close()

    with open(os.path.join(out, "demos.json"), "w") as f:
        json.dump(report, f, indent=1)
    lines = ["| Task | App | Result | Left behind | ui.act calls | Steps | ui ms | Task ms | Each call (ms) |", "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |"]
    for e in report:
        each = ", ".join(f"{x['method'].split('.')[-1]} {x['ms']}" for x in e["calls"] if x["method"].startswith("ui."))
        result = "pass" if e["ok"] else "FAIL: " + (e["error"] or "")[:200].replace("|", "/")
        lines.append(f"| {e['id']} | {e['app']} | {result} | {'; '.join(e['left']).replace('|', '/') or 'nothing'} | {e['acts']} | {e['steps']} | {e['uiMs']} | {e['ms']} | {each} |")
    passed = sum(1 for e in report if e["ok"])
    left = sum(len(e["left"]) for e in report)
    line = f"{passed}/{len(report)} pass, {left} left behind"
    table = "\n".join(lines) + "\n\n" + line + "\n"
    with open(os.path.join(out, "demos.md"), "w") as f:
        f.write(table)
    print(table, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("### Demo tasks\n\n" + table)
    if interrupted:
        sys.exit(130)
    sys.exit(0 if passed == len(report) and left == 0 else 1)


main()
