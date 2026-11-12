# mac-dev

Twenty tasks on an attached macOS 26 Mac, driven by Computerd.app in the user's GUI session: Notes, Calendar, Finder,
Safari, TextEdit, System Settings and Reminders, two of them across two apps. Ten are `dev`, ten `heldout`; every app has
tasks in both splits.

Each task makes what it needs under a name holding its `{{nonce}}` (a note title, a calendar or list name, a folder
`~/Documents/computer-bench-<nonce>/` or `/tmp/computer-bench-<nonce>/`), so runs on the shared Mac never meet each
other's leftovers. Setup starts from the opposite of the goal (a settings task writes the other value first), and
teardown deletes what setup and the agent made. Settings tasks keep the Mac's own value under
`/tmp/computer-bench-<nonce>/` at setup and put it back at teardown. Longer AppleScript lives beside `task.json` and is
inlined with `{{file:NAME}}`; each script takes a mode (`start`, `count`, `teardown`, ...) as its argument.

| id | app | split | what the checks read | confidence |
| --- | --- | --- | --- | --- |
| mac.notes.new-note | Notes | dev | Notes: count of live notes with the title; the note's plaintext lines | verify live |
| mac.notes.append-line | Notes | heldout | Notes: count of live notes; the note's plaintext lines, in order | verify live |
| mac.notes.move-to-folder | Notes | dev | Notes: the note's `container` name; its plaintext lines | verify live |
| mac.calendar.new-event | Calendar | dev | Calendar: count of events by summary in the task's calendar; start date, end date, allday event | verify live |
| mac.calendar.move-event | Calendar | heldout | Calendar: count of events; start date and length, day relative to today | verify live |
| mac.calendar.set-location | Calendar | heldout | Calendar: count of events; location; start date and length | verify live |
| mac.finder.rename-file | Finder | dev | shell: the new file's text, the old name gone, the other file kept | sure |
| mac.finder.sort-into-folder | Finder | heldout | shell: `ls` of the new folder and of the top folder | sure |
| mac.finder.color-tag | Finder | dev | AppleScriptObjC: NSURLTagNamesKey of the target and of the other files | verify live |
| mac.safari.open-page | Safari | dev | Safari: URL of the front window's current tab (www.iana.org) | verify live |
| mac.safari.follow-link | Safari | heldout | Safari: URL of the front window's current tab (a file:// site in /tmp) | verify live |
| mac.safari.copy-to-note | Safari + Notes | heldout | Notes: count of live notes; the note's plaintext lines | verify live |
| mac.textedit.new-file | TextEdit | dev | shell: the saved file's bytes | sure |
| mac.textedit.edit-number | TextEdit | heldout | shell: the changed line; the whole file against a pristine copy | sure |
| mac.textedit.copy-to-note | TextEdit + Notes | dev | Notes: count of live notes; plaintext lines. shell: the source file unchanged | verify live |
| mac.settings.dock-autohide | System Settings | dev | `defaults read com.apple.dock autohide` | sure |
| mac.settings.dock-position | System Settings | heldout | `defaults read com.apple.dock orientation` | sure |
| mac.settings.dark-mode | System Settings | heldout | System Events `dark mode`; `defaults read -g AppleInterfaceStyleSwitchesAutomatically` | verify live |
| mac.reminders.new-reminder | Reminders | dev | Reminders: count of reminders by name in the task's list; priority, completed | verify live |
| mac.reminders.complete-item | Reminders | heldout | Reminders: completed flags of the target and the others; count of reminders | verify live |

What "verify live" waits on, per app:

- Notes: whether `every note` lists notes in Recently Deleted, whether a second `delete` empties them from there, and
  that `name of container` reads "Recently Deleted" for them. The checks count only notes outside Recently Deleted, so
  a re-run of the same seed depends on that name.
- Calendar: `make new calendar` and `delete calendar` over AppleScript, which have failed on some macOS releases.
- Finder tags: the AppleScriptObjC call to NSURL's tag names from `osascript -e`, and English tag names.
- Safari: open-page needs www.iana.org reachable and its four paths unchanged; follow-link and copy-to-note need Safari
  to open file:// pages in /tmp from `make new document`.
- Appearance: System Events `set dark mode` while the Auto key is deleted under it.
- Reminders: `make new list` and `delete list` in the local account, and the priority values (1 high, 5 medium, 9 low).

## Grants the suite needs

- Automation (Apple Events) from Computerd.app, whose children run `osascript`, to Notes, Calendar, Reminders, Finder,
  Safari, TextEdit, System Events and System Settings.
- Files & Folders: the Documents folder for Computerd.app (setup, checks and teardown read and write
  `~/Documents/computer-bench-<nonce>/`).
- Accessibility and Screen Recording for Computerd.app: the agent's pointer, keys and screenshots.
- Network: www.iana.org reachable from the Mac (mac.safari.open-page only).
- Accounts: none. Notes, Calendar and Reminders use the Mac's local account ("On My Mac"); Notes' default account has
  a folder named "Notes". Each app has been opened once so no first-run sheet is up.
- Language: English, for the names the checks compare ("Notes", "Recently Deleted", tag colours).
