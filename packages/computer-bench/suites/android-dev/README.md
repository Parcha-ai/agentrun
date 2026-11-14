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
  lists the Google, AOSP and Samsung packages of each app as one entry of alternatives, any one of which will do.
  Settings is `com.android.settings` alone. A phone missing an app is skipped (`skipped: needs com.android.chrome`),
  not scored.
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

## Round 2 tasks

Eighteen more tasks, nine dev and nine heldout, written to be harder than round 1 (where both arms passed 88-92%). Every
one sets `exec: "deny"`, so the agent has only `ui`, `input`, `screen` and `apps`, and its oracle is built from the same
methods: each oracle is a UI path a person could take, proven on a cloud phone. Each task starts from the opposite of its
goal, its params give the three seeds three different targets, and everything it makes carries `{{nonce}}`. Three are
answer tasks; their `unchanged` exec check fails the run if the agent edits what it was asked to read. Four are long (15+
steps). `needs.apps` lists the packages each task opens; a nested list is alternatives (Google or AOSP build).

| id | app | split | steps expected | what the checks read |
|---|---|---|---|---|
| android.settings.time-format | Settings | dev | 6 | `settings get system time_12_24` |
| android.settings.color-motion | Settings | dev | 12 | color inversion, `animator_duration_scale` and `cmd uimode night`, one read |
| android.settings.three-changes | Settings | dev | 18 (long) | notification history, `time_12_24` and `animator_duration_scale`, one read |
| android.clock.timer | Clock | dev | 8 | `dumpsys alarm`: the TIMER_EXPIRED alarm's original length |
| android.clock.new-alarm | Clock | dev | 16 (long) | `dumpsys alarm` next alarm clock, as weekday and time |
| android.contacts.favorite | Contacts | dev | 3 | `content query` of the nonce's contacts: target starred, decoy not |
| android.contacts.work-phone | Contacts | dev | 3 | answer: the work number, not the mobile, home or the decoy's work number; phone rows unchanged |
| android.files.delete-pdfs | Files | dev | 8 | `ls -1` of the run's folder: the PDFs gone, the text file and the folder kept |
| android.cross.alarm-label-folder | Clock, Files | dev | 15 (long) | `ls -1` of the run's folder: one folder, named after the asked alarm's label (not the decoy alarm's) |
| android.settings.text-size-bold | Settings | heldout | 8 | `font_scale` and `font_weight_adjustment`, one read |
| android.settings.auto-rotate | Settings | heldout | 6 | `settings get system accelerometer_rotation` |
| android.clock.alarm-repeat-days | Clock | heldout | 10 | `dumpsys alarm` next alarm clock, as weekday and time |
| android.contacts.delete-contact | Contacts | heldout | 5 | `content query` of the nonce's contacts: only the kept one left |
| android.contacts.work-email | Contacts | heldout | 10 | the target's email row (address and type Work/Home/Other), and no email on the decoy |
| android.contacts.count-favorites | Contacts | heldout | 4 | answer: the count and the favourites' names; starred count and contact count unchanged |
| android.files.new-folder | Files | heldout | 7 | `ls -1` of the parent, the sibling folder and the run's folder; the new entry is a folder |
| android.files.largest-file | Files | heldout | 4 | answer: the largest file's name before any other; the folder unchanged |
| android.cross.device-name-contact | Settings, Contacts | heldout | 15 (long) | `content query`: one contact named the device name setup put in, with the asked number |

The Clock alarm tasks read the next alarm clock, so they rest on the same rule as set-alarm: setup leaves no other enabled
alarm ringing sooner (the phone's own 8:30 and 9:00 alarms are off on a fresh phone, and the task's alarm is set before
them). Settings tasks save and put back the phone's values as round 1's do; Contacts and Files tasks clean up by nonce;
Clock tasks dismiss their alarms by label.

## How wide the confidence interval is

`compare` reports the difference between two arms' success rates with `pairedDifference` (src/stats.ts): runs are
clustered by task, and the interval is the wider of a paired t-interval over the per-task differences and a Newcombe
interval built from the two arms' Wilson intervals at T tasks.

To see what a bench of this size can tell apart, the round 1 bench (24 tasks, seeds 1 and 2, gpt-6.1-terra against
sonnet-5.5) gives the per-task agreement: 42 of 48 paired (task, seed) cells agree (0.875), 5 tasks have any
disagreement, and success is 0.917 against 0.875. Round 1's own interval is 0.042 [-0.152, 0.236]. A simulation draws N
tasks with replacement from round 1's, and for each task 3 seeds with replacement from its paired cells, then runs
`pairedDifference` on them, 20,000 times per N:

| tasks N | runs (3 seeds x 2 arms) | 95% half-width, mean | paired-t part alone | benches with half-width under 5 points |
|---|---|---|---|---|
| 20 | 120 | 0.212 | 0.137 | 0% |
| 24 | 144 | 0.191 | 0.125 | 0% |
| 30 | 180 | 0.169 | 0.112 | 0% |
| 38 (this suite) | 228 | 0.148 | 0.099 | 0% |
| 50 | 300 | 0.127 | 0.086 | 0% |
| 80 | 480 | 0.098 | 0.068 | 0% |
| 120 | 720 | 0.079 | 0.055 | 0% |
| 200 | 1200 | 0.061 | 0.043 | 0.4% |
| 300 | 1800 | 0.049 | 0.035 | 59% |
| 400 | 2400 | 0.043 | 0.030 | 100% |

With 38 tasks the interval is about ±15 points, so a 5-point difference between two models is not visible: the interval
around it would run from about -10 to +20. Even the paired-t part alone is ±10 points. The Newcombe part sets the width,
and it counts tasks, not runs, so more seeds don't narrow it; only more tasks do. A 5-point difference becomes visible at
about 300 tasks at round 1's agreement. Below that, this suite tells apart differences of 15 points or more.
