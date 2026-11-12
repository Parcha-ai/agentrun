# android-dev

Twenty tasks on an unrooted Android 14-16 phone, driven by phoned as adb's shell user (uid 2000). The agent gets `ui` and
`screen`; setup, checks, teardown and the oracle use the bench's own channel (`exec.run` and `am start` intents). Five
apps, ten dev and ten heldout, every app in both splits. Four tasks are information tasks: the agent answers in words and
an `answer` check reads the final answer. Two are sharing tasks (tagged `share` and `demo`), one per split: they go
through Chrome's share sheet, one into another app (Contacts) and one into the print service's Save as PDF.

| id | app | split | what the checks read | confidence |
|---|---|---|---|---|
| android.settings.dark-theme | Settings | dev | `cmd uimode night` | sure |
| android.settings.screen-timeout | Settings | dev | `settings get system screen_off_timeout` | sure |
| android.settings.device-name | Settings | dev | answer: the nonce name setup put in `global device_name` | verify live: About phone shows `Settings.Global.DEVICE_NAME` on AOSP and Pixel; Samsung keeps its own phone name |
| android.clock.set-alarm | Clock | dev | `dumpsys alarm`, "Next alarm clock information" | verify live: the dumpsys line format (AOSP's `yyyy-MM-dd HH:mm:ss.SSS`), and Google Clock's DISMISS_ALARM by label in teardown |
| android.clock.alarm-time | Clock | dev | answer: the alarm's time, AM/PM strict (a decoy alarm shares digits) | verify live: setup's SET_ALARM with SKIP_UI and teardown's DISMISS_ALARM on Google Clock |
| android.contacts.add-contact | Contacts | dev | `content query` of contacts and data rows by display name | verify live: a phone-local (no account) contact inserted by `content` as shell, and whether Google Contacts lists it |
| android.share.link-to-contact | Chrome, Contacts | dev | `content query` of the contact's website and phone rows, one read | verify live: as add-contact and read-page; the address Chrome's share sheet copies for `http://127.0.0.1:port/` (the check takes it with or without the scheme and slash) |
| android.files.rename-file | Files | dev | `ls -1` of the run's folder, `cat` of the file | sure |
| android.chrome.open-article | Chrome | dev | ui: a node named the article title, the address bar's value on wikipedia.org | verify live: how phoned's tree names Chrome nodes (heading text as name, the address bar's text as value) |
| android.chrome.read-page | Chrome | dev | answer: the code on a page setup serves on 127.0.0.1 | verify live: toybox `nc -L` on the vendor build, and Chrome's HTTPS upgrade and warnings for http://127.0.0.1 |
| android.settings.do-not-disturb | Settings | heldout | `settings get global zen_mode` | verify live: `cmd notification set_dnd` from shell under Android 15+ modes may need `cmd notification allow_dnd com.android.shell` first |
| android.settings.location | Settings | heldout | `cmd location is-location-enabled` | sure |
| android.settings.battery-level | Settings | heldout | answer: the level setup pinned with `dumpsys battery set level` | verify live: a vendor Battery page may read the fuel gauge, not BatteryService's set level |
| android.clock.alarm-off | Clock | heldout | `dumpsys alarm` next alarm clock, not at the alarm's time | verify live: as set-alarm; DISMISS_ALARM is also the oracle |
| android.clock.change-alarm | Clock | heldout | `dumpsys alarm` next alarm clock at the new time | verify live: as set-alarm |
| android.contacts.edit-phone | Contacts | heldout | `content query` of the contact's phone rows (new there, old gone) | verify live: same as add-contact; `content update` of a data row |
| android.contacts.add-email | Contacts | heldout | `content query` of the contact's email and phone rows, one read | verify live: same as add-contact |
| android.files.move-file | Files | heldout | `find . -type f \| sort` under the run's folder | sure |
| android.files.delete-file | Files | heldout | `ls -1` of the run's folder (a trashed file's `.trashed-` name is hidden) | sure |
| android.share.page-to-pdf | Chrome, print service | heldout | `head -c 4` of a `*<nonce>*.pdf` in Download or Documents | verify live: that the print dialog suggests the page's title as the name, and where the save dialog starts on each vendor; the oracle is a stand-in (below) |

## What the two rules rest on

- Every check fails after setup alone. No check is a guard that passes on the untouched state: a guard is folded into
  the check it guards (add-email and link-to-contact read the new row and the phone row together).
- After setup and the oracle every check passes, with three limits:
  - The four answer tasks (device-name, battery-level, alarm-time, read-page) have no oracle: an oracle is calls, and an
    answer isn't one. `verify` has to skip their answer checks or feed the answer the rubric's "Done means" names.
    Their nonce or pinned value makes the answer unknowable without reading the phone.
  - page-to-pdf's oracle writes a PDF header to the file the check looks for. No shell command makes Chrome print, so
    it proves the check reads a solved state, not that Chrome can print.
  - The Clock checks read AlarmManager's next alarm clock, which is the phone's soonest enabled alarm. They hold only on
    a phone with no other enabled alarm ringing sooner. A phone with one breaks both rules for set-alarm, alarm-off and
    change-alarm.
- Phone and package names differ by vendor, so setup opens apps by intent (`android.settings.SETTINGS`, `SHOW_ALARMS`,
  `CATEGORY_APP_CONTACTS`, `VIEW` of a DocumentsUI directory, `VIEW` with `-p com.android.chrome`), and `needs.apps`
  lists the Google, AOSP and Samsung packages of each app.
- The phone-harness probes of 2026-11-08 (`kinds/phone-probe-out`) ran a redroid 15 image with AOSP DeskClock,
  Contacts and DocumentsUI and no Chrome. The Chrome tasks need `com.android.chrome` installed; the rest name the AOSP
  packages too.

## Reset between tasks on an unrooted phone

There are no snapshots, and app-private data (`/data/data/...`) is out of reach, so each task undoes its own work and
names what it makes with `{{nonce}}` so a leftover can't meet a later run.

What teardown undoes:

- Settings: setup saves the phone's own value once per nonce to `/data/local/tmp/computer-bench-<nonce>.orig` (a
  retried setup keeps the first copy), and teardown puts it back and deletes the copy. That covers night mode, screen
  timeout, device name (deleted when it had none), Do Not Disturb (through `cmd notification set_dnd`, since
  ZenModeHelper reverts a plain `settings put`) and location. Battery: `dumpsys battery reset`.
