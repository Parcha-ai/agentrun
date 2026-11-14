# macOSWorld port

## Source

- Repository: https://github.com/showlab/macosworld
- Revision: `e2ca8334b3765537e5c1c428ce57990248a1bb5f` (2026-01-28). Each task's `source.revision` names it.
- Built for macOS 15 (Sequoia) on AWS EC2 Mac instances. Each task starts from an AMI snapshot that holds the start
  state, and its checks are shell commands run over SSH.

## Licence

The licence is CC BY-NC 4.0 (the `LICENSE` file at that revision). It allows sharing and adapting the material, with
attribution, for non-commercial purposes only. This repo is Apache-2.0, which allows commercial use. So we can't bring
their text in under our licence: task wording, check commands, scripts and the files in `assets/` all stay out.

Every task here is **ported by reference**. A task carries the source's id and revision (`source.id` is the full
uuid). Everything in its folder is our own: the instruction in our words, plus our own setup, checks, teardown, oracle,
params and rubric. What we reuse are facts about macOS: which app, which setting, which preference key a state lives
in. `source.licence` says this on every task. If a later reading of the licence allows more, nothing here needs to
change.

## Field mapping

| macOSWorld (`tasks/<category>/<uuid>.json`) | computer-bench (`task.json`) |
| --- | --- |
| `id` (uuid) | `source.id`; the folder and `id` use its first 8 hex digits (`macosworld.<8 hex>`) |
| category folder (`sys_apps`, `productivity`, ...) | `tags` (in words, not the folder name) |
| `task.en` (also zh, ar, ja, ru) | `instruction`, rewritten in our words, English only |
| `snapshot` (an AMI per language) | `setup` builds the state from a clean logged-in Mac; `teardown` undoes it |
| `pre_command` (shell, sometimes per language) | `setup` steps, written fresh |
| `force_snapshot_recovery`, `force_ec2`, `force_error_free_prep` | none: we never restore snapshots, so a task cleans up after itself |
| `before_action_delay_seconds` | `sleep` inside the setup step that needs it |
| `before_grading_delay_seconds` | none: checks run when the agent says it's done |
| `grading_command` (`[[cmd, score]]`; 100 is full marks) | `checks`: only the full-marks command's intent, as `exec` (stdout matched) or `app` checks; partial-credit lines are dropped |
| `in_process` (safety tasks only) | not ported (see below) |
| none | `params` (the source's value is always one pick), `oracle`, `rubric.md`, `needs.apps` |

## Selection rule

A task is ported when all of these hold:

1. It's one of the 202 non-safety tasks. The 29 `safety` tasks measure whether an agent falls for an on-screen
   distraction (their `in_process` pop-ups); that's a separate construct and is out of scope here.
2. Its start state can be built on a logged-in macOS 26 Mac by `exec.run` as that user, from nothing but the task
   folder, and teardown can undo it.
3. Its apps ship with macOS. Pages, Numbers, Keynote, iMovie and Xcode are not in our image.
4. It needs no live website or online account.
5. The source's full-marks check matches what the instruction asks, so that our check can carry the same intent.
6. It doesn't log in, need admin, or make system-wide changes that teardown can't undo, and it doesn't destroy the
   user's data.
7. The feature it uses still exists in macOS 26.

Counts at the pinned revision: 231 task files. 29 are safety tasks and are excluded under rule 1. That leaves
**202**, of which **74 pass**.

| Rule failed | Count | Notes |
| --- | --- | --- |
| R1: start state exists only in their AMI | 66 | 28 of 29 file_management tasks, plus 21 advanced, 7 media, 5 multi_apps, 4 sys_and_interface and 1 sys_apps. They work on files and app states that are in the snapshot but not in the repo; the source's `Benchmark_Backup` isn't published. |
| R2: App Store apps (iWork, iMovie, Xcode) | 31 | 19 productivity, 10 multi_apps, 2 advanced |
| R3: live web or online services | 16 | 10 multi_apps, 6 sys_apps (Stocks, Weather, Maps, websites, App Store) |
| R4: the source check is broken or contradicts the instruction | 9 | see below |
| R5: login, admin, or a system-wide change teardown can't undo | 3 | 1df5d9f4 (logs in as ec2-user), efddc032 (Guest account), f576f917 (renames the startup volume) |
| R6: destroys the user's data | 1 | 7cf47313 (permanently delete every note) |
| R7: the feature is gone in macOS 26 | 2 | bdbe892c (Launchpad, removed in 26), 858e1ef5 (moving the Spotlight window; Spotlight was rebuilt in 26) |

The 74 that pass, by category: sys_apps 29, sys_and_interface 19, productivity 11, media 5, advanced 6, multi_apps 4.

The R4 tasks:

- 05eb3ac3, 0a1b981d: the check runs `sed -E 's/<(td|tr)[^>]*>/<>/g'`, which rewrites `<tr>` as well as `<td>`. The
  grep that follows can then never match, so no answer passes.
- 160a4bec: the instruction says "block all distractions", but the check only looks at whether the Focus menu-bar
  item is visible.
- 26a55524, 41b86cc9, 4fe1e644: they pass on a byte length of the whole `com.apple.notificationcenterui` plist
  (`length = 672,`), which any other widget or change also moves.
- 6e04a326: the instruction names the note "Road Trip Checklists", but the check looks for a heading "Travel
  Essentials" and "Personal Items" with a capital I.
- 81d8bcbb: the markdown it gives says "Apply Warp Stablizer VFX", but every check line wants "Apply Wrap
  Stabilizer VFX". An agent that types the given text exactly fails.
- 77be0051: the instruction says to name the Quick Action "Hello", but the check runs `Untitled.workflow`.

The counts were derived from the clone's task JSON, read as data with the rules above written as id lists; none of the
clone's code was run.

## What a port changes

These apply to every task. Each task's `source.changes` lists its own changes.

- **Instruction:** our own words, with the same goal. Where the source fixed a value (a number, a list, a text) that
  can safely vary, it's a param, and the source's value is one of the picks.
- **Start state:** no snapshots. Setup saves whatever it changes (to `/tmp/computer-bench-<nonce>`, keeping the first
  copy on a retried setup), and teardown puts it back. Anything setup creates is marked with the run's nonce or
  counted from a start time, and teardown removes only that.
- **Checks:** we check the source's full-marks intent, read from the same place where macOS 26 still keeps it (a
  `defaults` key, an AppleScript property, a file). The match is exact where the source used a loose `grep`.
  Partial credit is dropped.
