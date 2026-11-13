# The Mac mini

A Mac mini runs Computerd for the bench's mac suite, live QA and demos. Its setup is one script,
`scripts/mini-bootstrap.sh`, which does every step a script can do. A person still has to switch on two grants in
System Settings, once.

The bench's mini is an M2 Mac mini (Mac14,3) with 8 GB, running macOS 27.2 (26B123) and Xcode 27.2 (Swift 6.4.2).
Its auto-login user is `parchamonitor`.

## The Mac, set up once by hand

The script assumes:

- **macOS 26 or later, and Xcode 26 or later.** After installing Xcode:

  ```sh
  sudo xcode-select -s /Applications/Xcode.app
  sudo xcodebuild -license accept
  xcodebuild -runFirstLaunch
  ```

- **SSH over Tailscale.** Turn on System Settings > General > Sharing > Remote Login and Screen Sharing. Install
  Tailscale and log the Mac in to the tailnet. Screen Sharing is how a person reaches the Mac to switch on the grants.
- **An auto-login user**, the one that runs Computerd and the script (an admin, so it can write to /Applications). Set
  it in Users & Groups > Automatically log in as. Auto-login needs FileVault off.
- **No sleep and no screen lock**, so the desktop is always there to drive:

  ```sh
  sudo pmset -a sleep 0 displaysleep 0 disksleep 0
  ```

  In Lock Screen, set "Start Screen Saver when inactive" and "Turn display off when inactive" to Never, and "Require
  password after screen saver begins or display is turned off" to Never.
- **A display.** A headless mini picks a small default screen. An HDMI dummy plug at 1920x1080 gives a stable screen
  size, so the bench's screenshots and coordinates stay the same from run to run.
- **Node 24** (24.22.3), only for `--conformance`.

## Bootstrap

Over SSH, as the auto-login user:

```sh
git clone https://github.com/Parcha-ai/agentrun.git && cd agentrun
packages/computer/daemon-macos/scripts/mini-bootstrap.sh
```

The script:

1. **Checks the Mac.** It needs macOS 26 or later, Xcode selected, and the auto-login user on the desktop.
2. **Makes the signing identity, the first time only** (`scripts/local-identity.sh`). This is a self-signed code signing certificate, "Computerd Local
   Signing", in a keychain of its own (`~/Library/Keychains/computerd-signing.keychain-db`). The keychain's password is
   in `~/.computerd-signing/keychain-password` (0600). The key lets codesign use it with no dialog, so signing works over
   SSH. The certificate is not trusted system-wide and does not need to be.
3. **Builds Computerd.app and UIFixture.app, signed with that identity.** The app's designated requirement then names
   the certificate (`certificate leaf = H"…"`, or `root`), not this build. macOS keeps the Accessibility and Screen
   Recording grants across every rebuild. An ad-hoc build loses them each time.
4. **Installs both in /Applications.** A Computerd window still open (an old build's) goes first; the agent keeps
   running. Each bundle is swapped in whole, then registered with Launch Services, so `apps.list` and `apps.launch`
   see them at once.
5. **Loads the LaunchAgent.** It is a plain user agent, `~/Library/LaunchAgents/ai.parcha.computerd.plist`, that runs
   `/Applications/Computerd.app/Contents/MacOS/Computerd` in the desktop session, at login and again whenever it ends.
   The first run writes it and runs `launchctl bootstrap`; later runs find it in place and only `launchctl kickstart
   -k` it onto the new build. The agent serves `~/Library/Application Support/Computerd/computerd.sock`. The app writes
   the same plist when a person opens it, and its window's **Remove** unloads it and deletes it. macOS lists it under
   System Settings > General > Login Items & Extensions > Allow in the Background, as Computerd.
   It is not registered through SMAppService: that records a launch constraint, which for a self-signed build names
   the very build that registered, so launchd killed every rebuild at spawn ("Launch Constraint Violation", exit 78
   "needs LWCR update"), and unregistering and registering again kept the old one.
6. **Opens Computerd's grants window** (`--until-granted`), which closes itself once every grant is on.
7. **Checks the grants.** If `ui.tree`, `ui.image`, `ui.foreground` or `ui.background` is off, it prints why and opens
   the Accessibility and Screen Recording panes. It waits up to 15 minutes for a person, restarting the agent every
   30 s so a new grant takes hold.
8. **Runs the smoke check** (`scripts/smoke.py`, strict). This covers:
   - Core: hello, exec, files and apps.
   - The socket's peer check.
   - TextEdit driven in the background.
   - The ui fixture, including its canvas click.
   - `input.actions`: a click and typed text on the fixture's input window (`UIFixture --input-log`), read back from
     its log.

   The last line is `PASS` or `FAIL`.

`--conformance` then runs the protocol's ui and input conformance cases too (`scripts/ui-conformance.sh`, the same as
CI; the input cases use the fixture's input window). These
need Node 24; the script runs `npm ci` and builds `packages/computer`.

Run the script again after every `git pull`. The second run skips the identity and the grants and prints PASS in a
few minutes.

## The two grants (a person, once)

Connect with Screen Sharing (`vnc://<mini's tailnet name>`). The Computerd window shows a Computerd tile for each
System Settings pane that gives a grant, and opens the first pane still missing beside it:

1. **Drag the tile into the pane's list** (Privacy & Security > Accessibility, called Device Control and Data Access
   on macOS 27). Its rows tick, Accessibility and Post Event, and the next pane opens.
