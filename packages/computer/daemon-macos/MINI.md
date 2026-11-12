# The Mac mini

A Mac mini runs Computerd for the bench's mac suite, live QA and demos. Its setup is one script,
`scripts/mini-bootstrap.sh`, which does every step a script can do. A person still has to switch on two grants in
System Settings, once.

## The Mac, set up once by hand

The script assumes:

- **macOS 26 and Xcode 26.** After installing Xcode:

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
4. **Installs both in /Applications.** Each is swapped in whole, then registered with Launch Services, so `apps.list`
   and `apps.launch` see them at once.
5. **Opens Computerd.** This registers its LaunchAgent, which serves `~/Library/Application Support/Computerd/computerd.sock`.
   The script then restarts the agent on the new build.
6. **Checks the grants.** If `ui.tree`, `ui.image`, `ui.foreground` or `ui.background` is off, it prints why and opens
   the Accessibility and Screen Recording panes. It waits up to 15 minutes for a person, restarting the agent every
   30 s so a new grant takes hold.
7. **Runs the smoke check** (`scripts/smoke.py`, strict). This covers:
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
4. **Click Raise it now** and answer Allow. The screen capture alert then never appears in the middle of a task.

The script notices the grants and goes on to the smoke check by itself.

## When something is off

- **`computerd hello`** (`/Applications/Computerd.app/Contents/Helpers/computerd hello`) lists each feature, and each
  one that is off says why.
- **The agent's state:** `launchctl print gui/$(id -u)/ai.parcha.computerd`. If it is not loaded, allow Computerd in
  System Settings > General > Login Items & Extensions.
- **The signature:** `codesign --display --requirements - /Applications/Computerd.app`. The designated requirement must
  name the certificate. If it says `cdhash`, the build was signed ad hoc and its grants won't carry over.
- **Grants that went stale**, for example after the identity was made again: `tccutil reset All ai.parcha.computerd`,
  then run the script and grant again.
- **A new identity:** delete `~/Library/Keychains/computerd-signing.keychain-db` and `~/.computerd-signing`, run the
  script, and grant again. The old grants named the old certificate.

This identity is for this Mac only. Builds for other Macs are signed with the Developer ID and notarized.
