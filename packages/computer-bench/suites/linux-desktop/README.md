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
| linux.terminal.git-email | xfce4-terminal, git | heldout | `git config --local --get user.email` of the run's repository, and the global `user.email` unchanged |
| linux.files.rename | Thunar | dev | `ls -1` of the run's folder, and the renamed file's text |
| linux.files.move | Thunar | heldout | every file under the run's folder with its text, in byte order |
| linux.browser.sign-form | Firefox | dev | the guest book file the page's server appends each signature to |
| linux.cross.terminal-to-note | xfce4-terminal, Mousepad | dev | the saved note: the data file's size, picked per seed |
| linux.cross.page-to-note | Firefox, Mousepad | heldout | the saved note: the asked order's code, which holds the run's nonce and is only on the page |

The terminal tasks are `exec: "deny"` too: the agent types into the terminal window like a person; it gets no
`exec.run` of its own.

A task's capability probe asks for its apps and xdotool (`command -v`); a desktop without them refuses the task.

## Proven live

`computer-bench verify` on E2B Desktop, seeds 1, 2 and 3, on 2026-11-14: after setup alone every check fails, and after
setup and the oracle every check passes, each episode on its own desktop. Two runs, 60 desktops each, 30 of 30 right in
both:

- on main at 9deeebf662 (after #2735), where E2B's desktop runs xfwm4;
- on main before #2735, where E2B's desktop ran no window manager (the tasks then lacked setup's `windowactivate`, which
  does nothing there).

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

The runs came from a frozen kit outside the repository that builds `serve` and the bench at a pinned commit and runs
`computer-bench verify --backend serve`: verify holds a run and never starts its agent, so no model is called.

What the two cross-app oracles prove: they know the answer (the size, the code), so they type it into Mousepad and save
without using the terminal or reading the page. They prove the check reads the saved note and that the editor's half
works with the two windows side by side; the first half is the agent's.

## Windows, with or without a window manager

Setup places each window with xdotool: a one-app task's window fills the screen; a cross-app task puts the first app on
the left half and Mousepad on the right half. Then it puts the pointer on the window the agent types into first and
activates it. A window manager gives the keys to the active window. With none, X gives them to the window under the
pointer, and activating fails quietly; dialogs (Mousepad's Save As, Thunar's Rename) then open centred over their window,
under the pointer, and clicking a window does not raise it.

Mousepad's Save As is taller than E2B's 1280x800 screen, so its Save button can be off screen; Enter in its name field
saves.

## Reset

Every task makes its files under `/tmp/computer-bench-<nonce>` and teardown deletes it and kills the apps it opened,
and only those: setup keeps each app's pid in `/tmp/computer-bench-<nonce>-<app>.pid` and teardown kills those pids
(KILL: Mousepad holds on to a changed document on TERM), so the Mousepad or terminal a desktop already had open stays.
Firefox runs on a fresh profile in the run's folder, with first-run pages off (`user.js`), and the run's Firefox and page
server are killed by patterns that name the run's folder. The two pages are served on 127.0.0.1 on a port picked per
seed.

`linux.terminal.git-email` keeps the global `user.email` setup found and checks it is unchanged at the end: setting the
address globally as well as in the repository fails.
