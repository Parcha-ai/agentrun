# MobileWorld port

## Source

- Repository: https://github.com/Tongyi-MAI/MobileWorld
- Revision: `a026188705f4a494a12d14ddab3786a23fd2c537` (2026-11-03). Each task's `source.revision` names it.
- Built for an Android emulator (AVD) in Docker. The emulator is rooted, and each task starts from an AVD snapshot.
  Some tasks also run self-hosted Mastodon, Mattermost and a mock shop (Taodian), use a custom mail app, or use MCP
  tools and a simulated user.

## Licence

The licence is Apache-2.0 (the `LICENSE` file at that revision; there is no NOTICE file). The MIT section at the end
of that file covers MiniWoB HTML assets, and we use none of them. Apache-2.0 allows copying, changing and
redistributing in an Apache-2.0 repo, on these conditions: keep the licence, and mark what was changed.

So we copy text where it helps faithfulness:

- English goals, word for word.
- The task files' text (the bid files, the invoice line items, the invoice).

Each task's `source` block gives the suite, file and class, revision and licence. `source.changes` is the change
notice Apache-2.0 §4(b) asks for.

## Field mapping

| MobileWorld (`src/mobile_world/tasks/definitions/<area>/<file>.py`, a `BaseTask` subclass) | computer-bench (`task.json`) |
| --- | --- |
| file and class (`native/bid_file_rename.py:BidFileRenameTask`) | `source.id`; the folder and `id` are the file name in kebab case (`mobileworld.bid-file-rename`) |
| `goal` | `instruction`: word for word when English, our translation when Chinese (`lang-cn`; `tags` gets `translated`) |
| `app_names` (display names) | `needs.apps`: package names, with the stock-Android and the common vendor package for each app |
| `task_tags` (`lang-en`, `lang-cn`, ...) | `tags` |
| `snapshot_tag` (AVD snapshot) and `start_on_home_screen` | `setup` builds the state over `exec.run` (adb's shell user), starting from the phone as it is |
| `initialize_task_hook` | `setup` steps, which first save or move aside whatever they replace |
| `is_successful` (score 0 to 1, with a reason) | `checks`: `exec` checks on files and settings, or an `answer` check on the final answer |
| `tear_down` (or a snapshot reload) | `teardown`, which puts back what setup saved |
| `controller.interaction_cache` (the answer) | `answer` check on the agent's final answer |
| none | `params` (the source's values are one pick), `oracle`, `rubric.md` |

## Selection rule

The phone is a stock, unrooted vendor phone. The bench runs `exec.run` as adb's shell user, so there is:

- no root;
- no app-private data;
- no emulator snapshots;
- no self-hosted backends unless a task carries them.

A task is ported when all of these hold:

1. **GUI task only.** It's a plain task: no MCP tools and no simulated-user turns. The bench has neither channel
   yet.
2. **Start state from the folder.** The start state can be built with shell-user rights (files under /sdcard,
   `settings`, `cmd`, `am`) from nothing but the task folder, and undone by teardown.
3. **Check from outside.** Its check can read the result with shell-user rights: files under /sdcard, `settings get`,
   `dumpsys`, or the final answer. Nothing inside an app's private database.
4. **Stock apps only.** It needs no backend server and no app the phone doesn't have. MobileWorld's own mail app
   doesn't count as stock.
5. **No live web.** It doesn't depend on live web or map data.
6. **Fits in the folder.** The files it needs are small enough to carry in the folder and pass to the phone through
   `exec.run`.
7. **Same on any phone.** Its target doesn't depend on the emulator's own screen and font values.

Counts at the pinned revision: **201** tasks.

| Rule failed | Count | Tasks |
| --- | --- | --- |
| 1: MCP tools and/or a simulated user | 84 | 38 MCP-only, 44 user-turn-only, 2 both |
| 4: self-hosted backend (Mastodon, Mattermost, Taodian shop) | 61 | |
| 4: MobileWorld's own mail app (com.gmailclone) | 22 | |
| 3: needs root | 12 | calendar ×6 (the Fossify Calendar database, and SMS reads); gmail/check_conference_location, map/text_arrival_time, messages/send_interview_invitation, native/check_invoice_3 (all read SMS); native/set_alarm (the weekend days, ringtone and vibrate are only in Clock's own database); work/photo_management (Calendar's database) |
| 5: live web or maps | 3 | chrome/check_weather, map/check_neighbours, map/check_phone_numbers |
| 2: start state only in the AVD snapshot | 2 | native/count_file_lines, native/sum_file_lines (their text files are in the snapshot, not the repo) |
| 1: asks the user | 1 | native/invoice_receipt_copy_ask_user_task (the GUI-tagged twin of invoice_receipt_copy; it needs a user reply) |
| 6: large third-party PDFs | 5 | native/read_paper_1 to 5 (arXiv papers of 780 KB to 4 MB, under their own licences) |
| 7: emulator-specific targets | 2 | settings/adjust_font_icon_max and _min (font scale 2.0 with density 540, and 0.85 with 356: the emulator's own values) |
| 3: needs root | 1 | settings/change_wallpaper (the check reads the wallpaper file under /data/system) |
| **Ported** | **8** | |

That's 117 GUI tasks (201 minus the 84 under rule 1), of which 8 pass. Fewer than 10 can be ported faithfully to an
unrooted phone, so this suite has **8 tasks, 4 dev and 4 heldout**. We didn't bend more tasks into shape. Each
excluded task fails for the reason in the table, and each of those reasons changes what the task measures.

The buckets were derived by reading the task files as Python syntax trees, never importing or running them. Nothing
from the clone was run.

## What a port changes

These apply to every task. Each task's `source.changes` lists its own changes.

- **Start state:**
  - We have no snapshots and don't wipe folders. The source emptied Download; setup here moves the phone's own
    files aside into `/sdcard/.computer-bench-<nonce>`, on the same storage, so a rename keeps dates. Teardown
    moves them back.
  - Settings are saved to `/data/local/tmp/computer-bench-<nonce>.orig` and restored.
  - A retried setup keeps the first saved copy.
- **Dates:** the source dated files relative to the day of the run. We use fixed dates. Setup asks the media scanner
  to re-read each file so file managers show those dates.
- **Random draws:** the source drew some content at random. Ours is either a fixed draw or a param with the source's
  case as one pick.
- **Checks:**
  - They read the same state as the source's `is_successful`, and are sometimes stricter where the source was loose.
    invoice-receipt-copy now requires a copy, not a move; bid-file-rename adds a check that the other files are
    kept.
  - Every state-checked task has an oracle. setup alone fails its checks, and setup plus oracle passes them. This
    was checked against a fake phone (Linux shell, faked `settings`, `cmd`, `am`, `input`, `screencap`). On that
    fake, teardown also left the user's files exactly as they were.
- **Translation:** Chinese goals are translated, and the translation is marked.

## Reporting

A number from this suite is not a MobileWorld score. Report it as **"MobileWorld-port, N of 201 tasks (117 GUI),
our checks"**. N is the number of tasks run (8 today), and you should say which split. Three things differ from the
source:

- The tasks run on a real unrooted phone rather than their emulator.
- They're a small GUI-only subset that leaves out every backend, mail, MCP and user-interaction task.
- The checks are ours.

## Ported (8)

| Split | Folder | Source | What it asks |
| --- | --- | --- | --- |
| dev | bid-file-rename | native/bid_file_rename.py:BidFileRenameTask | Rename four bid_ files in Download to bid_1 to bid_4 by date (params: which file is oldest) |
| dev | take-selfie | native/take_selfie.py:TakeSelfieTask | Take a photo |
| dev | adjust-brightness-max | settings/adjust_brigtness_max.py:AdjustBrightnessMaximumTask | Brightness to maximum |
| dev | open-flight-mode | settings/open_flight_mode.py:OpenFlightModeTask | Turn flight mode on |
| heldout | invoice-receipt-copy | native/invoice_receipt_copy_task.py:InvoiceReceiptCopyTask | Copy November's invoice and receipt PDFs from Download into Finance/invoice |
| heldout | check-invoice-1 | native/check_invoice_1.py:CheckInvoiceTask1 | Read an invoice PDF and answer the amount due with late interest |
| heldout | adjust-brightness-min | settings/adjust_brigtness_min.py:AdjustBrightnessMinimumTask | Brightness to minimum |
| heldout | close-flight-mode | settings/close_flight_mode.py:CloseFlightModeTask | Turn flight mode off |

The split pairs twins across it (brightness max and min, flight mode on and off). It also puts one file task in each
split, and the two invoice tasks in heldout.

### What the runner needs

- The phone's adb over USB, not Wi-Fi. Turning flight mode on drops Wi-Fi, and with it a wireless adb session.
- `cmd connectivity airplane-mode` (Android 11 and later) for the flight-mode setups and teardowns.
- A file manager for the file tasks (Files by Google, DocumentsUI, or Samsung My Files). A PDF viewer for
  check-invoice-1 (the Files app's own viewer, or Drive).

### Unsure

- **check-invoice-1:**
  - It has no oracle: it's answer-only, like android-dev/settings-battery-level.
  - Its invoice is our re-typeset text PDF, not the source's 82 KB LaTeX PDF.
  - The source's printed subtotal (85,100) isn't the sum of its line items (84,100). The check takes both 104,417.70
    (the source's key) and 103,190.70.
- **adjust-brightness-max and adjust-brightness-min:** the check reads `settings get system screen_brightness`.
  Phones whose slider writes a wider scale (some Samsung and Xiaomi builds) are covered for max, which takes any
  value of 255 or more. Min wants 0 or 1. A vendor whose lowest slider position stores a higher value would fail an
  agent that did the task.
- **open-flight-mode and close-flight-mode:** these need USB adb (see above).
- **take-selfie:** the oracle is a screen capture saved into DCIM/Camera. It shows the check reads a new camera-folder
  image, not that a camera app works.
- **bid-file-rename:** the agent sees the dates only through the file manager. Most of them list Download through
  MediaStore, so a stale index would show the wrong dates; setup asks for a rescan of each file to prevent that.

## Order for the rest

1. **User-interaction tasks (44, plus the ask-user twin):** once the bench has a simulated-user channel. The
   ask-user twin of invoice-receipt-copy goes first; it reuses this folder's setup.
2. **MCP tasks (38, plus 2 with both MCP and user turns):** once the bench can hand tools to an agent.
3. **Mail tasks (22):** if com.gmailclone can be sideloaded and seeded from the shell. Otherwise only with the app
   built into the image.
4. **Backend tasks (61):** only if a task can carry its backend (a container per run) and the phone can reach it.
5. **Root tasks (13):** only on a rooted lane.
6. **Never:**
   - live web or maps (3);
   - snapshot-only start states (2), unless their files are published;
   - the read_paper tasks, unless the PDFs' licences allow carrying them;
   - the font and icon tasks, unless they're rewritten to the phone's own maximum and minimum, which would be a
     different task.