2. **Drag the other tile into that list** (Privacy & Security > Screen & System Audio Recording). A click on a tile opens
   its pane again.
3. **The window says every grant is in and closes itself,** so it never covers the windows the demos work in.
4. **Menu bar ⌘D > Grants and Pairing…, then Raise it now,** and answer Allow. The screen capture alert then never
   appears in the middle of a task. A window opened this way stays until you close it.

The script notices the grants and goes on to the smoke check by itself. Opened by a person instead of the script, the
app shows its onboarding window once the grants are in, which waits for pairing: it closes once the Mac is paired, or
after **Not now**.

## The demo tasks

Five tasks, one per built-in app. They use the computer bench's mac-dev ids, so they become the bench's mac suite and
the script for live QA's bundle 3. Each one is driven by `ui.observe` and `ui.act`, with its steps batched in one call
where a person would do them in one go.

The mini is a person's own Mac with their own calendars, notes and files, so **a task leaves nothing behind and never
touches anything it did not make.** Each task works in a sandbox named `AgentRun demo <run id>`: its own Calendar
calendar, its own Notes folder, or its own folder under `/private/tmp/agentrun-demos`. Its window is found by its title
and named in every call, so a person's own windows of the same app are never the target. AppleScript makes the
sandbox and removes it, through Computerd's `exec.run`, not through the driver, so a broken driver cannot stop the
cleanup. The teardown runs however the task ends (pass, failure, exception, Ctrl-C, SIGTERM; a stop signal during a
teardown waits for it to finish). The calendar task's first teardown step is a driver step: escape closes Calendar's
event inspector while its event is still there, since an inspector left open on a deleted event saves a new,
untitled one when it is dismissed. The teardown then closes the windows and tabs on the task's files, and deletes the
task's calendar, its Notes folder and their notes (Recently Deleted too), and its files. A run starts by sweeping any
`AgentRun demo` sandbox an earlier run left, for example one killed in the middle of a task, along with that run's
event if it was still in the default calendar. Only one run goes at a time on a Mac (a lock in `/private/tmp`), so a
sweep never removes a live run's sandbox.

Before each task the script takes a snapshot of what it can see. That's every calendar with its count of today's
events, every Notes folder with its count of notes, the five apps' onscreen windows by id, and the sandbox root. It
reads names, counts and ids, never what an event, note or file holds. After the teardown it takes the snapshot again,
and any difference is the task's `left`. The run's last line is `5/5 pass, 0 left behind` only when every task passed
and left nothing; otherwise it exits 1. The observations it writes have every name and value redacted to its length,
unless it holds the run id or is a word the script looks for.

