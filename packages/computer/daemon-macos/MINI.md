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

   The last line is `PASS` or `FAIL`.

`--conformance` then runs the protocol's ui conformance cases too (`scripts/ui-conformance.sh`, the same as CI). These
need Node 24; the script runs `npm ci` and builds `packages/computer`.

Run the script again after every `git pull`. The second run skips the identity and the grants and prints PASS in a
few minutes.

## The two grants (a person, once)

Connect with Screen Sharing (`vnc://<mini's tailnet name>`). In the Computerd window:

1. **Click each Allow….** Each one adds Computerd to its list and opens its pane.
2. **Privacy & Security > Accessibility:** switch Computerd on. This also covers Post Event.
3. **Privacy & Security > Screen & System Audio Recording:** switch Computerd on.
4. **The window closes itself** once every grant is on, so it never covers the windows the demos work in.
5. **Menu bar ⌘D > Grants and Pairing…, then Raise it now,** and answer Allow. The screen capture alert then never
   appears in the middle of a task. A window opened this way stays until you close it.

The script notices the grants and goes on to the smoke check by itself. Opened by a person instead of the script, the
window also waits for pairing: it closes once the Mac is paired, or after **Not now**.

## The demo tasks

Five tasks, one per built-in app. They use the computer bench's mac-dev ids, so they become the bench's mac suite and
the script for live QA's bundle 3. Each one is driven by `ui.observe` and `ui.act`, with its steps batched in one call
where a person would do them in one go. It is checked through `ui.observe` or the file system, and needs no
Automation grant.

| Task | App | What it does | How it is checked |
| --- | --- | --- | --- |
| mac.notes.new-note | Notes | press Continue on a first-run sheet, then super+n, type a title and a line, in one call | the note's line, then its title in the list |
| mac.safari.follow-link | Safari | open a local page in the background, press the "Quarterly report" link by its ref, then super+[ to come back | the linked page's heading, then the first page's link |
| mac.finder.rename-file | Finder | open a folder in the background, show it as a list, select draft.txt by its element, then set its name field to final.txt (or enter, type "final", enter, where Finder takes no set) | the folder holds final.txt and other.txt |
| mac.textedit.edit-number | TextEdit | open totals.txt in the background, set the text to 42 and save with super+s, in one call | the saved file is the new text, the other lines kept |
| mac.calendar.new-event | Calendar | press Add Event, then type a title into the quick event field and enter, in one call | the event's title on the calendar, and gone after Delete |

```sh
python3 -I packages/computer/daemon-macos/scripts/mini-demos.py \
  /Applications/Computerd.app/Contents/Helpers/computerd "$HOME/Library/Application Support/Computerd" /tmp/demos
```

It writes these files under `/tmp/demos`:

- `<task>.mp4`: the task recorded from `screen.watch`, with the current step written along the bottom. `frames-to-movie.swift` makes it, with AVFoundation, so Xcode is all it needs.
- `demos.json`: every call with its latency in ms, the routes its steps took, and its expect.
- `demos.md`: the table of tasks, calls, steps and ms.

Name one or more task ids to run only those. `--keep` leaves the note, event and files the tasks made. CI runs all
five after the ui conformance cases, and reports them without failing the run.

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