- Contacts: every raw contact whose name holds the nonce is deleted. Phone-local ones go at once; one the agent saved
  to a Google account is marked deleted and its sync adapter removes it from the account.
- Files: `/sdcard/Download/computer-bench-<nonce>` goes, trashed files with it; page-to-pdf deletes `*<nonce>*.pdf`
  from Download and Documents.
- read-page, link-to-contact and page-to-pdf: the `nc` server on the run's port is killed and its files under
  `/data/local/tmp` deleted. Setup kills a server left on the same port first.

What it can't undo:

- Clock alarms live in the Clock app's private database, and the shell can't delete one. Teardown sends
  `DISMISS_ALARM` by label (and by time where the agent may have dropped the label). The Clock app deletes a one-time
  alarm made with `SKIP_UI` and switches off one made by hand, so an agent's alarm stays in the list switched off. It
  can't ring or become a later run's next alarm, but the list grows by one per such run.
- Chrome's tabs, history and downloads list are private, and `pm clear` would bring back the first-run screens. Setup
  starts every Chrome task on example.com in one reused tab (the `com.android.browser.application_id` extra), so an
  earlier run's page is never what shows. Tabs the agent opened stay.
- Files deleted by teardown can leave a MediaStore row or a Chrome downloads-list entry pointing at nothing. Neither is
  read by any check.
- A run whose teardown never ran (a crash) leaves its saved `.orig` file, and the setting stays as the run left it.
  The next run has another nonce, so it saves the changed value as "original". Reset the phone's settings by hand after a
  crashed run.
