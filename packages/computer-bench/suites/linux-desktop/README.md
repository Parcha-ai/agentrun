# linux-desktop

Ten tasks on a Linux desktop (`needs: {os: "linux", kind: "desktop"}`): a text editor (Mousepad), a terminal
(xfce4-terminal), a file manager (Thunar), a browser (Firefox), and two tasks that cross two apps. Five dev, five
heldout. Every task is `exec: "deny"`: the agent gets the screen and input, not a shell on the computer. Setup, checks and
teardown use the bench's own channel (`exec.run`, `process.start`, `files.read`); every oracle is `input.actions` only
(typing and keyboard shortcuts).

| id | app | split | what the checks read |
|---|---|---|---|
| linux.editor.new-note | Mousepad, its Save As dialog | dev | the saved file's text |
| linux.editor.edit-config | Mousepad | heldout | the saved config's five lines (two changed, three kept) |
| linux.editor.replace-word | Mousepad | heldout | the saved memo's four lines (all three uses replaced) |
| linux.terminal.count-errors | xfce4-terminal | dev | the count file's text (lower-case "error" WARN lines are decoys) |
| linux.terminal.git-email | xfce4-terminal, git | heldout | `git config --local --get user.email` of the run's repository |
| linux.files.rename | Thunar | dev | `ls -1` of the run's folder, and the renamed file's text |
| linux.files.move | Thunar | heldout | every file under the run's folder with its text, in byte order |
| linux.browser.sign-form | Firefox | dev | the guest book file the page's server appends each signature to |
| linux.cross.terminal-to-note | xfce4-terminal, Mousepad | dev | the saved note: the data file's size, picked per seed |
| linux.cross.page-to-note | Firefox, Mousepad | heldout | the saved note: the asked order's code, which holds the run's nonce and is only on the page |

The terminal tasks are `exec: "deny"` too: the agent types into the terminal window like a person; it gets no
`exec.run` of its own.

## Proven live

`computer-bench verify` on E2B Desktop, seeds 1, 2 and 3, on 2026-11-14: 30 of 30 right (after setup alone every check
fails; after setup and the oracle every check passes), 60 desktops, each episode on its own desktop. The kit is a frozen
folder outside the repository (`bench2-verify-e2b-2`) that runs `serve` and `computer-bench verify --backend serve` from
a pinned commit; verify holds a run and never starts its agent.

| task | seed 1 | seed 2 | seed 3 |
|---|---|---|---|
| linux.editor.new-note | right | right | right |
| linux.editor.edit-config | right | right | right |
| linux.editor.replace-word | right | right | right |
| linux.terminal.count-errors | right | right | right |
| linux.terminal.git-email | right | right | right |
| linux.files.rename | right | right | right |
| linux.files.move | right | right | right |
| linux.browser.sign-form | right | right | right |
| linux.cross.terminal-to-note | right | right | right |
| linux.cross.page-to-note | right | right | right |

What the two cross-app oracles prove: they know the answer (the size, the code), so they type it into Mousepad and save
without using the terminal or reading the page. They prove the check reads the saved note and that the editor's half
works with the two windows side by side; the first half is the agent's.

## No window manager

E2B Desktop runs the computer as uid 2510, which has no passwd entry. `dbus-daemon` refuses to start for it ("Could not
get password database information for UID of current process"), and xfwm4 does not start without Xfconf's session bus,
so no window manager runs there. The tasks are written for that:

- Setup places each window with xdotool: a one-app task's window fills the screen; a cross-app task puts the first app on
  the left half and Mousepad on the right half.
- X's focus follows the pointer when no window manager sets it, so setup puts the pointer on the window the agent types
  into first, and every instruction says "keys go to the window under the mouse pointer". Clicking a window does not
  raise it; the keys go to it because the pointer is on it.
- Dialogs (Mousepad's Save As, Thunar's Rename) open centred over their window, under the pointer. Save As is taller
  than E2B's 1280x800 screen, so its Save button is off screen; Enter in its name field saves.
- Windows have no frames: Mousepad and Firefox draw their own title bars, Thunar and the terminal have none.

The capability probes ask only for the apps and xdotool (`command -v`), so the suite runs on a desktop with a window
manager too.

## Reset

Every task makes its files under `/tmp/computer-bench-<nonce>` and teardown deletes it and kills the apps it opened
(`pkill -9`: Mousepad holds on to a changed document on TERM). Firefox runs on a fresh profile in the run's folder, with
first-run pages off (`user.js`). The two pages are served on 127.0.0.1 on a port picked per seed.