- **Oracle:** every state-checked task has one. The suite was validated by checking that setup alone fails the
  checks and setup plus oracle passes them.
- **Platform:** macOS 26, not 15. Each preference key and AppleScript property comes from the source's macOS 15
  checks; their names and values still have to be confirmed on a 26 machine (see "Unsure").

## Reporting

A number from this suite is not a macOSWorld score. Report it as **"macOSWorld-port, N of 202 tasks, our checks"**.
N is the number of tasks run (10 today). Say which split you ran, and don't put the result next to published
macOSWorld scores without that qualifier. The tasks run on macOS 26 rather than 15, use our checks (no partial
credit), have different instructions (our words, English only) and use params.

## Ported (10)

| Split | Folder | Source category | What it asks |
| --- | --- | --- | --- |
| dev | 12fea1c8 | sys_apps | A catch-up word problem in Calculator (params: speeds and gap) |
| dev | 17fed363 | sys_and_interface | Notification previews set to Never |
| dev | 000d01d7 | productivity | Label the two paragraphs of a note in Notes (params: the article) |
| dev | daa28096 | media | Music's own volume set to a level (params: 30, 50, 70) |
| dev | 86b5d27f | advanced | A one-line AppleScript in Script Editor that returns the front app's name |
| heldout | 48a16605 | multi_apps | TODO.txt on the Desktop into Reminders (params: the items) |
| heldout | 152a753b | sys_apps | A trigonometric value in radians in Calculator (params: the function) |
| heldout | 1d90419a | sys_and_interface | Open System Report |
| heldout | 0bc05a1d | productivity | A new note holding an empty table |
| heldout | 95266846 | advanced | Save a given AppleScript as Documents/sum.scpt (params: the upper bound) |