| Task | App | What it does | How it is checked |
| --- | --- | --- | --- |
| mac.notes.new-note | Notes | press Continue on a first-run sheet; open the task's folder by its cell; super+n, then type a title and a line, in one call | the note's line, its title in the list, and the folder holding it |
| mac.safari.follow-link | Safari | open the task's local page in the background, press the "Quarterly report" link by its ref, then the toolbar's Back button by its ref | the linked page's heading, then the first page's link |
| mac.finder.rename-file | Finder | open the task's folder in the background, show it as a list, select draft.txt by its element, then rename it: enter, type "final", enter in the background, else the same with Finder brought forward. A file's name is an item that opens, not a field, so the driver refuses a set on it. Each way is judged by the disk, and the notes say which one renamed it | the folder holds final.txt and other.txt |
| mac.textedit.edit-number | TextEdit | open the task's totals file in the background, select all and type the text with 42, by keys first (the window marks it Edited), then save with super+s (the mark goes) | the saved file is the new text, the other lines kept |
| mac.calendar.new-event | Calendar | press Add Event, type a title into the quick event field and enter; move the event into the task's calendar through the inspector's calendar menu; enter in its title saves it (escape there dropped a new event on macOS 26) | the task's calendar holds the event |

The sandbox needs two kinds of grant for Computerd. One is Automation for Calendar, Notes, Finder, TextEdit and Safari.
The other is full access to calendars: Calendar's AppleScript reads the calendar store for the process that sent the
event, and without the grant a script that counts events gets no answer. Without them the script says which are
missing and stops before it starts a task. To grant them, run the script once with `--ask-grants` while you are at the
Mac and answer **OK** or **Allow** to each of the six prompts. They are listed afterwards in System Settings > Privacy &
Security > Automation > Computerd and > Calendars. CI's runner has them seeded (`scripts/seed-tcc.sh`).

```sh
python3 -I packages/computer/daemon-macos/scripts/mini-demos.py \
  /Applications/Computerd.app/Contents/Helpers/computerd "$HOME/Library/Application Support/Computerd" /tmp/demos
```

It writes these files under `/tmp/demos`:

- `<task>.mp4`, only with `--movie`: the task recorded from `screen.watch`, with the current step written along the bottom. `frames-to-movie.swift` makes it, with AVFoundation, so Xcode is all it needs. Each frame is cut to the task's window before it is written (`window-frames.swift`), and every window in front of it is painted black, but for the Dock's own window, which covers the display at the Dock's level and is clear but for the Dock (anything the Dock draws in it, Mission Control's thumbnails say, would show); a frame taken while the window moved, or while a window came in front or left, is not kept. The cut keeps the task's window whole, so in Notes, Calendar and Safari it shows the app's own lists (a person's folders, events and tabs). Without `--movie` nothing is recorded.
- `demos.json`: every call with its latency in ms, the routes its steps took, its expect, and what each task left.
- `demos.md`: the table of tasks, calls, steps, ms and what each left, then the run's line.

Name one or more task ids to run only those. CI runs all five with `--movie` after the ui conformance cases, and
reports them without failing the run. On CI (`CI=true`) the observations are not redacted: the runner holds nothing of a
person's.

A fresh Mac's first-run state is answered in each task's setup, before its snapshot, never in its steps: Notes' and
Calendar's first-run sheets are pressed away; a Notes that showed its Welcome sheet gets a setup folder made and removed
again, so the "Turn On iCloud" alert it raises the first time anything is made is answered Cancel there; and Calendar's
setup types into its quick event field and cancels it with escape before any event is made, since a fresh Calendar adds
its own Scheduled Reminders calendar when that field first reads what is typed, then reads the list of calendars until
it is still for 8 s.

## When something is off

- **`computerd hello`** (`/Applications/Computerd.app/Contents/Helpers/computerd hello`) lists each feature, and each
  one that is off says why.
- **The agent's state:** `launchctl print gui/$(id -u)/ai.parcha.computerd` should say `state = running`. If it is not
  loaded, run the script again, or by hand: `launchctl bootstrap gui/$(id -u)
  ~/Library/LaunchAgents/ai.parcha.computerd.plist`. If Login Items & Extensions has Computerd switched off under
  Allow in the Background, switch it on. The LaunchAgent lines of `~/Library/Logs/Computerd.log` say what the app did.
- **The signature:** `codesign --display --requirements - /Applications/Computerd.app`. The designated requirement must
  name the certificate. If it says `cdhash`, the build was signed ad hoc and its grants won't carry over.
- **Grants that went stale**, for example after the identity was made again: `tccutil reset All ai.parcha.computerd`,
  then run the script and grant again.
- **A new identity:** delete `~/Library/Keychains/computerd-signing.keychain-db` and `~/.computerd-signing`, run the
  script, and grant again. The old grants named the old certificate.

This identity is for this Mac only. Builds for other Macs are signed with the Developer ID and notarized.