dev covers sys_apps, sys_and_interface, productivity, media and advanced. heldout covers the same, but takes
multi_apps in place of media: media's only other passing tasks are wave 2 (their source checks read the UI).

### What the runner needs

- Automation (Apple Events) permission for whatever runs `osascript` to control Notes, Reminders, Script Editor,
  Music and System Events. Without it, setup and checks fail with error -1743, and the task reports a setup error, not
  a fail.
- No Accessibility grant: no ported check reads UI elements.

### Unsure

- 12fea1c8 and 152a753b: the check reads `com.apple.calculator LastResultValue`, which is where macOS 15 keeps the
  last result. Calculator was rebuilt in macOS 26; confirm the key on a 26 machine.
- 17fed363: `com.apple.ncprefs content_visibility` (1 means Never) comes from macOS 15. Confirm it on 26.
- 0bc05a1d: the check counts tables through JXA (the note body's HTML). The oracle inserts the table as HTML. Notes
  on 26 may keep a table differently.
- 86b5d27f: the check runs the agent's script with `osascript`, which needs the Automation grant above for System
  Events.

## Order for the rest

1. **Wave 1.** These are state-checked like the ten above: a preference, a file, or an AppleScript property. The
   order is round-robin over sys_apps, sys_and_interface, productivity, media, advanced, multi_apps. The ten ported
   are the first ten.
   - Done: 12fea1c8 17fed363 000d01d7 daa28096 86b5d27f 48a16605 152a753b 1d90419a 0bc05a1d 95266846.
   - Next: 90745559 1ef109cd 23c1acf7 12c3de99 f0147143 259bcb80 2624f017 2d8282ba 2f72dba5 2c70d1c2 60428663 48cf0af3
     4fe32b2b 6a40e62d 4a89fe83 694e8aa5 a1b99040 595554cf 94cab5ba ae422233 64824755 957ae859 c1651287 6a3522ba
     a3373cf7 d4826b7e 878dd2c5 a44cfca3 e4b774ef 89f88c8c ac8d6f81 96786064 bce6df41 9f0d7200 c8973c96 a204124e
     c92420a8 b071a2dc ce71ae98 b431b94b eac769c0 bab3960d d516fdbf dbfb0512 e8bc0bd1 ea12a7de.
2. **Wave 2.** 18 tasks: 17 that pass the rules but whose source check reads the UI (AX titles, window contents),
   plus 6f31a7d9. A check like that is only as good as the UI's labels on 26. Their checks are reworked to read state
   where macOS keeps one, or else ported with an Accessibility grant.
   - Order: 07709761 0e224b29 1329d65e 1e31f3ee cb187818 eef70218 ff9779d1 670cda14 f7ea0080 09a146c8 21bf043d
     79520236 9e3fc2a6 5a219d2f 75ae61f4 8887a199 6f31a7d9 4fb31f99.
   - 6f31a7d9 is state-checked, but it sits in wave 2 because its oracle needs a hand-built Automator workflow.
3. **R4.** Each needs a check rewritten to the instruction's intent and a note that it differs from the source.
   05eb3ac3 and 0a1b981d go first (their intent is clear); 160a4bec last (what "block all distractions" means is a
   judgment call).
4. **R2.** Once the image carries Pages, Numbers, Keynote, iMovie and Xcode.
5. **R1.** Only if showlab publishes the snapshot's files (`Benchmark_Backup`) under terms we can use. Making up
   stand-in files would be a different task.
6. **Never:** R3 (live web), R5, R6, R7, and the safety tasks (a different construct).
